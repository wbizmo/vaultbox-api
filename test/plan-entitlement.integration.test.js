const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { switchPlanIfEntitled, verifyWebhookSignature } = require("../src/lib/entitlements");

const SECRET = "whsec_test_secret_that_is_long_enough_for_hmac";

const baseConfig = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "plan-entitlement-test-secret-long-enough",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4,
  billingWebhookSecret: SECRET,
  billingWebhookToleranceSeconds: 300
};

function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, header: `t=${timestamp},v1=${mac}` };
}

async function fixture(t, configOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-entitlement-"));
  const storage = new LocalStorageAdapter(root);
  const tag = crypto.randomUUID();
  const free = await prisma.plan.create({ data: { name: `ent-free-${tag}`, priceMonthly: 0, storageLimit: 1000n } });
  const paid = await prisma.plan.create({ data: { name: `ent-paid-${tag}`, priceMonthly: 5, storageLimit: 100000n } });
  const user = await prisma.user.create({
    data: { name: "Ent User", email: `ent-${tag}@example.com`, password: "not-used", planId: free.id }
  });
  const app = buildApp({ config: { ...baseConfig, ...configOverrides }, storage, logger: false });
  await app.ready();

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.planEntitlement.deleteMany({ where: { userId: user.id } });
    await prisma.billingEvent.deleteMany({ where: { id: { startsWith: `evt-${tag}` } } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: { in: [free.id, paid.id] } } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${app.jwt.sign({ id: user.id })}` };
  const subscribe = (plan) => app.inject({ method: "PATCH", url: `/plans/${plan.id}/subscribe`, headers: auth });
  const webhook = (body, signing = {}) => {
    const { raw, header } = sign(body, signing);
    return app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", "x-vaultbox-signature": header },
      payload: raw
    });
  };
  const event = (type, extra = {}) => ({
    eventId: `evt-${tag}-${crypto.randomUUID()}`,
    type,
    userId: user.id,
    planId: paid.id,
    ...extra
  });
  const currentPlan = async () => (await prisma.user.findUnique({ where: { id: user.id } })).planId;

  return { app, tag, free, paid, user, auth, subscribe, webhook, event, currentPlan };
}

test("a user without an entitlement cannot self-select a paid plan; free plans stay self-service", async (t) => {
  const f = await fixture(t);

  const denied = await f.subscribe(f.paid);
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(await f.currentPlan(), f.free.id);

  const free = await f.subscribe(f.free);
  assert.equal(free.statusCode, 200, free.body);
});

test("a signed grant enables the paid tier and its quota; unrelated entitlements do not", async (t) => {
  const f = await fixture(t);
  const other = await prisma.plan.create({
    data: { name: `ent-other-${f.tag}`, priceMonthly: 9, storageLimit: 5000n }
  });
  t.after(async () => {
    await prisma.planEntitlement.deleteMany({ where: { planId: other.id } });
    await prisma.plan.delete({ where: { id: other.id } });
  });

  const granted = await f.webhook(f.event("entitlement.granted"));
  assert.equal(granted.statusCode, 200, granted.body);

  const ok = await f.subscribe(f.paid);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await f.currentPlan(), f.paid.id);
  const quota = await f.app.inject({ method: "GET", url: "/quota", headers: f.auth });
  assert.equal(quota.json().quota.storageLimit, "100000");

  // The grant was for one plan only.
  await f.subscribe(f.free);
  const wrongPlan = await f.subscribe(other);
  assert.equal(wrongPlan.statusCode, 403, wrongPlan.body);
});

test("webhooks reject missing, forged, tampered, stale and unconfigured signatures", async (t) => {
  const f = await fixture(t);
  const body = f.event("entitlement.granted");
  const json = JSON.stringify(body);
  const post = (headers, payload = json) =>
    f.app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...headers },
      payload
    });

  assert.equal((await post({})).statusCode, 401);
  assert.equal((await post({ "x-vaultbox-signature": "garbage" })).statusCode, 401);
  assert.equal((await post({ "x-vaultbox-signature": sign(json, { secret: "wrong-secret" }).header })).statusCode, 401);
  const stale = sign(json, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await post({ "x-vaultbox-signature": stale.header })).statusCode, 401);
  // A valid signature for a different body must not authenticate this one.
  const tampered = sign(JSON.stringify({ ...body, userId: "someone-else" }));
  assert.equal((await post({ "x-vaultbox-signature": tampered.header })).statusCode, 401);
  // A user-supplied bearer token is not accepted in place of the signature.
  assert.equal((await post({ authorization: f.auth.authorization })).statusCode, 401);

  assert.equal(await prisma.planEntitlement.count({ where: { userId: f.user.id } }), 0);
  assert.equal(await prisma.billingEvent.count({ where: { id: body.eventId } }), 0);
  assert.equal((await f.subscribe(f.paid)).statusCode, 403);

  const unconfigured = await fixture(t, { billingWebhookSecret: "" });
  const disabled = await unconfigured.webhook(unconfigured.event("entitlement.granted"));
  assert.equal(disabled.statusCode, 503);
  assert.equal(await prisma.planEntitlement.count({ where: { userId: unconfigured.user.id } }), 0);

  assert.equal(verifyWebhookSignature({ secret: SECRET, header: undefined, rawBody: json, toleranceSeconds: 300 }), false);
});

test("replayed events are idempotent, including concurrent duplicates, and id reuse with a different payload conflicts", async (t) => {
  const f = await fixture(t);
  const grant = f.event("entitlement.granted");

  const results = await Promise.all(Array.from({ length: 5 }, () => f.webhook(grant)));
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200, 200, 200]);
  assert.equal(results.filter((r) => r.json().replayed === false).length, 1, "exactly one delivery applies");
  assert.equal(await prisma.planEntitlement.count({ where: { userId: f.user.id } }), 1);

  const conflict = await f.webhook({ ...grant, planId: f.free.id });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(await prisma.planEntitlement.count({ where: { userId: f.user.id } }), 1);

  const unknownUser = await f.webhook({ ...f.event("entitlement.granted"), userId: "no-such-user" });
  assert.equal(unknownUser.statusCode, 404);
  const unknownPlan = await f.webhook({ ...f.event("entitlement.granted"), planId: "no-such-plan" });
  assert.equal(unknownPlan.statusCode, 404);

  const malformed = await f.webhook({ eventId: "x", type: "entitlement.granted" });
  assert.equal(malformed.statusCode, 400);
});

test("expired entitlements do not allow selecting the plan", async (t) => {
  const f = await fixture(t);
  const expired = await f.webhook(
    f.event("entitlement.granted", { validUntil: new Date(Date.now() - 60_000).toISOString() })
  );
  assert.equal(expired.statusCode, 200, expired.body);
  assert.equal((await f.subscribe(f.paid)).statusCode, 403);

  const valid = await f.webhook(
    f.event("entitlement.granted", { validUntil: new Date(Date.now() + 3_600_000).toISOString() })
  );
  assert.equal(valid.statusCode, 200);
  assert.equal((await f.subscribe(f.paid)).statusCode, 200);
});

test("revocation blocks re-selection and downgrades when usage fits; otherwise the user keeps data in a grace state", async (t) => {
  const f = await fixture(t);
  await f.webhook(f.event("entitlement.granted"));
  assert.equal((await f.subscribe(f.paid)).statusCode, 200);

  const revoked = await f.webhook(f.event("entitlement.revoked", { fallbackPlanId: f.free.id }));
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().downgraded, true);
  assert.equal(await f.currentPlan(), f.free.id);
  assert.equal((await f.subscribe(f.paid)).statusCode, 403, "revoked entitlement cannot be reused");

  // Grace: usage above the free limit keeps the plan, never deletes or hides data.
  await f.webhook(f.event("entitlement.granted"));
  assert.equal((await f.subscribe(f.paid)).statusCode, 200);
  await prisma.user.update({ where: { id: f.user.id }, data: { storageUsed: 5000n } });
  const grace = await f.webhook(f.event("entitlement.revoked", { fallbackPlanId: f.free.id }));
  assert.equal(grace.statusCode, 200, grace.body);
  assert.equal(grace.json().downgraded, false);
  const user = await prisma.user.findUnique({ where: { id: f.user.id } });
  assert.equal(user.planId, f.paid.id);
  assert.equal(user.storageUsed, 5000n);
  assert.equal((await f.subscribe(f.paid)).statusCode, 403, "no new activation while revoked");
});

test("a revocation in flight cannot be raced by a concurrent subscribe", async (t) => {
  const f = await fixture(t);
  await f.webhook(f.event("entitlement.granted"));

  // Interleaving: a revocation transaction has locked the user and flipped the
  // entitlement but not committed. A subscribe that began meanwhile must wait
  // for it and then observe the revoked state instead of the stale ACTIVE row.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let locked;
  const lockedSignal = new Promise((resolve) => { locked = resolve; });
  const revocation = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR UPDATE`;
    await tx.planEntitlement.updateMany({
      where: { userId: f.user.id, planId: f.paid.id },
      data: { status: "REVOKED", revokedAt: new Date() }
    });
    locked();
    await gate;
  });
  await lockedSignal;

  let settled = false;
  const subscribing = switchPlanIfEntitled(f.user.id, f.paid.id).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, "subscribe must block on the user lock held by the revocation");

  release();
  await revocation;
  assert.equal(await subscribing, null, "subscribe must see the committed revocation");
  assert.equal(await f.currentPlan(), f.free.id);
});

test("PLAN_SWITCH_MODE=demo is explicit and the secure mode is the default", async (t) => {
  const { getConfig } = require("../src/config/env");
  const saved = process.env.PLAN_SWITCH_MODE;
  t.after(() => {
    if (saved === undefined) delete process.env.PLAN_SWITCH_MODE;
    else process.env.PLAN_SWITCH_MODE = saved;
  });
  delete process.env.PLAN_SWITCH_MODE;
  assert.equal(getConfig().planSwitchMode, "entitled");
  process.env.PLAN_SWITCH_MODE = "anything-else";
  assert.equal(getConfig().planSwitchMode, "entitled");
  process.env.PLAN_SWITCH_MODE = "demo";
  assert.equal(getConfig().planSwitchMode, "demo");

  const demo = await fixture(t, { planSwitchMode: "demo" });
  assert.equal((await demo.subscribe(demo.paid)).statusCode, 200, "demo mode keeps the legacy self-service behavior");
  assert.equal(await demo.currentPlan(), demo.paid.id);

  // A config that does not mention the mode behaves as the secure default.
  const secure = await fixture(t);
  assert.equal((await secure.subscribe(secure.paid)).statusCode, 403);
});
