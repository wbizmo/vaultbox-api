"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const prisma = require("../src/lib/prisma");
const buildApp = require("../src/app");
const { LocalStorageAdapter } = require("../src/lib/storage");
const {
  tempLimits, reserveTemporary, releaseTemporary, tempStats
} = require("../src/lib/temporary-storage");
const { reconcileStorage } = require("../src/lib/storage-reconciliation");

const config = {
  nodeEnv: "test", isProduction: false, corsOrigins: [],
  jwtSecret: "temporary-storage-regression-test-key-long-enough",
  jwtExpiresIn: "1h", maxUploadBytes: 4096, uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60, uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4, downloadTokenExpiresMinutes: 15,
  downloadSuggestedPartBytes: 1024, downloadMaxRanges: 4
};
function multipart(bytes) {
  const boundary = "----vaultbox-" + crypto.randomUUID();
  return {
    payload: Buffer.concat([
      Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"temp.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
      bytes, Buffer.from("\r\n--"+boundary+"--\r\n")
    ]),
    contentType: "multipart/form-data; boundary=" + boundary
  };
}
async function fixture(t, storageType = LocalStorageAdapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-temp-test-"));
  const storage = new storageType(root);
  await storage.ready();
  const tag = crypto.randomUUID();
  const plan = await prisma.plan.create({
    data: { name: "temp-plan-"+tag, priceMonthly:0, storageLimit:100000n }
  });
  const users = await Promise.all([0,1].map((n) => prisma.user.create({
    data: { name:"Temporary tester", email:"temp-"+n+"-"+tag+"@example.invalid",
      password:"unused", planId: plan.id }
  })));
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    const userIds = users.map(x => x.id);
    await prisma.downloadToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.uploadSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.uploadReservation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.temporaryObject.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.fileDeletion.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.file.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.folder.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root,{ recursive:true, force:true });
  });
  const auth = users.map(u => ({ authorization: "Bearer "+app.jwt.sign({ id: u.id }) }));
  return { storage, root, users, app, auth };
}

test("global and user temporary budgets serialize concurrent admissions across accounts", async t => {
  const tag=crypto.randomUUID();
  const baseline=await tempStats();
  const limits={
    globalBytes:BigInt(baseline.reservedBytes)+100n,
    userBytes:90n,
    globalClaims:baseline.objects+2,
    userClaims:1
  };
  const keys=[tag+"a",tag+"b"];
  const attempts=await Promise.allSettled(keys.map((key,i) => reserveTemporary({
    userId:"cross-user-"+i+"-"+tag,objectKey:"file:"+key,kind:"FILE",bytes:60n,limits
  })));
  assert.deepEqual(attempts.map(x=>x.status).sort(),["fulfilled","rejected"]);
  assert.equal(attempts.find(x=>x.status==="rejected").reason.code,"TEMP_STORAGE_BUDGET_EXCEEDED");
  const winner=attempts.find(x=>x.status==="fulfilled").value;
  t.after(async()=>prisma.temporaryObject.deleteMany({where:{objectKey:{in:keys.map(x=>"file:"+x)}}}));
  const row=await prisma.temporaryObject.findUnique({where:{objectKey:winner.objectKey}});
  assert.equal(row.bytes,60n);
  await releaseTemporary(winner.objectKey,winner.token);
  assert.equal((await prisma.temporaryObject.count({where:{objectKey:{in:keys.map(x=>"file:"+x)}}})),0);
  assert.throws(()=>tempLimits({VAULTBOX_TEMP_USER_BYTES:"100",VAULTBOX_TEMP_GLOBAL_BYTES:"10"}));
  assert.throws(()=>tempLimits({VAULTBOX_TEMP_GLOBAL_BYTES:"0"}));
});

