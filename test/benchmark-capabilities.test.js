"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {percentile,validateOptions,measure}=require("../scripts/benchmark-capabilities");

test("percentiles sort samples and use nearest rank",()=>{
  assert.equal(percentile([100,1,8,4],0.5),4);
  assert.equal(percentile([100,1,8,4],0.95),100);
  assert.throws(()=>percentile([],0.5),/Invalid percentile/);
  assert.throws(()=>percentile([1,2],1.1),/Invalid percentile/);
});
test("capability matrix refuses production and requires disposable opt-in",()=>{
  assert.throws(()=>validateOptions({NODE_ENV:"production",VAULTBOX_BENCHMARK_ALLOW_WRITES:"1"}),/disposable/);
  assert.throws(()=>validateOptions({NODE_ENV:"test"}),/disposable/);
  assert.equal(validateOptions({NODE_ENV:"test",VAULTBOX_BENCHMARK_ALLOW_WRITES:"1"}),40);
  assert.throws(()=>validateOptions({NODE_ENV:"test",VAULTBOX_BENCHMARK_ALLOW_WRITES:"1",
    BENCH_API_REQUESTS:"not-a-number"}),/BENCH_API_REQUESTS/);
});
test("capability runner records p50/p95/p99, exact response counts and zero errors",async()=>{
  let invoked=0;
  const app={inject:async()=>{invoked++;return{statusCode:200}}};
  const result=await measure({app,label:"fixture",introduced:"v1.0.0",
    concurrency:4,requests:32,getRequest:()=>({method:"GET",url:"/health"})});
  assert.equal(invoked,32);
  assert.equal(result.errors,0);
  assert.equal(result.completed,32);
  assert.equal(result.statuses[200],32);
  assert.ok(result.requestsPerSecond>0);
  assert.ok(result.latencyMs.p99>=result.latencyMs.p50);
});
test("capability runner fails on unexpected HTTP results without hiding errors",async()=>{
  const app={inject:async()=>({statusCode:500})};
  await assert.rejects(measure({app,label:"broken",introduced:"v2.5.0",
    concurrency:2,requests:32,getRequest:()=>({method:"GET",url:"/fail"})}),/32 errors/);
});
