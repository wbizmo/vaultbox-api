// @ts-check
"use strict";

const fs=require("node:fs");
const path=require("node:path");
const {execFileSync}=require("node:child_process");

const signatures=[
  {name:"private key material",pattern:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/},
  {name:"cloud credential",pattern:/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/},
  {name:"access token",pattern:/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xoxb-[0-9]{10,}-[A-Za-z0-9-]{20,}/},
  {name:"password-bearing database URL",pattern:/postgres(?:ql)?:\/\/[^\/:\s'"]+:[^@\s'"]+@/}
];

/** @param {string} content */
function findSecrets(content) {
  return signatures.filter(item=>item.pattern.test(content)).map(item=>item.name);
}

/** @param {string} [root] */
function scanTracked(root=process.cwd()) {
  const names=execFileSync("git",["ls-files","-z","--","src","prisma","scripts"],{
    cwd:root,encoding:"utf8"
  }).split("\0").filter(Boolean);
  const findings=[];
  for(const name of names){
    if(!/\.(?:js|mjs|cjs|sql|json)$/.test(name))continue;
    if(name==="scripts/security-static-check.js")continue;
    const content=fs.readFileSync(path.join(root,name),"utf8");
    // One known public loopback-only benchmark fixture is not a deployment secret.
    // Do not exempt other credentials or the rest of that file from scanning.
    const checked=name==="scripts/benchmark.js"
      ? content.replace("postgresql://benchmark:benchmark@127.0.0.1:5432/benchmark",
        "[PUBLIC LOOPBACK TEST FIXTURE]")
      : content;
    for(const finding of findSecrets(checked))findings.push({file:name,category:finding});
  }
  return {scannedFiles:names.length,findings};
}

/** @param {unknown} input */
function redactEvidence(input) {
  return String(input)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi,"Bearer [REDACTED]")
    .replace(/\/download\/[A-Za-z0-9._~-]{12,}/g,"/download/[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[EMAIL REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'@]+:[^\s"'@]+@[^\s"']+/gi,"postgresql://[REDACTED]")
    .replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}/g,"[TOKEN REDACTED]");
}

if(require.main===module){
  const {scannedFiles,findings}=scanTracked();
  if(findings.length){
    console.error("Security static gate failed:",JSON.stringify(findings));
    process.exitCode=1;
  } else console.log("Security static gate passed:",scannedFiles,"tracked runtime files checked");
}

module.exports={findSecrets,redactEvidence,scanTracked};