test("stale claimed orphan is cleaned but active claims and unknown legacy files are preserved", async t => {
  const f=await fixture(t);
  const old=new Date(Date.now()-3*3600*1000);
  const staleKey=crypto.randomUUID(), liveKey=crypto.randomUUID(), legacyKey=crypto.randomUUID();
  const stale=await reserveTemporary({
    userId:f.users[0].id,objectKey:"file:"+staleKey,kind:"FILE",bytes:40n
  });
  const live=await reserveTemporary({
    userId:f.users[0].id,objectKey:"file:"+liveKey,kind:"FILE",bytes:30n
  });
  for(const key of [staleKey,liveKey,legacyKey]){
    await fs.writeFile(f.storage.resolve(key),"orphan bytes");
    await fs.utimes(f.storage.resolve(key),old,old);
  }
  await prisma.temporaryObject.update({where:{objectKey:stale.objectKey},
    data:{leaseUntil:old,updatedAt:old}});
  const before=await tempStats();
  const report=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:50});
  assert.ok(report.reaped>=1,JSON.stringify(report));
  assert.equal((await f.storage.exists(staleKey)),false);
  assert.equal((await f.storage.exists(liveKey)),true);
  assert.equal((await f.storage.exists(legacyKey)),true,"legacy unclaimed object must not be blindly removed");
  assert.equal((await prisma.temporaryObject.count({where:{objectKey:stale.objectKey}})),0);
  assert.equal((await prisma.temporaryObject.count({where:{objectKey:live.objectKey}})),1);
  assert.ok(report.unclaimedLegacyObjects>=1);
  assert.equal(BigInt((await tempStats()).reservedBytes),BigInt(before.reservedBytes)-40n);
  await releaseTemporary(live.objectKey,live.token);
  const restartKey=crypto.randomUUID();
  const restart=await reserveTemporary({
    userId:f.users[0].id,objectKey:"file:"+restartKey,kind:"FILE",bytes:10n
  });
  await fs.writeFile(f.storage.resolve(restartKey),"dead reaper");
  await fs.utimes(f.storage.resolve(restartKey),old,old);
  // SIGKILL after a cleaner marked REAPING: its expired token must be reclaimable.
  await prisma.temporaryObject.update({
    where:{id:restart.id},
    data:{state:"REAPING",leaseUntil:old,updatedAt:old}
  });
  const recovered=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:50});
  assert.ok(recovered.reaped>=1);
  assert.equal(await f.storage.exists(restartKey),false);
});

test("missing durable bytes produce discrepancy metrics, not destructive DB/quota mutations",async t=>{
  const f=await fixture(t);
  const storedName=crypto.randomUUID();
  const file=await prisma.file.create({data:{
    userId:f.users[0].id,storedName,originalName:"missing.bin",
    mimeType:"application/octet-stream",path:storedName,size:10n
  }});
  await prisma.user.update({where:{id:f.users[0].id},data:{storageUsed:10n}});
  const report=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:100});
  assert.ok(report.missingCommittedObjects>=1);
  assert.equal(await prisma.file.count({where:{id:file.id}}),1);
  assert.equal((await prisma.user.findUnique({where:{id:f.users[0].id}})).storageUsed,10n);
});

class DiskFullStorage extends LocalStorageAdapter {
  createWriteStream() {
    return new Writable({
      write(chunk,enc,callback) {
        const e=new Error("disk full");e.code="ENOSPC";callback(e);
      }
    });
  }
  createUploadPartWriteStream() {
    return new Writable({
      write(chunk,enc,callback) {
        const e=new Error("disk full");e.code="ENOSPC";callback(e);
      }
    });
  }
}
test("ENOSPC one-shot and part uploads return 507 and do not leak committed quota",async t=>{
  const f=await fixture(t,DiskFullStorage);
  const body=multipart(Buffer.from("abcd"));
  const result=await f.app.inject({
    method:"POST",url:"/files/upload",
    headers:{...f.auth[0],"content-type":body.contentType,"x-upload-size":"4"},
    payload:body.payload
  });
  assert.equal(result.statusCode,507,result.body);
  assert.equal(await prisma.temporaryObject.count({where:{userId:f.users[0].id}}),0);
  const session=await f.app.inject({
    method:"POST",url:"/upload-sessions",headers:f.auth[0],
    payload:{originalName:"resume.bin",mimeType:"application/octet-stream",expectedSize:4}
  });
  assert.equal(session.statusCode,201,session.body);
  const part=await f.app.inject({
    method:"PUT",url:"/upload-sessions/"+session.json().session.id+"/parts/0",
    headers:{...f.auth[0],"content-type":body.contentType,"content-range":"bytes 0-3/4"},
    payload:body.payload
  });
  assert.equal(part.statusCode,507,part.body);
  assert.equal((await prisma.user.findUnique({where:{id:f.users[0].id}})).storageUsed,0n);
  const aborted=await f.app.inject({
    method:"DELETE",url:"/upload-sessions/"+session.json().session.id,headers:f.auth[0]
  });
  assert.equal(aborted.statusCode,200,aborted.body);
});

