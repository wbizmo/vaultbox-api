"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {percentile,sampleCount,stage}=require("../scripts/benchmark-history");
test("history p50 and p95 are correctly ranked",()=>{
 assert.equal(percentile([10,1,5,9,3],0.5),5);
 assert.equal(percentile([10,1,5,9,3],0.95),10);
 assert.throws(()=>percentile([],0.5),/invalid samples/);
});
test("history requests have strict, bounded reproducibility limits",()=>{
 assert.equal(sampleCount({}),100);
 assert.throws(()=>sampleCount({BENCH_HIST_REQUESTS:"999999999"}),/32..100/);
});
test("history runner records errors as hard failures",async()=>{
 const app={inject:async()=>({statusCode:429})};
 await assert.rejects(stage(app,"/health",100,4),/100 errors/);
});
test("history runner emits successful latency data",async()=>{
 const app={inject:async()=>({statusCode:200})};
 const r=await stage(app,"/health",100,4);
 assert.equal(r.errors,0);
 assert.equal(r.completed,100);
 assert.equal(r.statuses[200],100);
 assert.ok(r.latencyMs.p99>=r.latencyMs.p50);
});
