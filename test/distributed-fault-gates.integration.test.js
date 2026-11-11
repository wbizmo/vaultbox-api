"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { cleanupUploadSessions } = require("../src/lib/upload-session");
const { reconcileStorage } = require("../src/lib/storage-reconciliation");

const SECRET = "independent-replica-fault-security-test-secret";
const script = path.join(__dirname, "..", "scripts", "app-worker.js");

function token(id) {
  const base64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const base = base64({ alg: "HS256", typ: "JWT" })+"."+
    base64({ id, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 });
  return base+"."+crypto.createHmac("sha256",SECRET).update(base).digest("base64url");
}
const auth = id => ({ authorization: "Bearer "+token(id) });
async function http(base,method,route,headers={},body) {
  const response = await fetch(base+route,{
    method, headers, ...(body===undefined?{}:{body}),
    signal:globalThis.AbortSignal.timeout(15000)
  });
  const raw = await response.arrayBuffer();
  let json;
  try { json = JSON.parse(Buffer.from(raw).toString()); }
  catch { json = null; }
  return { status:response.status,body:json,raw:Buffer.from(raw) };
}
function multipart(bytes) {
  const b="----vaultbox-"+crypto.randomUUID();
  return { type:"multipart/form-data; boundary="+b,
    bytes:Buffer.concat([
      Buffer.from("--"+b+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shared.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
      bytes,Buffer.from("\r\n--"+b+"--\r\n")]) };
}
async function worker(t,root,env={}) {
  const child = fork(script,[],{
    env:{...process.env,WORKER_STORAGE_ROOT:root,WORKER_CONNECT_REDIS:"1",
      JWT_SECRET:SECRET,...env},
    stdio:["ignore","ignore","ignore","ipc"]
  });
  t.after(()=>{ if(child.exitCode === null) child.kill("SIGKILL"); });
  const port = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Worker failed to become ready")),20000);
    timer.unref();
    child.once("exit",code=>{clearTimeout(timer);reject(new Error("Worker exited "+code));});
    child.on("message",message=>{if(message.port){clearTimeout(timer);resolve(message.port);}});
  });
  return { child, url:"http://127.0.0.1:"+port };
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vaultbox-two-process-"));
  const storage=new LocalStorageAdapter(root);await storage.ready();
  const tag=crypto.randomUUID();
  const plan=await prisma.plan.create({data:{name:"multiproc-"+tag,priceMonthly:0,storageLimit:1000000n}});
  const users=[];
  for(let i=0;i<2;i++)users.push(await prisma.user.create({data:{
    name:"Process "+i,email:"multiproc-"+i+"-"+tag+"@example.invalid",
    password:"unused",planId:plan.id
  }}));
  t.after(async()=>{
    const ids=users.map(x=>x.id),where={userId:{in:ids}};
    await prisma.downloadToken.deleteMany({where});
    await prisma.uploadPart.deleteMany({where:{session:{userId:{in:ids}}}});
    await prisma.uploadSession.deleteMany({where});
    await prisma.uploadReservation.deleteMany({where});
    await prisma.temporaryObject.deleteMany({where});
    await prisma.fileDeletion.deleteMany({where});
    await prisma.auditLog.deleteMany({where});
    await prisma.file.deleteMany({where});
    await prisma.folder.deleteMany({where});
    await prisma.user.deleteMany({where:{id:{in:ids}}});
    await prisma.plan.delete({where:{id:plan.id}});
    await fs.rm(root,{recursive:true,force:true});
  });
  return {root,storage,users};
}
async function makeSession(base,id,size) {
  const response=await http(base,"POST","/upload-sessions",{
    ...auth(id),"content-type":"application/json"
  },JSON.stringify({originalName:"shared.bin",mimeType:"application/octet-stream",expectedSize:size}));
  assert.equal(response.status,201,JSON.stringify(response.body));
  return response.body.session.id;
}
async function sendPart(base,id,session,bytes) {
  const form=multipart(bytes);
  return http(base,"PUT","/upload-sessions/"+session+"/parts/0",{
    ...auth(id),"content-type":form.type,
    "content-range":"bytes 0-"+(bytes.length-1)+"/"+bytes.length
  },form.bytes);
}
async function awaitExit(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve=>child.once("exit",resolve));
}

