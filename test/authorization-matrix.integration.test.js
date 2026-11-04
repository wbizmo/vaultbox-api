const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const cache = require("../src/lib/cache");
const { LocalStorageAdapter } = require("../src/lib/storage");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "authorization-matrix-test-secret-long-enough",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

const UNKNOWN_ID = "does-not-exist-" + "0".repeat(8);

// Routes that are intentionally reachable without a bearer token. Every other
// route in the OpenAPI document must reject anonymous callers, so a newly
// added route cannot silently ship without authentication.
const PUBLIC_ROUTES = new Set([
  "GET /",
  "GET /health",
  "GET /infra/health",
  "GET /plans",
  "POST /auth/register",
  "POST /auth/login",
  "GET /download/{token}",
  "HEAD /download/{token}"
]);

// Body-schema validation runs before the auth preHandler, so the anonymous sweep
// sends schema-valid bodies to prove the 401 comes from authentication itself.
function anonymousRequestFor(method, route) {
  const url = route.replace("{partNumber}", "0").replace(/\{[^}]+\}/g, "x");
  const key = `${method} ${route}`;
  if (key === "POST /folders" || key === "PATCH /folders/{id}") {
    return { method, url, payload: { name: "x" } };
  }
  if (key === "POST /upload-sessions") {
    return { method, url, payload: { originalName: "a", mimeType: "a/b", expectedSize: 1 } };
  }
  if (key === "PUT /upload-sessions/{id}/parts/{partNumber}") {
    const part = multipartBody(Buffer.from("x"));
    return {
      method,
      url,
      payload: part.payload,
      headers: { "content-type": part.contentType, "content-range": "bytes 0-0/1" }
    };
  }
  return { method, url };
}

function multipartBody(bytes) {
  const boundary = `----vaultbox${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="part.bin"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function createUser(planId, overrides = {}) {
  return prisma.user.create({
    data: {
      name: "Matrix User",
      email: `matrix-${crypto.randomUUID()}@example.com`,
      password: "not-used",
      planId,
      ...overrides
    }
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-authz-"));
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({
    data: { name: `authz-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 10000n }
  });
  const alice = await createUser(plan.id, { storageUsed: 11n });
  const bob = await createUser(plan.id);
  const admin = await createUser(plan.id, { role: "ADMIN" });
  const suspended = await createUser(plan.id, { status: "SUSPENDED" });
  const deleted = await createUser(plan.id, { status: "DELETED" });
  const everyone = [alice, bob, admin, suspended, deleted];
  const ids = everyone.map((u) => u.id);

  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const auth = (user, claims = {}) => ({
    authorization: `Bearer ${app.jwt.sign({ id: user.id, ...claims })}`
  });

  // Alice's resources: a file with real bytes, a folder, and an open upload session.
  const storedName = crypto.randomUUID();
  const bytes = Buffer.from("alice-secret");
  await fs.writeFile(storage.resolve(storedName), bytes);
  const file = await prisma.file.create({
    data: {
      originalName: "alice-private.txt",
      storedName,
      mimeType: "text/plain",
      size: BigInt(bytes.length),
      path: storedName,
      checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
      userId: alice.id
    }
  });
  const folder = await prisma.folder.create({ data: { name: "alice-folder", userId: alice.id } });
  const created = await app.inject({
    method: "POST",
    url: "/upload-sessions",
    headers: auth(alice),
    payload: { originalName: "alice-upload.bin", mimeType: "application/octet-stream", expectedSize: 8 }
  });
  assert.equal(created.statusCode, 201, created.body);
  const session = created.json().session;

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.downloadToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.uploadPart.deleteMany({ where: { sessionId: session.id } });
    await prisma.uploadSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.file.deleteMany({ where: { userId: { in: ids } } });
    await prisma.folder.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  return { app, storage, plan, alice, bob, admin, suspended, deleted, auth, file, folder, session, bytes, storedName };
}

