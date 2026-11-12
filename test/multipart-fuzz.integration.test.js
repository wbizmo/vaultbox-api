"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const prisma=require("../src/lib/prisma");
const buildApp=require("../src/app");
const {LocalStorageAdapter}=require("../src/lib/storage");

const config={
  nodeEnv:"test",isProduction:false,corsOrigins:[],
  jwtSecret:"multipart-fuzz-tests-long-enough-key",
  jwtExpiresIn:"1h",maxUploadBytes:65536,uploadChunkBytes:4,
  uploadSessionExpiresMinutes:60,uploadMaxParts:10000,uploadSuggestedParallelParts:4,
  downloadTokenExpiresMinutes:10,downloadSuggestedPartBytes:4096,downloadMaxRanges:4
};
test("deterministic malformed multipart/range corpus remains 4xx, does not create parts, leak quota, or cross tenants",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vaultbox-fuzz-"));
  const storage=new LocalStorageAdapter(root);await storage.ready();
  const tag=crypto.randomUUID();
  const plan=await prisma.plan.create({data:{name:"fuzz-"+tag,priceMonthly:0,storageLimit:10000n}});
  const alice=await prisma.user.create({data:{
    name:"Alice",email:"fuzz-a-"+tag+"@example.invalid",password:"unused",planId:plan.id
  }});
  const bob=await prisma.user.create({data:{
    name:"Bob",email:"fuzz-b-"+tag+"@example.invalid",password:"unused",planId:plan.id
  }});
  const app=buildApp({config,storage,logger:false});
  await app.ready();
  t.after(async()=>{
    await app.close();
    const ids=[alice.id,bob.id],w={userId:{in:ids}};
    await prisma.downloadToken.deleteMany({where:w});
    await prisma.uploadPart.deleteMany({where:{session:{userId:{in:ids}}}});
    await prisma.uploadSession.deleteMany({where:w});
    await prisma.uploadReservation.deleteMany({where:w});
    await prisma.temporaryObject.deleteMany({where:w});
    await prisma.fileDeletion.deleteMany({where:w});
    await prisma.auditLog.deleteMany({where:w});
    await prisma.file.deleteMany({where:w});
    await prisma.user.deleteMany({where:{id:{in:ids}}});
    await prisma.plan.delete({where:{id:plan.id}});
    await fs.rm(root,{recursive:true,force:true});
  });
  const a={authorization:"Bearer "+app.jwt.sign({id:alice.id})};
  const b={authorization:"Bearer "+app.jwt.sign({id:bob.id})};
  const created=await app.inject({method:"POST",url:"/upload-sessions",headers:a,
    payload:{originalName:"fuzz.bin",mimeType:"application/octet-stream",expectedSize:8}});
  assert.equal(created.statusCode,201,created.body);
  const sid=created.json().session.id;
  const names=[
    "bytes -1-3/8","bytes 0-2/8","bytes 0-9/8","bytes 4-7/8",
    "bytes 0-3/0","bytes 0-3/99","bytes a-b/c","bytes 0-3/*",
    "items 0-3/8","bytes 0--3/8","bytes 0-3/0000","bytes 0-3/8,4-7/8",
    "bytes 0-3/8\r\nx-injected: x",""
  ];
  let state=0x12345678;
  for(let i=0;i<35;i++){
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    names.push("bytes "+String(state)+"-"+String(state^0xf0)+"/"+String(state%100000));
  }
  for(const [i,range] of names.entries()){
    const boundary="----vaultbox-fuzz-"+i;
    const payload=Buffer.from("--"+boundary+
      "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"part.bin\"\r\n"+
      "Content-Type: application/octet-stream\r\n\r\nabcd\r\n--"+boundary+"--\r\n");
    const res=await app.inject({method:"PUT",url:"/upload-sessions/"+sid+"/parts/0",
      headers:{...a,"content-type":"multipart/form-data; boundary="+boundary,
        "content-range":range},payload});
    assert.ok(res.statusCode>=400 && res.statusCode<500,
      "case "+i+" returned "+res.statusCode+": "+res.body);
    assert.doesNotMatch(res.body,/database_url|jwt_secret|postgresql:|Bearer /i);
  }
  const otherBoundary="----vaultbox-fuzz-foreign";
  const otherPayload=Buffer.from("--"+otherBoundary+
    "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"part.bin\"\r\n"+
    "Content-Type: application/octet-stream\r\n\r\nabcd\r\n--"+otherBoundary+"--\r\n");
  const unauthorized=await app.inject({method:"PUT",url:"/upload-sessions/"+sid+"/parts/0",
    headers:{...b,"content-range":"bytes 0-3/8",
      "content-type":"multipart/form-data; boundary="+otherBoundary},payload:otherPayload});
  assert.equal(unauthorized.statusCode,404,unauthorized.body);
  assert.equal(await prisma.uploadPart.count({where:{sessionId:sid}}),0);
  assert.equal(await prisma.file.count({where:{userId:alice.id}}),0);
  const stateUser=await prisma.user.findUnique({where:{id:alice.id}});
  assert.equal(stateUser.storageUsed,0n);
  assert.equal(stateUser.reservedUploadBytes,8n);
});
