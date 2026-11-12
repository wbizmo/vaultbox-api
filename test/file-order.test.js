"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const { filePageOrderBy, fileCursorOrderBy, fileCursorWhere }=require("../src/lib/file-order");

test("file sorting constructs only fixed Prisma fields for all four allowed sorts",()=>{
  for(const name of ["createdAt","updatedAt","size","originalName"]){
    assert.deepEqual(filePageOrderBy(name,"asc"),{[name]:"asc"});
    assert.deepEqual(fileCursorOrderBy(name,"desc"),[{[name]:"desc"},{id:"desc"}]);
  }
  assert.deepEqual(filePageOrderBy("__proto__","asc"),{createdAt:"asc"});
  assert.deepEqual(filePageOrderBy("constructor","invalid"),{createdAt:"desc"});
});

test("keyset comparisons use fixed fields and validated ascending/descending operators",()=>{
  const c={id:"file-2",value:100n};
  assert.deepEqual(fileCursorWhere(c,"size","asc"),{
    OR:[{size:{gt:100n}},{size:100n,id:{gt:"file-2"}}]
  });
  assert.deepEqual(fileCursorWhere(c,"size","desc"),{
    OR:[{size:{lt:100n}},{size:100n,id:{lt:"file-2"}}]
  });
  assert.deepEqual(fileCursorWhere(null,"size","asc"),{});
  assert.deepEqual(fileCursorWhere({id:"x",value:"text"},"__proto__","desc"),{
    OR:[{createdAt:{lt:"text"}},{createdAt:"text",id:{lt:"x"}}]
  });
});
