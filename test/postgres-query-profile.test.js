"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { percentile, walkPlan, queries } = require("../scripts/profile-postgres");

test("query profiling uses stable nearest-rank percentiles", () => {
  assert.equal(percentile([9, 3, 1, 4], 0.5), 3);
  assert.equal(percentile([9, 3, 1, 4], 0.95), 9);
  assert.equal(percentile([], 0.5), null);
});

test("plan walking retains index scans and nested children", () => {
  const nodes = walkPlan({
    "Node Type": "Limit",
    Plans: [{ "Node Type": "Index Scan", "Index Name": "File_userId_status_createdAt_id_idx",
      "Relation Name": "File", "Actual Rows": 25, "Shared Read Blocks": 0 }]
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].index, "File_userId_status_createdAt_id_idx");
  assert.equal(nodes[1].actualRows, 25);
});

test("query profile never puts user input in SQL text", () => {
  for (const query of queries) {
    assert.match(query.sql, /\$1/);
    assert.ok(query.args("a-sentinel")[0] === "a-sentinel");
  }
});

test("query benchmark refuses production databases and requires explicit nonproduction opt-in", async()=>{
  const {run}=require("../scripts/profile-postgres");
  const originalMode=process.env.NODE_ENV;
  const originalOptin=process.env.VAULTBOX_QUERY_PROFILE_ALLOW_WRITES;
  try {
    process.env.NODE_ENV="production";
    process.env.VAULTBOX_QUERY_PROFILE_ALLOW_WRITES="1";
    await assert.rejects(run({sizes:[]}),/Refusing to seed synthetic/);
    process.env.NODE_ENV="test";
    delete process.env.VAULTBOX_QUERY_PROFILE_ALLOW_WRITES;
    await assert.rejects(run({sizes:[]}),/Refusing to seed synthetic/);
  } finally {
    if(originalMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=originalMode;
    if(originalOptin===undefined)delete process.env.VAULTBOX_QUERY_PROFILE_ALLOW_WRITES;
    else process.env.VAULTBOX_QUERY_PROFILE_ALLOW_WRITES=originalOptin;
  }
});