function ownedObjectRequests(f) {
  const part = multipartBody(Buffer.from("evil"));
  const make = (id) => ({
    deleteFile: { method: "DELETE", url: `/files/${id.file}` },
    downloadToken: { method: "POST", url: `/files/${id.file}/download-token` },
    downloadCaps: { method: "GET", url: `/files/${id.file}/download-capabilities` },
    renameFolder: { method: "PATCH", url: `/folders/${id.folder}`, payload: { name: "pwned" } },
    deleteFolder: { method: "DELETE", url: `/folders/${id.folder}` },
    getSession: { method: "GET", url: `/upload-sessions/${id.session}` },
    putPart: {
      method: "PUT",
      url: `/upload-sessions/${id.session}/parts/0`,
      payload: part.payload,
      headers: { "content-type": part.contentType, "content-range": "bytes 0-3/8" }
    },
    completeSession: { method: "POST", url: `/upload-sessions/${id.session}/complete` },
    abortSession: { method: "DELETE", url: `/upload-sessions/${id.session}` }
  });
  return {
    foreign: make({ file: f.file.id, folder: f.folder.id, session: f.session.id }),
    unknown: make({ file: UNKNOWN_ID, folder: UNKNOWN_ID, session: UNKNOWN_ID })
  };
}

test("a second tenant cannot read, mutate, complete, abort or mint access to another tenant's objects", async (t) => {
  const f = await fixture(t);
  const { foreign, unknown } = ownedObjectRequests(f);
  const bobHeaders = f.auth(f.bob);

  for (const name of Object.keys(foreign)) {
    const attempt = await f.app.inject({
      ...foreign[name],
      headers: { ...(foreign[name].headers || {}), ...bobHeaders }
    });
    const probe = await f.app.inject({
      ...unknown[name],
      headers: { ...(unknown[name].headers || {}), ...bobHeaders }
    });
    assert.equal(attempt.statusCode, 404, `${name}: expected 404, got ${attempt.statusCode} ${attempt.body}`);
    // Cross-tenant IDs must be indistinguishable from nonexistent IDs.
    assert.equal(attempt.statusCode, probe.statusCode, `${name}: status differs from unknown id`);
    assert.equal(attempt.body, probe.body, `${name}: body differs from unknown id`);
    for (const secret of [f.file.originalName, f.folder.name, f.session.originalName, f.alice.email]) {
      assert.ok(!attempt.body.includes(secret), `${name}: response leaked ${secret}`);
    }
  }

  // Forbidden operations left every piece of state and byte untouched.
  const file = await prisma.file.findUnique({ where: { id: f.file.id } });
  assert.equal(file.status, "ACTIVE");
  assert.deepEqual(await fs.readFile(f.storage.resolve(f.storedName)), f.bytes);
  assert.equal((await prisma.folder.findUnique({ where: { id: f.folder.id } })).name, "alice-folder");
  const session = await prisma.uploadSession.findUnique({ where: { id: f.session.id } });
  assert.equal(session.status, "UPLOADING");
  assert.equal(await prisma.uploadPart.count({ where: { sessionId: f.session.id } }), 0);
  const alice = await prisma.user.findUnique({ where: { id: f.alice.id } });
  assert.equal(alice.storageUsed, 11n);
  assert.equal(alice.reservedUploadBytes, 8n);
  assert.equal(await prisma.downloadToken.count({ where: { fileId: f.file.id } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { userId: f.bob.id } }), 0);
  const leftover = await fs.readdir(f.storage.resolveUploadSession(f.session.id)).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  assert.deepEqual(leftover, [], "a foreign part upload must not write bytes");

  // Sanity: the rightful owner still succeeds, so the 404s above are ownership
  // decisions rather than broken routes.
  const ownerCaps = await f.app.inject({
    method: "GET",
    url: `/files/${f.file.id}/download-capabilities`,
    headers: f.auth(f.alice)
  });
  assert.equal(ownerCaps.statusCode, 200, ownerCaps.body);
});

