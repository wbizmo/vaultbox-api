"use strict";
// Reproducible capability/API latency matrix, grouped by the release that
// introduced each feature. Runs against current source only: not retroactive
// historical release performance or public Render latency.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");

const CONCURRENCIES = [1, 4, 16, 32];
const DEFAULT_REQUESTS = 40;
function percentile(numbers, q) {
  if (!numbers.length || q < 0 || q > 1) throw new Error("Invalid percentile sample");
  const samples = [...numbers].sort((a,b) => a-b);
  return samples[Math.min(samples.length-1, Math.ceil(q*samples.length)-1)];
}
function rounded(n) { return Math.round(n*1000)/1000; }
function validateOptions(env) {
  if (env.NODE_ENV === "production" || env.VAULTBOX_BENCHMARK_ALLOW_WRITES !== "1")
    throw new Error("Capability benchmarks seed database rows; require disposable non-production DB and VAULTBOX_BENCHMARK_ALLOW_WRITES=1");
  const count = Number(env.BENCH_API_REQUESTS || DEFAULT_REQUESTS);
  if (!Number.isSafeInteger(count) || count < 32 || count > 500)
    throw new Error("BENCH_API_REQUESTS must be an integer from 32 to 500");
  return count;
}

async function measure({ app, label, introduced, concurrency, requests, getRequest, validator }) {
  let index = 0, errors = 0;
  const latencies = [];
  const statuses = {};
  const started = performance.now();
  const cpu = process.cpuUsage();
  let peakRSS = process.memoryUsage().rss;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= requests) return;
      const begin = performance.now();
      try {
        const result = await app.inject(getRequest(current));
        const elapsed = performance.now()-begin;
        latencies.push(elapsed);
        statuses[result.statusCode] = (statuses[result.statusCode] || 0)+1;
        if (validator ? !validator(result) : result.statusCode !== 200) errors++;
      } catch {
        errors++;
      }
      peakRSS = Math.max(peakRSS,process.memoryUsage().rss);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency,requests)},()=>worker()));
  const durationMs = performance.now()-started;
  const usage = process.cpuUsage(cpu);
  const report = {
    label, introducedIn: introduced, concurrency, requests,
    completed: latencies.length, errors,
    statuses, durationMs: rounded(durationMs),
    requestsPerSecond: rounded((requests*1000)/durationMs),
    latencyMs: {
      p50: rounded(percentile(latencies,0.5)),
      p95: rounded(percentile(latencies,0.95)),
      p99: rounded(percentile(latencies,0.99)),
      min: rounded(Math.min(...latencies)),
      max: rounded(Math.max(...latencies))
    },
    cpuUserMs: rounded(usage.user/1000),
    cpuSystemMs: rounded(usage.system/1000),
    peakRSSMiB: rounded(peakRSS/1048576)
  };
  if (errors) throw new Error(label+" at concurrency "+concurrency+" had "+errors+" errors: "+JSON.stringify(statuses));
  return report;
}

