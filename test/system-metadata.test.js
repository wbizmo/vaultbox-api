const test = require("node:test");
const assert = require("node:assert/strict");

const buildApp = require("../src/app");
const { version } = require("../package.json");

const config = {
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "test-secret-long-enough-for-jwt-signing",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 1024,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 100,
  uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

function createApp() {
  return buildApp({
    config,
    logger: false,
    storage: { ready: async () => {} }
  });
}

test("root metadata uses the package version", async (t) => {
  const app = createApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    name: "VaultBox API",
    version,
    status: "operational",
    docs: "/docs",
    health: "/health"
  });
});

test("health metadata uses the package version", async (t) => {
  const app = createApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, version);
  assert.equal(response.json().service, "vaultbox-api");
  assert.equal(response.json().status, "ok");
});