test("listings, quota and plan changes are isolated per tenant", async (t) => {
  const f = await fixture(t);
  const bobHeaders = f.auth(f.bob);

  const files = await f.app.inject({ method: "GET", url: "/files?search=alice", headers: bobHeaders });
  assert.equal(files.statusCode, 200, files.body);
  assert.ok(!files.body.includes(f.file.id) && !files.body.includes(f.file.originalName));
  const cursorFiles = await f.app.inject({ method: "GET", url: "/files?pagination=cursor", headers: bobHeaders });
  assert.ok(!cursorFiles.body.includes(f.file.id));

  const folders = await f.app.inject({ method: "GET", url: "/folders", headers: bobHeaders });
  assert.ok(!folders.body.includes(f.folder.id));
  const cursorFolders = await f.app.inject({ method: "GET", url: "/folders?pagination=cursor", headers: bobHeaders });
  assert.ok(!cursorFolders.body.includes(f.folder.id));

  const bobQuota = await f.app.inject({ method: "GET", url: "/quota", headers: bobHeaders });
  assert.equal(bobQuota.statusCode, 200);
  assert.equal(bobQuota.json().quota.storageUsed, "0");

  // Subscribing as Bob changes only Bob.
  const otherPlan = await prisma.plan.create({
    data: { name: `authz-other-${crypto.randomUUID()}`, priceMonthly: 1, storageLimit: 5000n }
  });
  const switched = await f.app.inject({
    method: "PATCH",
    url: `/plans/${otherPlan.id}/subscribe`,
    headers: bobHeaders
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal((await prisma.user.findUnique({ where: { id: f.alice.id } })).planId, f.plan.id);
  await prisma.auditLog.deleteMany({ where: { userId: f.bob.id } });
  await prisma.user.update({ where: { id: f.bob.id }, data: { planId: f.plan.id } });
  await prisma.plan.delete({ where: { id: otherPlan.id } });

  // A client cannot supply someone else's id to act on another account.
  const spoof = await f.app.inject({
    method: "GET",
    url: `/quota?userId=${f.alice.id}`,
    headers: bobHeaders
  });
  assert.equal(spoof.json().quota.storageUsed, "0");
});

test("admin routes reject ordinary accounts, including forged role claims", async (t) => {
  const f = await fixture(t);
  const adminRoutes = [
    { method: "GET", url: "/admin/users" },
    { method: "GET", url: "/admin/storage-report" },
    { method: "GET", url: "/admin/audit-logs" },
    { method: "GET", url: "/metrics" },
    { method: "PATCH", url: `/admin/users/${f.alice.id}/suspend` },
    { method: "PATCH", url: `/admin/users/${f.alice.id}/reactivate` },
    { method: "DELETE", url: `/admin/users/${f.alice.id}` }
  ];
  const variants = {
    ordinary: f.auth(f.bob),
    "forged role claim": f.auth(f.bob, { role: "ADMIN" }),
    "forged status claim": f.auth(f.bob, { role: "ADMIN", status: "ACTIVE" })
  };

  for (const [label, headers] of Object.entries(variants)) {
    for (const route of adminRoutes) {
      const res = await f.app.inject({ ...route, headers });
      assert.equal(res.statusCode, 403, `${label} ${route.method} ${route.url}: ${res.statusCode} ${res.body}`);
    }
  }
  assert.equal((await prisma.user.findUnique({ where: { id: f.alice.id } })).status, "ACTIVE");
  assert.equal(await prisma.auditLog.count({ where: { userId: f.bob.id } }), 0);

  // A syntactically valid JWT signed with a different secret never authenticates.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: f.admin.id, role: "ADMIN" })}`;
  const signature = crypto.createHmac("sha256", "wrong-secret").update(unsigned).digest("base64url");
  const forged = await f.app.inject({
    method: "GET",
    url: "/admin/users",
    headers: { authorization: `Bearer ${unsigned}.${signature}` }
  });
  assert.equal(forged.statusCode, 401);
  const noneAlg = `${b64({ alg: "none", typ: "JWT" })}.${b64({ id: f.admin.id, role: "ADMIN" })}.`;
  const none = await f.app.inject({ method: "GET", url: "/admin/users", headers: { authorization: `Bearer ${noneAlg}` } });
  assert.equal(none.statusCode, 401);

  // The real admin is allowed, so the 403s above are role decisions.
  const allowed = await f.app.inject({ method: "GET", url: "/admin/storage-report", headers: f.auth(f.admin) });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("suspended, deleted, unknown and unauthenticated callers are blocked everywhere", async (t) => {
  const f = await fixture(t);
  const probes = [
    { method: "GET", url: "/me" },
    { method: "GET", url: "/files" },
    { method: "GET", url: "/quota" },
    { method: "POST", url: "/folders", payload: { name: "x" } },
    { method: "DELETE", url: `/files/${f.file.id}` },
    { method: "GET", url: `/upload-sessions/${f.session.id}` },
    { method: "POST", url: "/upload-sessions", payload: { originalName: "a", mimeType: "a/b", expectedSize: 1 } }
  ];

  for (const [who, user] of [["suspended", f.suspended], ["deleted", f.deleted]]) {
    await cache.del("auth-user", user.id);
    for (const probe of probes) {
      const res = await f.app.inject({ ...probe, headers: f.auth(user) });
      assert.equal(res.statusCode, 403, `${who} ${probe.method} ${probe.url}: ${res.statusCode}`);
    }
  }
  assert.equal(await prisma.folder.count({ where: { userId: { in: [f.suspended.id, f.deleted.id] } } }), 0);
  assert.equal(await prisma.uploadSession.count({ where: { userId: { in: [f.suspended.id, f.deleted.id] } } }), 0);

  const ghost = await f.app.inject({
    method: "GET",
    url: "/me",
    headers: { authorization: `Bearer ${f.app.jwt.sign({ id: "no-such-user" })}` }
  });
  assert.equal(ghost.statusCode, 401);
  for (const probe of probes) {
    const anonymous = await f.app.inject(probe);
    assert.equal(anonymous.statusCode, 401, `anonymous ${probe.method} ${probe.url}`);
    const garbage = await f.app.inject({ ...probe, headers: { authorization: "Bearer not-a-jwt" } });
    assert.equal(garbage.statusCode, 401, `garbage ${probe.method} ${probe.url}`);
  }
});

test("every registered route except the explicit public allowlist requires authentication", async (t) => {
  const f = await fixture(t);
  const paths = f.app.swagger().paths;
  const checked = [];

  for (const [route, operations] of Object.entries(paths)) {
    for (const method of Object.keys(operations)) {
      const key = `${method.toUpperCase()} ${route}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      const res = await f.app.inject(anonymousRequestFor(method.toUpperCase(), route));
      assert.equal(res.statusCode, 401, `${key} must require authentication, got ${res.statusCode}`);
      checked.push(key);
    }
  }
  // Guard against the enumeration silently checking nothing.
  assert.ok(checked.length >= 20, `only ${checked.length} protected routes enumerated`);
  assert.ok(checked.includes("PUT /upload-sessions/{id}/parts/{partNumber}"));
});

test("concurrent owner deletion and foreign deletion remove the file and charge quota exactly once", async (t) => {
  const f = await fixture(t);
  const [owner, stranger] = await Promise.all([
    f.app.inject({ method: "DELETE", url: `/files/${f.file.id}`, headers: f.auth(f.alice) }),
    f.app.inject({ method: "DELETE", url: `/files/${f.file.id}`, headers: f.auth(f.bob) })
  ]);
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(stranger.statusCode, 404);

  const alice = await prisma.user.findUnique({ where: { id: f.alice.id } });
  assert.equal(alice.storageUsed, 0n, "quota must be decremented exactly once, by the owner's delete");
  const bob = await prisma.user.findUnique({ where: { id: f.bob.id } });
  assert.equal(bob.storageUsed, 0n);
  assert.equal((await prisma.file.findUnique({ where: { id: f.file.id } })).status, "DELETED");
});
