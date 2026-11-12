"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const buildApp = require("../src/app");
const { LocalStorageAdapter } = require("../src/lib/storage");

const config = {
  nodeEnv:"test", isProduction:false, corsOrigins:[],
  jwtSecret:"folder-tests-secret-long-enough", jwtExpiresIn:"1h",
  maxUploadBytes:1048576, uploadChunkBytes:4, uploadSessionExpiresMinutes:60,
  uploadMaxParts:10000, uploadSuggestedParallelParts:4,
  downloadTokenExpiresMinutes:10, downloadSuggestedPartBytes:1024, downloadMaxRanges:4
};
function multipart(bytes) {
  const b = "----vaultbox-"+crypto.randomUUID();
  return { payload: Buffer.concat([
    Buffer.from("--"+b+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"data.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
    bytes, Buffer.from("\r\n--"+b+"--\r\n")
  ]), contentType:"multipart/form-data; boundary="+b };
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vbox-folders-"));
  const tag=crypto.randomUUID();
  const plan=await prisma.plan.create({data:{name:"folders-"+tag,priceMonthly:0,storageLimit:1000n}});
  const user=await prisma.user.create({data:{name:"Owner",email:"folder-owner-"+tag+"@example.com",password:"unused",planId:plan.id}});
  const other=await prisma.user.create({data:{name:"Other",email:"folder-other-"+tag+"@example.com",password:"unused",planId:plan.id}});
  const folder=await prisma.folder.create({data:{userId:user.id,name:"Mine"}});
  const foreign=await prisma.folder.create({data:{userId:other.id,name:"Theirs"}});
  const file=await prisma.file.create({data:{userId:user.id,originalName:"file",storedName:tag,mimeType:"application/octet-stream",size:3n,path:tag,checksum:"f".repeat(64)}});
  await prisma.user.update({where:{id:user.id},data:{storageUsed:3n}});
  const app=buildApp({logger:false,config,storage:new LocalStorageAdapter(root)});
  await app.ready();
  t.after(async()=>{
    await app.close();
    await prisma.uploadSession.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.uploadReservation.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.auditLog.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.downloadToken.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.file.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.folder.deleteMany({where:{userId:{in:[user.id,other.id]}}});
    await prisma.user.deleteMany({where:{id:{in:[user.id,other.id]}}});
    await prisma.plan.delete({where:{id:plan.id}});
    await fs.rm(root,{recursive:true,force:true});
  });
  const auth={authorization:"Bearer "+app.jwt.sign({id:user.id})};
  const otherAuth={authorization:"Bearer "+app.jwt.sign({id:other.id})};
  const move=(id,folderId,headers=auth)=>app.inject({method:"PATCH",url:"/files/"+id,headers,payload:{folderId}});
  return {app,user,other,folder,foreign,file,auth,otherAuth,move};
}

test("owned and foreign folder move with root, cursor filter and unchanged quota",async t=>{
  const f=await fixture(t);
  const moved=await f.move(f.file.id,f.folder.id);
  assert.equal(moved.statusCode,200,moved.body);
  assert.equal(moved.json().file.folderId,f.folder.id);
  const listing=await f.app.inject({method:"GET",url:"/files?pagination=cursor&folderId="+f.folder.id,headers:f.auth});
  assert.deepEqual(listing.json().files.map(x=>x.id),[f.file.id]);
  assert.equal((await f.move(f.file.id,f.foreign.id)).statusCode,404);
  assert.equal((await f.move(f.file.id,null,f.otherAuth)).statusCode,404);
  assert.equal((await prisma.file.findUnique({where:{id:f.file.id}})).folderId,f.folder.id);
  const root=await f.move(f.file.id,null);
  assert.equal(root.statusCode,200,root.body);
  const roots=await f.app.inject({method:"GET",url:"/files?folderId=root",headers:f.auth});
  assert.deepEqual(roots.json().files.map(x=>x.id),[f.file.id]);
  const file=await prisma.file.findUnique({where:{id:f.file.id}});
  assert.equal(file.size,3n);assert.equal(file.checksum,"f".repeat(64));
  assert.equal((await prisma.user.findUnique({where:{id:f.user.id}})).storageUsed,3n);
});

test("one-shot and resumable uploads accept owned folder, reject foreign; folder deletion clears pending destination",async t=>{
  const f=await fixture(t);
  const body=multipart(Buffer.from("hello"));
  const accepted=await f.app.inject({method:"POST",url:"/files/upload",headers:{...f.auth,"content-type":body.contentType,"x-upload-size":"5","x-folder-id":f.folder.id},payload:body.payload});
  assert.equal(accepted.statusCode,201,accepted.body);
  assert.equal(accepted.json().file.folderId,f.folder.id);
  const rejected=await f.app.inject({method:"POST",url:"/files/upload",headers:{...f.auth,"content-type":body.contentType,"x-folder-id":f.foreign.id},payload:body.payload});
  assert.equal(rejected.statusCode,404,rejected.body);
  const created=await f.app.inject({method:"POST",url:"/upload-sessions",headers:f.auth,payload:{originalName:"upload.bin",mimeType:"application/octet-stream",expectedSize:5,folderId:f.folder.id}});
  assert.equal(created.statusCode,201,created.body);
  const sid=created.json().session.id;
  assert.equal(created.json().session.folderId,f.folder.id);
  const noForeign=await f.app.inject({method:"POST",url:"/upload-sessions",headers:f.auth,payload:{originalName:"foreign.bin",mimeType:"application/octet-stream",expectedSize:5,folderId:f.foreign.id}});
  assert.equal(noForeign.statusCode,404,noForeign.body);
  const deleted=await f.app.inject({method:"DELETE",url:"/folders/"+f.folder.id,headers:f.auth});
  assert.equal(deleted.statusCode,200,deleted.body);
  const pending=await prisma.uploadSession.findUnique({where:{id:sid}});
  assert.equal(pending.folderId,null);
  assert.equal((await prisma.file.findFirst({where:{userId:f.user.id,originalName:"data.bin"}})).folderId,null);
  const temp=await prisma.folder.create({data:{userId:f.user.id,name:"Race"}});
  const results=await Promise.all([f.move(f.file.id,temp.id),f.app.inject({method:"DELETE",url:"/folders/"+temp.id,headers:f.auth})]);
  assert.ok([200,404].includes(results[0].statusCode),results[0].body);
  assert.equal(results[1].statusCode,200,results[1].body);
  assert.equal((await prisma.file.findUnique({where:{id:f.file.id}})).folderId,null);
});
