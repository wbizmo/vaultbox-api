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
  const n=Number(env.BENCH_HIST_REQUESTS || 100);
  if(!Number.isSafeInteger(n)||n<32||n>100) throw new Error("BENCH_HIST_REQUESTS must be 32..100 to respect v1 rate limits");
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
  const cases=[];
  // Historical v1 limits each IP to 120 calls/min, and v2 defaults to 240.
  // Give EACH measured scenario a fresh application instance with a new
  // in-memory rate-limit window; stay below v1's documented cap per instance.
  // The app initialization is outside the timed request batch.
  for(const route of ["/health","/","/plans"]) {
    for(const concurrency of [1,4,16,32]){
      const app=buildApp({logger:false,rateLimitMax:10000});
      try {
        await app.ready();
        for(let i=0;i<5;i++) {
          const warm=await app.inject({method:"GET",url:route});
          if(warm.statusCode!==200)throw new Error("warmup "+route+" returned "+warm.statusCode);
        }
        cases.push(await stage(app,route,requests,concurrency));
      } finally { await app.close(); }
    }
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
}
if(require.main===module)main().catch(e=>{
  console.error("Historical benchmark failed:",e.message);
  process.exitCode=1;
});
module.exports={percentile,sampleCount,stage};
