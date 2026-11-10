"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const prisma=require("../src/lib/prisma");
const {retentionSettings,pruneMetadata}=require("../src/lib/metadata-retention");

test("metadata retention requires explicit audit policy and rejects unsafe configuration",()=>{
  assert.equal(retentionSettings({}).auditDays,0);
  assert.equal(retentionSettings({VAULTBOX_METADATA_PRUNE_BATCH_SIZE:"25"}).batchSize,25);
  assert.throws(()=>retentionSettings({VAULTBOX_METADATA_PRUNE_BATCH_SIZE:"0"}));
  assert.throws(()=>retentionSettings({VAULTBOX_AUDIT_RETENTION_DAYS:"-1"}));
  assert.throws(()=>retentionSettings({VAULTBOX_UPLOAD_METADATA_RETENTION_DAYS:"abc"}));
});

test("bounded keyset pruning is restartable, cascades terminal parts, and protects active sessions, valid tokens and audits",async t=>{
  const tag=crypto.randomUUID();
  const now=new Date();
  const old=new Date(now.getTime()-50*86400000);
  const near=new Date(now.getTime()-86400000);
  const plan=await prisma.plan.create({data:{name:"retention-"+tag,priceMonthly:0,storageLimit:10000n}});
  const user=await prisma.user.create({data:{name:"Retention",email:"retention-"+tag+"@example.com",password:"unused",planId:plan.id}});
  const file=await prisma.file.create({data:{originalName:"retained.dat",storedName:"retained-"+tag,path:"retained-"+tag,mimeType:"application/octet-stream",size:1n,userId:user.id}});
  t.after(async()=>{
    await prisma.downloadToken.deleteMany({where:{userId:user.id}});
    await prisma.uploadSession.deleteMany({where:{userId:user.id}});
    await prisma.auditLog.deleteMany({where:{userId:user.id}});
    await prisma.file.deleteMany({where:{userId:user.id}});
    await prisma.user.delete({where:{id:user.id}});
    await prisma.plan.delete({where:{id:plan.id}});
  });

  const terminal=Array.from({length:117},(_,i)=>({
    id:"ret-"+crypto.randomUUID(),userId:user.id,originalName:"old-"+i,
    mimeType:"application/octet-stream",expectedSize:1n,chunkSize:1,partCount:1,
    status:["COMPLETED","ABORTED","EXPIRED"][i%3],expiresAt:old,updatedAt:old
  }));
  await prisma.uploadSession.createMany({data:terminal});
  const active=await prisma.uploadSession.create({data:{userId:user.id,originalName:"live",mimeType:"application/octet-stream",expectedSize:1n,chunkSize:1,partCount:1,status:"UPLOADING",expiresAt:new Date(now.getTime()+86400000),updatedAt:old}});
  const completing=await prisma.uploadSession.create({data:{userId:user.id,originalName:"live completing",mimeType:"application/octet-stream",expectedSize:1n,chunkSize:1,partCount:1,status:"COMPLETING",expiresAt:old,updatedAt:old}});
  await prisma.uploadPart.createMany({data:terminal.slice(0,30).map(x=>({sessionId:x.id,partNumber:0,offset:0n,size:1n,checksum:"f".repeat(64),storedName:crypto.randomUUID()}))});
  const tokens=Array.from({length:117},()=>({fileId:file.id,userId:user.id,token:crypto.randomUUID(),expiresAt:old}));
  await prisma.downloadToken.createMany({data:tokens});
  const valid=await prisma.downloadToken.create({data:{fileId:file.id,userId:user.id,token:crypto.randomUUID(),expiresAt:new Date(now.getTime()+86400000)}});
  const recentExpired=await prisma.downloadToken.create({data:{fileId:file.id,userId:user.id,token:crypto.randomUUID(),expiresAt:near}});
  const oldAudit=await prisma.auditLog.create({data:{action:"REQUIRED_SECURITY_EVENT",userId:user.id,createdAt:old}});
  const recentAudit=await prisma.auditLog.create({data:{action:"RECENT",userId:user.id,createdAt:near}});

  let uploads=0,downloads=0,iterations=0;
  while(true){
    const result=await pruneMetadata({now,batchSize:17,uploadDays:30,downloadDays:30,auditDays:0});
    assert.ok(result.uploads<=17);assert.ok(result.downloads<=17);
    assert.equal(result.audits,0);
    uploads+=result.uploads;downloads+=result.downloads;iterations+=1;
    if(result.total===0)break;
    assert.ok(iterations<20);
  }
  assert.equal(uploads,117);assert.equal(downloads,117);
  assert.ok(iterations>=7);
  assert.equal(await prisma.uploadPart.count({where:{sessionId:{in:terminal.map(x=>x.id)}}}),0);
  assert.equal(await prisma.uploadSession.count({where:{id:{in:[active.id,completing.id]}}}),2);
  assert.equal(await prisma.downloadToken.count({where:{id:{in:[valid.id,recentExpired.id]}}}),2);
  assert.equal(await prisma.auditLog.count({where:{id:oldAudit.id}}),1);
  assert.equal(await prisma.file.count({where:{id:file.id}}),1);
  const opted=await pruneMetadata({now,batchSize:10,uploadDays:30,downloadDays:30,auditDays:30});
  assert.equal(opted.audits,1);
  assert.equal(await prisma.auditLog.count({where:{id:recentAudit.id}}),1);
  assert.equal((await pruneMetadata({now,batchSize:10,uploadDays:30,downloadDays:30,auditDays:30})).total,0);
});
