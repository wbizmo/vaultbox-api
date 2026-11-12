"use strict";
// Uniform public health and plans benchmark for an *actual historical checkout*.
// No scenario that writes tenant data is run. Every release tag is exercised
// in its own isolated PostgreSQL + Redis CI job with its own pinned Node.
const path = require("node:path");
const { performance } = require("node:perf_hooks");

function percentile(samples,q) {
  if (!samples.length || !Number.isFinite(q) || q < 0 || q > 1)
    throw new Error("invalid samples or percentile");
  const sorted=[...samples].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)];
}
function round(num) { return Math.round(num*1000)/1000; }
function sampleCount(env=process.env) {
  const n=Number(env.BENCH_HIST_REQUESTS || 500);
  if(!Number.isSafeInteger(n)||n<100||n>20000) throw new Error("BENCH_HIST_REQUESTS must be 100..20000");
  return n;
}
async function stage(app,route,requests,concurrency) {
  const durations=[];
  const statuses={};
  let errors=0,next=0;
  const start=performance.now();
  const cpu=process.cpuUsage();
  let peak=process.memoryUsage().rss;
  const worker=async()=>{
    while(true){
      const index=next++;
      if(index>=requests)return;
      const began=performance.now();
      try{
        const result=await app.inject({method:"GET",url:route});
        const elapsed=performance.now()-began;
        durations.push(elapsed);
        statuses[result.statusCode]=(statuses[result.statusCode]||0)+1;
        if(result.statusCode!==200) errors++;
      }catch {errors++;}
      peak=Math.max(peak,process.memoryUsage().rss);
    }
  };
  await Promise.all(Array.from({length:Math.min(requests,concurrency)},()=>worker()));
  const ms=performance.now()-start;
  const cpuUsed=process.cpuUsage(cpu);
  const report={
    route,requests,concurrency,completed:durations.length,errors,statuses,
    durationMs:round(ms),requestsPerSecond:round(requests*1000/ms),
    latencyMs:{p50:round(percentile(durations,0.5)),
      p95:round(percentile(durations,0.95)),p99:round(percentile(durations,0.99))},
    cpuUserMs:round(cpuUsed.user/1000),cpuSystemMs:round(cpuUsed.system/1000),
    peakRSSMiB:round(peak/1048576)
  };
  if(errors)throw new Error("historical "+route+" on "+process.env.RELEASE_TAG+
    " has "+errors+" errors: "+JSON.stringify(statuses));
  return report;
}

async function main() {
  const requests=sampleCount();
  if(!process.env.RELEASE_TAG)throw new Error("RELEASE_TAG is required");
  const root=process.cwd();
  const packageInfo=require(path.join(root,"package.json"));
  const buildApp=require(path.join(root,"src","app.js"));
  const app=buildApp({logger:false});
  try {
    await app.ready();
    // Warm all routes equally to exclude first-call registration.
    for(let i=0;i<100;i++)await app.inject({method:"GET",url:"/health"});
    const cases=[];
    for(const route of ["/health","/","/plans"]) {
      const preflight=await app.inject({method:"GET",url:route});
      if(preflight.statusCode!==200)throw new Error("preflight "+route+" returned "+preflight.statusCode);
      for(const concurrency of [1,4,16,32])
        cases.push(await stage(app,route,requests,concurrency));
    }
    console.log(JSON.stringify({
      benchmark:"historical-version-health-and-public-api",
      releaseTag:process.env.RELEASE_TAG,packageVersion:packageInfo.version,
      commitSha:process.env.RELEASE_COMMIT||null,
      generatedAt:new Date().toISOString(),
      environment:{node:process.version,platform:process.platform,arch:process.arch,
        transport:"Fastify.inject",postgres:"disposable PostgreSQL 16",
        redis:"disposable Redis 7",driver:"same harness across all tags"},
      caveat:"Health/root/plan endpoints only; per-tag Node versions and dependencies differ; CI hardware is shared and noisy. Not public Render throughput or complete historical feature coverage.",
      cases
    },null,2));
  } finally { await app.close(); }
}
if(require.main===module)main().catch(e=>{
  console.error("Historical benchmark failed:",e.message);
  process.exitCode=1;
});
module.exports={percentile,sampleCount,stage};
