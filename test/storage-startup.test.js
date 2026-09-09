const test = require("node:test");
const assert = require("node:assert/strict");

const buildApp = require("../src/app");

const config = {
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "test-secret-long-enough-for-jwt-signing",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

test("storage readiness runs once for the application lifecycle", async (t) => {
  let readyCalls = 0;
  const storage = {
    ready: async () => { readyCalls += 1; }
  };
  const app = buildApp({ config, storage, logger: false });
  t.after(() => app.close());

  await app.ready();
  await app.ready();
  assert.equal(readyCalls, 1);
  assert.equal(app.vaultboxStorage, storage);
});

test("storage initialization failure fails application readiness", async () => {
  const storage = {
    ready: async () => { throw new Error("storage unavailable"); }
  };
  const app = buildApp({ config, storage, logger: false });

  await assert.rejects(app.ready(), /storage unavailable/);
  await app.close().catch(() => {});
});