test("two independently running replicas race completion/abort/expire and enforce cross-tenant BOLA",async t=>{
  const f=await fixture(t);
  const [a,b]=await Promise.all([worker(t,f.root),worker(t,f.root)]);
  const owner=f.users[0].id,foreign=f.users[1].id;
  const bytes=Buffer.from("shared-data");
  const session=await makeSession(a.url,owner,bytes.length);
  const uploaded=await sendPart(b.url,owner,session,bytes);
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));

  const denied=await http(b.url,"GET","/upload-sessions/"+session,auth(foreign));
  assert.equal(denied.status,404);
  const deniedAbort=await http(b.url,"DELETE","/upload-sessions/"+session,auth(foreign));
  assert.equal(deniedAbort.status,404);

  const completions=await Promise.all([
    http(a.url,"POST","/upload-sessions/"+session+"/complete",auth(owner)),
    http(b.url,"POST","/upload-sessions/"+session+"/complete",auth(owner))
  ]);
  assert.ok(completions.some(x=>x.status===200),JSON.stringify(completions));
  assert.ok(completions.every(x=>[200,409].includes(x.status)));
  const files=await prisma.file.findMany({where:{userId:owner}});
  assert.equal(files.length,1,"only one File row can commit");
  assert.equal(files[0].size,BigInt(bytes.length));
  assert.equal((await prisma.user.findUnique({where:{id:owner}})).storageUsed,BigInt(bytes.length));
  assert.equal((await f.storage.existsFile(files[0])),true);
  assert.equal((await http(a.url,"POST","/files/"+files[0].id+"/download-token",auth(foreign))).status,404);

  const tokenResponse=await http(a.url,"POST","/files/"+files[0].id+"/download-token",auth(owner));
  assert.equal(tokenResponse.status,200,JSON.stringify(tokenResponse.body));
  const range=await http(b.url,"GET","/download/"+tokenResponse.body.token,{range:"bytes=0-5"});
  assert.equal(range.status,206,JSON.stringify(range.body));
  assert.equal(range.raw.toString(),"shared");

  const abortSession=await makeSession(a.url,owner,7);
  const aborts=await Promise.all([
    http(a.url,"DELETE","/upload-sessions/"+abortSession,auth(owner)),
    http(b.url,"DELETE","/upload-sessions/"+abortSession,auth(owner))
  ]);
  assert.ok(aborts.every(x=>[200,409].includes(x.status)));
  assert.equal((await prisma.uploadSession.findUnique({where:{id:abortSession}})).status,"ABORTED");

  const expireSession=await makeSession(b.url,owner,9);
  await prisma.uploadSession.update({
    where:{id:expireSession},data:{expiresAt:new Date(Date.now()-60000)}
  });
  await cleanupUploadSessions(f.storage);
  assert.equal((await prisma.uploadSession.findUnique({where:{id:expireSession}})).status,"EXPIRED");
  const user=await prisma.user.findUnique({where:{id:owner}});
  assert.equal(user.reservedUploadBytes,0n);
  assert.equal(user.storageUsed,BigInt(bytes.length));
});

