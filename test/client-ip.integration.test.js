const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { clientIp, PRODUCTION_DEFAULT } = require("../src/lib/client-ip");

/*
 * Issue #47: the client identity used by throttles, audit logs and request logs comes from the trusted
 * proxy chain only. Every case drives a real Fastify instance through app.inject with an explicit
 * connection address (remoteAddress) and X-Forwarded-For, exactly what a reverse proxy would present.
 */

const JWT_SECRET = "client-ip-secret-long-enough-for-tests";
const unique = () => crypto.randomUUID().slice(0, 8);
const baseConfig = { nodeEnv: "test", isProduction: false, corsOrigins: [], jwtSecret: JWT_SECRET, jwtExpiresIn: "1h" };

async function appWith(t, trustProxy) {
  const app = buildApp({ logger: false, config: { ...baseConfig, trustProxy } });
  app.get("/__ip", async (request) => ({ clientIp: clientIp(request), raw: request.ip }));
  await app.ready();
  t.after(() => app.close());
  return app;
}

const ask = async (app, remoteAddress, forwardedFor) => (await app.inject({
  method: "GET",
  url: "/__ip",
  remoteAddress,
  headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }
})).json().clientIp;

test("no trusted proxy (the test/dev default): forged X-Forwarded-For never changes the identity", async (t) => {
  const app = await appWith(t, false);
  assert.equal(await ask(app, "198.51.100.9", "1.1.1.1"), "198.51.100.9");
  assert.equal(await ask(app, "198.51.100.9", "1.1.1.1, 2.2.2.2, 3.3.3.3"), "198.51.100.9");
  assert.equal(await ask(app, "10.1.1.1", "203.0.113.7"), "10.1.1.1", "even a private peer is not believed unless configured");
});

test("production default (private-network ingress): the client is the first untrusted address from the connection", async (t) => {
  const app = await appWith(t, PRODUCTION_DEFAULT);

  // The ingress proxy (private address) appended the real client; whatever the client forged is further left.
  assert.equal(await ask(app, "10.1.1.1", "9.9.9.9, 203.0.113.7"), "203.0.113.7");
  assert.equal(await ask(app, "10.1.1.1", "203.0.113.7"), "203.0.113.7");
  // Several internal hops are skipped.
  assert.equal(await ask(app, "10.1.1.1", "203.0.113.7, 10.2.2.2, 172.20.0.3"), "203.0.113.7");
  // The client forges private addresses to look internal: still resolved to the address the proxy saw.
  assert.equal(await ask(app, "10.1.1.1", "10.9.9.9, 192.168.0.1, 203.0.113.7"), "203.0.113.7");
  // A direct (public) connection is never believed, whatever headers it carries.
  assert.equal(await ask(app, "198.51.100.9", "1.1.1.1"), "198.51.100.9");
  assert.equal(await ask(app, "198.51.100.9", "10.0.0.1, 203.0.113.7"), "198.51.100.9");
  // No header at all behind a proxy: the connection itself.
  assert.equal(await ask(app, "10.1.1.1"), "10.1.1.1");
  // IPv6 and IPv4-mapped peers.
  assert.equal(await ask(app, "::ffff:10.1.1.1", "2001:db8::5"), "2001:db8::5");
  assert.equal(await ask(app, "fd00::1", "2001:db8::6, 198.51.100.77"), "198.51.100.77");
});

test("an explicit chain (edge network in front of the private ingress) resolves to the real client", async (t) => {
  const withoutEdge = await appWith(t, PRODUCTION_DEFAULT);
  const withEdge = await appWith(t, [...PRODUCTION_DEFAULT, "198.51.100.0/24"]);

  const header = "9.9.9.9, 203.0.113.7, 198.51.100.20";
  // The edge's public address is not trusted by the default, so the edge looks like "the client" (safe but coarse).
  assert.equal(await ask(withoutEdge, "10.1.1.1", header), "198.51.100.20");
  // Declaring the edge range yields the true client, and the forged leftmost entry is still ignored.
  assert.equal(await ask(withEdge, "10.1.1.1", header), "203.0.113.7");
  // The edge range is only believed when it is the connection's neighbour chain, not from a stranger.
  assert.equal(await ask(withEdge, "192.0.2.50", header), "192.0.2.50");
});

