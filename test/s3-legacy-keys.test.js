"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Readable}=require("node:stream");
const {S3StorageAdapter}=require("../src/lib/s3-storage");

test("S3 legacy stored names map to stable isolated keys across read/write/existence/deletion", async()=>{
  const messages=[];
  const legacy="2021/uploads/client A/scan 001.pdf";
  const fake={
    async send(cmd){
      messages.push({type:cmd.constructor.name,key:cmd.input.Key});
      if(cmd.constructor.name==="HeadObjectCommand")return {ContentLength:3,LastModified:new Date(0)};
      if(cmd.constructor.name==="GetObjectCommand")return {Body:Readable.from([Buffer.from("abc")])};
      if(cmd.constructor.name==="DeleteObjectCommand")return {};
      throw Error("Unexpected "+cmd.constructor.name);
    }, destroy(){}
  };
  const storage=new S3StorageAdapter({
    client:fake,bucket:"test",region:"us-east-1",prefix:"safe",verifyConditionalWrites:false
  });
  const file={id:"original-file-id-1",storedName:legacy};
  const key=storage.objectKeyForFile(file);
  assert.match(key,/^safe\/objects\/legacy\/[a-f0-9]{64}$/);
  assert.equal(storage.objectKeyForFile(file),key);
  assert.notEqual(storage.objectKeyForFile({id:"original-file-id-2",storedName:legacy}),key);
  assert.notEqual(storage.objectKeyForFile({id:"original-file-id-1",storedName:"2021/uploads/client B/scan 001.pdf"}),key);
  assert.throws(()=>storage.objectKeyForFile({storedName:legacy}),/File ID/);
  assert.equal(storage.objectKeyForFile({storedName:"new-uuid_123"}),"safe/objects/new-uuid_123");
  assert.throws(()=>storage.createWriteStream(legacy),/Invalid storage key/);
  storage.writerForKey=(k)=>({ params: { Key:k } });
  const writer=storage.createWriteStreamForFile(file);
  assert.equal(writer.params.Key,key);
  assert.equal(await storage.existsFile(file),true);
  const stream=await storage.openReadStreamForFile(file);
  const bytes=[];
  for await(const chunk of stream)bytes.push(chunk);
  assert.equal(Buffer.concat(bytes).toString(),"abc");
  assert.equal(await storage.deleteFile(file),true);
  assert.ok(messages.filter(m=>m.key===key).length>=3);
  assert.equal(messages.some(m=>m.key==="safe/objects/"+legacy),false);
});
