"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {findSecrets,redactEvidence}=require("../scripts/security-static-check");
test("security scanner flags high-risk credential strings, not generic placeholder descriptions",()=>{
  assert.deepEqual(findSecrets("ordinary sample credentials and environment variable names"),[]);
  assert.ok(findSecrets("-----BEGIN RSA PRIVATE KEY-----")[0]);
  assert.ok(findSecrets("postgresql://alice:password@db.internal:5432/db").includes("password-bearing database URL"));
  assert.ok(findSecrets("AKIA"+"A".repeat(16)).includes("cloud credential"));
});
test("evidence redaction removes bearer tokens, emails, raw download URLs and connection secrets",()=>{
  const raw="Bearer abc.def.ghi alice@example.com /download/abcdefghijklmnopqrstuvwxyz1234 "+
    "postgresql://bob:secret@db.example.org/db";
  const result=redactEvidence(raw);
  for(const secret of ["abc.def.ghi","alice@example.com","abcdefghijklmnopqrstuvwxyz1234","bob:secret"])
    assert.equal(result.includes(secret),false);
  assert.match(result,/REDACTED/);
});
