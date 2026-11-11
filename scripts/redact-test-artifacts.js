"use strict";
const fs=require("node:fs");
const {redactEvidence}=require("./security-static-check");
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error("Usage: node scripts/redact-test-artifacts.js <raw> <redacted>");
const text=fs.readFileSync(input,"utf8");
fs.writeFileSync(output,redactEvidence(text),{mode:0o600});
console.log("Sanitized test log written (secrets and emails omitted)");