test("malformed forwarded headers never become an identity", async (t) => {
  const app = await appWith(t, PRODUCTION_DEFAULT);
  for (const header of ["not-an-ip", "'; DROP TABLE \"AuditLog\";--", "999.999.999.999", ",,,", "  ", "1.2.3.4:80"]) {
    const identity = await ask(app, "10.1.1.1", header);
    assert.equal(identity, "10.1.1.1", `malformed ${JSON.stringify(header)} falls back to the connection address`);
  }
  // A malformed entry left of the real client is irrelevant.
  assert.equal(await ask(app, "10.1.1.1", "garbage, 203.0.113.7"), "203.0.113.7");
});

test("throttles and audit logs use the same derived identity; a forged header cannot rotate the bucket", async (t) => {
  const app = buildApp({ logger: false, config: { ...baseConfig, trustProxy: PRODUCTION_DEFAULT } });
  await app.ready();
  const plan = await prisma.plan.create({ data: { name: `cip-${unique()}`, priceMonthly: 0, storageLimit: 1000n } });
  const password = "Correct-Horse-1234";
  const user = await prisma.user.create({
    data: { name: "Cip", email: `cip-${unique()}@example.com`, password: await bcrypt.hash(password, 4), planId: plan.id }
  });
  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await prisma.$executeRaw`DELETE FROM "RateLimitWindow" WHERE "expiresAt" < NOW() + INTERVAL '1 hour' AND "key" LIKE 'login%'`;
  });

  // A client address nobody else uses (random IPv6 inside the documentation prefix).
  const word = () => crypto.randomBytes(2).toString("hex");
  const real = `2001:db8:${word()}:${word()}::${word()}`;
  const other = `2001:db8:${word()}:${word()}::${word()}`;
  const attempt = (email, forged, realClient, pass = "wrong-Password-1") => app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: "10.1.1.1",
    headers: { "x-forwarded-for": `${forged}, ${realClient}` },
    payload: { email, password: pass }
  });

  // Rotating a forged leftmost entry on every attempt must not escape the (address, account) limit of 10.
  const codes = [];
  for (let i = 0; i < 13; i += 1) codes.push((await attempt(user.email, `198.51.100.${i + 1}`, real)).statusCode);
  assert.equal(codes.filter((code) => code === 401).length, 10, codes.join(","));
  assert.equal(codes.filter((code) => code === 429).length, 3, codes.join(","));

  // A genuinely different client has its own bucket.
  assert.equal((await attempt(user.email, "198.51.100.1", other)).statusCode, 401);

  // The audit record of a successful login stores the SAME derived address, not the forged one.
  const ok = await attempt(user.email, "198.51.100.200", other, password);
  assert.equal(ok.statusCode, 200, ok.body);
  const audit = await prisma.auditLog.findFirst({ where: { userId: user.id, action: "LOGIN" }, orderBy: { createdAt: "desc" } });
  assert.equal(audit.ip, other);
  assert.notEqual(audit.ip, "198.51.100.200");
});

test("admin diagnostics show how the identity was derived; ordinary users cannot read them", async (t) => {
  const app = buildApp({ logger: false, config: { ...baseConfig, trustProxy: PRODUCTION_DEFAULT, trustProxySource: "default" } });
  await app.ready();
  const plan = await prisma.plan.create({ data: { name: `cipd-${unique()}`, priceMonthly: 0, storageLimit: 1000n } });
  const admin = await prisma.user.create({ data: { name: "A", email: `cipa-${unique()}@example.com`, password: "x", role: "ADMIN", planId: plan.id } });
  const member = await prisma.user.create({ data: { name: "M", email: `cipm-${unique()}@example.com`, password: "x", planId: plan.id } });
  t.after(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });

  const call = (user, forwardedFor) => app.inject({
    method: "GET",
    url: "/admin/network-diagnostics",
    remoteAddress: "10.1.1.1",
    headers: { authorization: `Bearer ${app.jwt.sign({ id: user.id, av: 0 })}`, "x-forwarded-for": forwardedFor }
  });

  const response = await call(admin, "9.9.9.9, 203.0.113.7");
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.clientIp, "203.0.113.7");
  assert.equal(body.socketAddress, "10.1.1.1");
  assert.equal(body.forwardedFor, "9.9.9.9, 203.0.113.7");
  assert.equal(body.trustProxy.policy, PRODUCTION_DEFAULT.join(","));
  assert.equal(body.trustProxy.source, "default");

  const denied = await call(member, "203.0.113.7");
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.body.includes("socketAddress"));
});