async function main() {
  const requests = validateOptions(process.env);
  const tag = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"vaultbox-capability-bench-"));
  const storage = new LocalStorageAdapter(root);
  const config = {
    nodeEnv: "test", isProduction:false, corsOrigins:[],
    jwtSecret:"vaultbox-capability-matrix-only-long-test-secret",
    jwtExpiresIn:"1h",maxUploadBytes:1048576,uploadChunkBytes:65536,
    uploadSessionExpiresMinutes:60,uploadMaxParts:10000,uploadSuggestedParallelParts:4,
    downloadTokenExpiresMinutes:15,downloadSuggestedPartBytes:65536,downloadMaxRanges:8
  };
  const plan = await prisma.plan.create({data:{
    name:"capability-"+tag,priceMonthly:0,storageLimit:500000000n
  }});
  let app;
  const userIds=[];
  const results=[];
  try {
    const [user,admin]=await Promise.all([
      prisma.user.create({data:{
        name:"Capability user",email:"api-user-"+tag+"@example.invalid",
        password:"not-used",planId:plan.id
      }}),
      prisma.user.create({data:{
        name:"Capability admin",email:"api-admin-"+tag+"@example.invalid",
        password:"not-used",role:"ADMIN",planId:plan.id
      }})
    ]);
    userIds.push(user.id,admin.id);
    const folder = await prisma.folder.create({data:{userId:user.id,name:"target-"+tag}});
    const fileData=Array.from({length:requests*CONCURRENCIES.length+80},(_,i)=>({
      originalName:"capability-"+i+".bin",storedName:crypto.randomUUID(),
      mimeType:"application/octet-stream",path:"bench-metadata-"+i+"-"+tag,
      size:0n,userId:user.id,folderId:i%2===0?folder.id:null
    }));
    await prisma.file.createMany({data:fileData});
    const fileRows=await prisma.file.findMany({
      where:{userId:user.id},select:{id:true},orderBy:{id:"asc"}
    });
    app=buildApp({config,storage,logger:false,rateLimitMax:100000});
    await app.ready();
    const auth = {authorization:"Bearer "+app.jwt.sign({id:user.id})};
    const adminAuth = {authorization:"Bearer "+app.jwt.sign({id:admin.id})};
    const created = await app.inject({method:"POST",url:"/upload-sessions",
      headers:auth,payload:{originalName:"progress.bin",mimeType:"application/octet-stream",expectedSize:64}});
    if(created.statusCode!==201)throw new Error("Upload fixture failed: "+created.statusCode);
    const sessionId=created.json().session.id;

    const get=(label,introduced,url,headers)=>({
      label,introduced,getRequest:()=>({method:"GET",url,headers})
    });
    const scenarios=[
      get("public-system-metadata","v1.0.0","/"),
      get("liveness","v1.0.0","/health"),
      get("plan-list","v1.0.0","/plans"),
      get("account-read","v1.0.0","/me",auth),
      get("quota-reservation-aware","v2.5.0","/quota",auth),
      get("folder-list-counted","v1.0.0","/folders?limit=25",auth),
      get("file-list-counted","v1.0.0","/files?limit=25",auth),
      get("file-search","v2.1.0","/files?search=capability&limit=25",auth),
      get("file-cursor","v2.1.0","/files?pagination=cursor&limit=25",auth),
      get("file-count-free","v2.4.0","/files?limit=25&includeTotal=false",auth),
      get("folder-count-free","v2.4.0","/folders?limit=25&includeTotal=false",auth),
      get("file-folder-filter","v2.5.0","/files?folderId="+folder.id+"&limit=25",auth),
      get("file-root-filter","v2.5.0","/files?folderId=root&limit=25",auth),
      get("upload-progress-legacy","v2.1.0","/upload-sessions/"+sessionId,auth),
      get("upload-progress-summary","v2.4.0","/upload-sessions/"+sessionId+"?view=summary",auth),
      get("upload-progress-page","v2.4.0","/upload-sessions/"+sessionId+"?view=page&limit=100&afterPart=-1",auth),
      get("admin-users-counted","v1.0.0","/admin/users?limit=25",adminAuth),
      get("admin-users-count-free","v2.4.0","/admin/users?limit=25&includeTotal=false",adminAuth),
      get("admin-storage-report","v1.0.0","/admin/storage-report",adminAuth),
      get("admin-audit-list","v1.0.0","/admin/audit-logs?limit=25",adminAuth),
      get("admin-audit-count-free","v2.4.0","/admin/audit-logs?limit=25&includeTotal=false",adminAuth),
      {
        label:"folder-create",introduced:"v1.0.0",
        getRequest:i=>({method:"POST",url:"/folders",headers:auth,
          payload:{name:"perf-folder-"+tag+"-"+crypto.randomUUID()+"-"+i}}),
        validator:r=>r.statusCode===201
      },
      {
        label:"file-move",introduced:"v2.5.0",
        getRequest:(i,groupIndex=0)=>({method:"PATCH",
          url:"/files/"+fileRows[groupIndex*requests+i].id,
          headers:auth,payload:{folderId:folder.id}}),
        validator:r=>r.statusCode===200
      }
    ];
    // Preflight every HTTP contract before taking any latency samples.
    // Write endpoints are excluded from preflight to avoid changing fixture state.
    for(const scenario of scenarios.filter(s=>s.label!=="folder-create"&&s.label!=="file-move")){
      const response=await app.inject(scenario.getRequest(0));
      if(response.statusCode!==200)throw new Error("Preflight "+scenario.label+" HTTP "+response.statusCode);
    }
    for(let group=0;group<CONCURRENCIES.length;group++){
      const concurrency=CONCURRENCIES[group];
      for(const scenario of scenarios){
        results.push(await measure({
          app,label:scenario.label,introduced:scenario.introduced,
          concurrency,requests,
          getRequest:i=>scenario.getRequest(i,group),
          validator:scenario.validator
        }));
      }
    }
    const byRelease={};
    for(const result of results){
      byRelease[result.introducedIn] ||= {scenarios:[],samples:0,errors:0};
      byRelease[result.introducedIn].samples+=result.requests;
      byRelease[result.introducedIn].errors+=result.errors;
      if(!byRelease[result.introducedIn].scenarios.includes(result.label))
        byRelease[result.introducedIn].scenarios.push(result.label);
    }
    const report={
      benchmark:"api-capability-matrix-current-v2.5.0-only",
      generatedAt:new Date().toISOString(),
      environment:{node:process.version,platform:process.platform,arch:process.arch,
        transport:"fastify.inject (in-process, not network)",database:"disposable PostgreSQL",
        redis:"configured CI service",storage:"local temporary test fixture"},
      interpretation:"introducedIn labels identify feature origin. All scores measure current v2.5.0 code; no historical v1-v2.2 artifacts were executed.",
      requestsPerScenario:requests,concurrencies:CONCURRENCIES,
      fixture:{files:fileRows.length,users:2,uploadSession:"one incomplete reserved session"},
      byRelease,results
    };
    console.log(JSON.stringify(report,null,2));
  }finally{
    if(app)await app.close().catch(()=>{});
    if(userIds.length){
      const where={userId:{in:userIds}};
      await prisma.downloadToken.deleteMany({where});
      await prisma.uploadPart.deleteMany({where:{session:{userId:{in:userIds}}}});
      await prisma.uploadSession.deleteMany({where});
      await prisma.uploadReservation.deleteMany({where});
      await prisma.temporaryObject.deleteMany({where});
      await prisma.fileDeletion.deleteMany({where});
      await prisma.auditLog.deleteMany({where});
      await prisma.idempotencyKey.deleteMany({where});
      await prisma.file.deleteMany({where});
      await prisma.folder.deleteMany({where});
      await prisma.user.deleteMany({where:{id:{in:userIds}}});
    }
    await prisma.plan.delete({where:{id:plan.id}});
    await prisma.$disconnect();
    await fs.rm(root,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(e=>{
  console.error("Capability benchmark failed:",e.message);
  process.exitCode=1;
});
module.exports={percentile,validateOptions,measure};