test("SIGKILL after assembly before DB commit reconciles bytes with no File or quota corruption",async t=>{
  const f=await fixture(t);
  const a=await worker(t,f.root,{WORKER_PAUSE_AFTER_ASSEMBLY:"1"});
  const b=await worker(t,f.root);
  const owner=f.users[0].id;
  const data=Buffer.from("after-assembly");
  const session=await makeSession(b.url,owner,data.length);
  assert.equal((await sendPart(b.url,owner,session,data)).status,201);
  const reached=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Assembly barrier never reached")),15000);
    timer.unref();
    a.child.on("message",m=>{
      if(m.phase==="assembled-before-db"){clearTimeout(timer);resolve(m);}
    });
  });
  const completing=http(a.url,"POST","/upload-sessions/"+session+"/complete",auth(owner)).catch(()=>null);
  const barrier=await reached;
  assert.equal(barrier.sessionId,session);
  assert.equal((await f.storage.exists(barrier.finalKey)),true);
  a.child.kill("SIGKILL");
  await awaitExit(a.child);
  await completing;
  assert.equal(await prisma.file.count({where:{userId:owner}}),0);
  const old=new Date(Date.now()-3*3600000);
  await prisma.uploadSession.update({
    where:{id:session},data:{
      expiresAt:old, completionLeaseUntil:old,updatedAt:old
    }
  });
  const clean=await cleanupUploadSessions(f.storage);
  assert.ok(clean>=1);
  const assembly=await prisma.temporaryObject.findUnique({
    where:{objectKey:"assembly:"+barrier.finalKey}
  });
  assert.ok(assembly);
  await prisma.temporaryObject.update({
    where:{id:assembly.id},data:{leaseUntil:old,updatedAt:old}
  });
  await fs.utimes(f.storage.resolve(barrier.finalKey),old,old);
  const reconciled=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:100});
  assert.ok(reconciled.reaped>=1,JSON.stringify(reconciled));
  assert.equal((await f.storage.exists(barrier.finalKey)),false);
  assert.equal((await prisma.user.findUnique({where:{id:owner}})).reservedUploadBytes,0n);
  assert.equal((await prisma.user.findUnique({where:{id:owner}})).storageUsed,0n);
  assert.equal(await prisma.file.count({where:{userId:owner}}),0);
});

test("SIGKILL during a streaming one-shot upload reclaims abandoned bytes and quota while another replica stays healthy",async t=>{
  const f=await fixture(t);
  const a=await worker(t,f.root), b=await worker(t,f.root);
  const owner=f.users[0].id;
  const boundary="----vaultbox-crash-"+crypto.randomUUID();
  const head=Buffer.from("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"interrupted.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n");
  const stream=new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(head);
      controller.enqueue(Buffer.alloc(64,7));
      // Intentional application-layer backpressure barrier: the request is
      // never finalized before the external SIGKILL.
    }
  });
  const inFlight=fetch(a.url+"/files/upload",{
    method:"POST",duplex:"half",
    headers:{...auth(owner),"content-type":"multipart/form-data; boundary="+boundary,"x-upload-size":"1024"},
    body:stream,signal:globalThis.AbortSignal.timeout(15000)
  }).catch(()=>null);
  let claim=null;
  for(let attempt=0;attempt<70;attempt++){
    claim=await prisma.temporaryObject.findFirst({
      where:{userId:owner,kind:"FILE"},orderBy:{createdAt:"desc"}
    });
    if(claim)break;
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  assert.ok(claim,"streaming worker never admitted its temporary bytes");
  assert.equal(claim.bytes,1024n);
  a.child.kill("SIGKILL");
  await awaitExit(a.child);
  await inFlight;
  const old=new Date(Date.now()-3*3600000);
  await prisma.temporaryObject.update({
    where:{id:claim.id},data:{leaseUntil:old,updatedAt:old}
  });
  const fileKey=claim.objectKey.slice(5);
  if(await f.storage.exists(fileKey)) await fs.utimes(f.storage.resolve(fileKey),old,old);
  const report=await reconcileStorage(f.storage,prisma,{graceMs:60000,batchSize:100});
  assert.ok(report.reaped>=1,JSON.stringify(report));
  assert.equal(await f.storage.exists(fileKey),false);
  assert.equal(await prisma.temporaryObject.count({where:{id:claim.id}}),0);
  await prisma.uploadReservation.updateMany({
    where:{userId:owner,state:"PENDING"},data:{leaseUntil:old}
  });
  const {reconcileExpiredReservations}=require("../src/lib/upload-reservation");
  await reconcileExpiredReservations();
  const user=await prisma.user.findUnique({where:{id:owner}});
  assert.equal(user.storageUsed,0n);
  assert.equal(user.reservedUploadBytes,0n);
  // The independent survivor can still admit and commit an upload correctly.
  const form=multipart(Buffer.from("survivor"));
  const alive=await http(b.url,"POST","/files/upload",{
    ...auth(owner),"content-type":form.type,"x-upload-size":"8"
  },form.bytes);
  assert.equal(alive.status,201,JSON.stringify(alive.body));
  assert.equal((await prisma.user.findUnique({where:{id:owner}})).storageUsed,8n);
});