class AssemblyDiskFullStorage extends LocalStorageAdapter {
  constructor(root) { super(root); this.failAssembly = true; }
  async assembleUploadParts(sessionId, parts, key, options) {
    if (this.failAssembly) {
      await fs.writeFile(this.resolve(key), "partial");
      const error = new Error("Simulated ENOSPC halfway through assembly");
      error.code = "ENOSPC";
      throw error;
    }
    return super.assembleUploadParts(sessionId, parts, key, options);
  }
}
test("mid-assembly ENOSPC preserves resumable state and retries with exact one-time quota",async t=>{
  const f=await fixture(t,AssemblyDiskFullStorage);
  const session=await f.app.inject({
    method:"POST",url:"/upload-sessions",headers:f.auth[0],
    payload:{originalName:"recovery.bin",mimeType:"application/octet-stream",expectedSize:4}
  });
  assert.equal(session.statusCode,201,session.body);
  const id=session.json().session.id;
  const part=multipart(Buffer.from("abcd"));
  const put=await f.app.inject({
    method:"PUT",url:"/upload-sessions/"+id+"/parts/0",
    headers:{...f.auth[0],"content-type":part.contentType,"content-range":"bytes 0-3/4"},
    payload:part.payload
  });
  assert.equal(put.statusCode,201,put.body);
  const failed=await f.app.inject({
    method:"POST",url:"/upload-sessions/"+id+"/complete",headers:f.auth[0]
  });
  assert.equal(failed.statusCode,507,failed.body);
  assert.equal((await prisma.uploadSession.findUnique({where:{id}})).status,"UPLOADING");
  assert.equal(await prisma.file.count({where:{userId:f.users[0].id}}),0);
  assert.equal((await prisma.user.findUnique({where:{id:f.users[0].id}})).reservedUploadBytes,4n);
  assert.equal((await prisma.temporaryObject.count({
    where:{userId:f.users[0].id,kind:"ASSEMBLY"}
  })),0,"failed final object must not hold an abandoned assembly claim");
  f.storage.failAssembly=false;
  const done=await f.app.inject({
    method:"POST",url:"/upload-sessions/"+id+"/complete",headers:f.auth[0]
  });
  assert.equal(done.statusCode,200,done.body);
  const dbFile=await prisma.file.findFirst({where:{userId:f.users[0].id}});
  assert.ok(dbFile);
  assert.equal((await fs.readFile(f.storage.resolve(dbFile.storedName))).toString(),"abcd");
  const state=await prisma.user.findUnique({where:{id:f.users[0].id}});
  assert.equal(state.storageUsed,4n);
  assert.equal(state.reservedUploadBytes,0n);
  assert.equal(await prisma.temporaryObject.count({where:{userId:f.users[0].id}}),0);
});

test("unknown legacy object inventory advances beyond batch-size without deleting any unowned bytes",async t=>{
  const f=await fixture(t);
  const old=new Date(Date.now()-3*3600000);
  const keys=[];
  for(let i=0;i<120;i++){
    const key=crypto.randomUUID();
    keys.push(key);
    await fs.writeFile(f.storage.resolve(key),"unknown legacy object "+i);
    await fs.utimes(f.storage.resolve(key),old,old);
  }
  let observed=0;
  for(let i=0;i<13;i++){
    const scan=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:10});
    assert.equal(scan.errors,0,JSON.stringify(scan));
    observed+=scan.unclaimedLegacyObjects;
  }
  assert.equal(observed,keys.length,
    "the scanner must advance its directory cursor rather than repeatedly inspect its first page");
  for(const key of keys)assert.equal(await f.storage.exists(key),true);
});

test("zero-byte assembly fences do not exhaust claim-count capacity reserved by sessions", async t => {
  const tag = crypto.randomUUID();
  const baseline = await tempStats();
  const limits = {
    globalBytes: BigInt(baseline.reservedBytes) + 100n,
    userBytes: 100n, globalClaims: baseline.objects + 1, userClaims: 1
  };
  const owner = "assembly-cap-" + tag;
  const sessionKey = "session:" + tag;
  const assemblyKey = "assembly:" + tag;
  t.after(() => prisma.temporaryObject.deleteMany({ where: { objectKey: { in: [sessionKey, assemblyKey] } } }));
  await reserveTemporary({ userId: owner, objectKey: sessionKey, kind: "SESSION", bytes: 60n, limits });
  const assembly = await reserveTemporary({
    userId: owner, objectKey: assemblyKey, kind: "ASSEMBLY", bytes: 0n, limits
  });
  assert.equal(typeof assembly.token, "string");
  await assert.rejects(reserveTemporary({
    userId: owner, objectKey: "file:" + tag, kind: "FILE", bytes: 1n, limits
  }), { code: "TEMP_STORAGE_BUDGET_EXCEEDED" });
  await releaseTemporary(assemblyKey);
  await releaseTemporary(sessionKey);
});

test("S3 stale claims are fenced, deleted, and verified on separate grace periods before budget release", async t => {
  const { S3StorageAdapter } = require("../src/lib/s3-storage");
  const { HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const f = await fixture(t);
  const key = crypto.randomUUID(), old = new Date(Date.now() - 4 * 3600000);
  const objects = new Map([["objects/" + key, { timestamp: old }]]);
  const fake = { send: async (cmd) => {
    const name = cmd.constructor.name, k = cmd.input.Key;
    if (name === HeadObjectCommand.name) {
      const obj = objects.get(k);
      if (!obj) {
        const e = new Error("not found"); e.name = "NotFound"; throw e;
      }
      return { ContentLength: 20, LastModified: obj.timestamp };
    }
    if (name === DeleteObjectCommand.name) { objects.delete(k); return {}; }
    throw new Error("Unexpected S3 command " + name);
  }, destroy() {} };
  const storage = new S3StorageAdapter({ client: fake, bucket: "fake", region: "us-east-1", prefix: "" });
  const claim = await reserveTemporary({
    userId: f.users[0].id, objectKey: "file:" + key, kind: "FILE", bytes: 20n
  });
  await prisma.temporaryObject.update({ where: { id: claim.id }, data: { leaseUntil: old } });
  const opts = { graceMs: 60000, batchSize: 10 };
  const first = await reconcileStorage(storage, prisma, opts);
  assert.equal(first.supported, true);
  assert.equal(first.reaped, 0);
  assert.ok(objects.has("objects/" + key));
  assert.equal((await prisma.temporaryObject.findUnique({ where: { id: claim.id } })).state, "REAPING");
  await prisma.temporaryObject.update({ where: { id: claim.id }, data: { leaseUntil: old } });
  const second = await reconcileStorage(storage, prisma, opts);
  assert.equal(second.reaped, 0);
  assert.equal(objects.has("objects/" + key), false);
  assert.equal((await prisma.temporaryObject.findUnique({ where: { id: claim.id } })).state, "VERIFYING");
  await prisma.temporaryObject.update({ where: { id: claim.id }, data: { leaseUntil: old } });
  const third = await reconcileStorage(storage, prisma, opts);
  assert.equal(third.reaped, 1);
  assert.equal(await prisma.temporaryObject.findUnique({ where: { id: claim.id } }), null);
});

test("S3 stale claimed output associated with a durable File remains intact", async t => {
  const { S3StorageAdapter } = require("../src/lib/s3-storage");
  const f = await fixture(t), old = new Date(Date.now() - 4 * 3600000);
  const key = crypto.randomUUID();
  let deletes = 0;
  const storage = new S3StorageAdapter({
    bucket:"fake", region:"us-east-1", prefix:"", client:{
      async send(cmd) {
        if (cmd.constructor.name === "HeadObjectCommand") return { ContentLength: 3, LastModified: old };
        if (cmd.constructor.name === "DeleteObjectCommand") { deletes++; return {}; }
        throw Error("Unexpected provider command");
      }, destroy() {}
    }
  });
  const claim = await reserveTemporary({
    userId:f.users[0].id,objectKey:"assembly:"+key,kind:"ASSEMBLY",bytes:0n
  });
  await prisma.file.create({data:{
    userId:f.users[0].id,storedName:key,originalName:"durable.bin",
    mimeType:"application/octet-stream",path:key,size:3n
  }});
  await prisma.temporaryObject.update({where:{id:claim.id},data:{leaseUntil:old}});
  await reconcileStorage(storage,prisma,{graceMs:60000,batchSize:20});
  assert.equal(deletes,0);
  assert.equal(await prisma.temporaryObject.findUnique({where:{id:claim.id}}),null);
});

test("S3 cleanup keeps its claim when remote deletion fails, and rechecks a late upload", async t => {
  const { S3StorageAdapter } = require("../src/lib/s3-storage");
  const f = await fixture(t);
  const key = crypto.randomUUID(), old = new Date(Date.now()-4*3600000);
  const objects = new Map([["objects/"+key,old]]);
  let failDelete=true, attempts=0;
  const storage = new S3StorageAdapter({
    bucket:"fake",region:"us-east-1",prefix:"",
    client:{async send(cmd){
      const k=cmd.input.Key;
      if(cmd.constructor.name==="HeadObjectCommand"){
        if(!objects.has(k)){const e=Error("not found");e.name="NotFound";throw e;}
        return {ContentLength:8,LastModified:objects.get(k)};
      }
      if(cmd.constructor.name==="DeleteObjectCommand"){
        attempts++;
        if(failDelete){failDelete=false;throw Error("provider unavailable");}
        objects.delete(k);return {};
      }
      throw Error("unexpected S3 command");
    }}
  });
  const claim=await reserveTemporary({
    userId:f.users[0].id,objectKey:"file:"+key,kind:"FILE",bytes:8n
  });
  const expire=()=>prisma.temporaryObject.update({where:{id:claim.id},data:{leaseUntil:old}});
  const sweep=()=>reconcileStorage(storage,prisma,{graceMs:60000,batchSize:40});
  await expire();await sweep();await expire();
  const failed=await sweep();
  assert.ok(failed.errors>=1);
  assert.equal(attempts,1);
  assert.ok(objects.has("objects/"+key));
  assert.equal((await prisma.temporaryObject.findUnique({where:{id:claim.id}})).state,"REAPING");
  await expire();await sweep();
  assert.ok(!objects.has("objects/"+key));
  assert.equal((await prisma.temporaryObject.findUnique({where:{id:claim.id}})).state,"VERIFYING");
  objects.set("objects/"+key,new Date()); // late remote completion after initial deletion
  await expire();const recent=await sweep();
  assert.equal(recent.reaped,0);
  assert.ok(await prisma.temporaryObject.findUnique({where:{id:claim.id}}));
  objects.set("objects/"+key,old);
  await expire();await sweep(); // advances back to REAPING
  assert.equal((await prisma.temporaryObject.findUnique({where:{id:claim.id}})).state,"REAPING");
  await expire();await sweep(); // deletes late object
  assert.ok(!objects.has("objects/"+key));
  await expire();const final=await sweep(); // final absence verification
  assert.equal(final.reaped,1);
  assert.equal(await prisma.temporaryObject.findUnique({where:{id:claim.id}}),null);
});
