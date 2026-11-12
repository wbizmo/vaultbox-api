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

// Regression: the pinned Swagger UI initializer resolves './json' against
// window.location.href. A tracking query on /docs used to turn the spec URL
// into /docs?utm_source=chatgpt.com/./json (not a valid OpenAPI document).
test("Swagger docs index strips tracking queries before resolving the spec URL", async (t) => {
  const app = createApp();
  t.after(() => app.close());

  for (const url of [
    "/docs?utm_source=chatgpt.com",
    "/docs/?utm_source=chatgpt.com",
    "/docs?utm_campaign=release&source=partner",
    "/docs/?url=https%3A%2F%2Fexample.invalid%2Ffake.json"
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 302, url);
    assert.equal(response.headers.location, "/docs/", url);
  }

  const ui = await app.inject({ method: "GET", url: "/docs/" });
  assert.equal(ui.statusCode, 200);
  assert.match(ui.headers["content-type"], /text\/html/);
  assert.match(ui.body, /swagger-initializer\.js/);
});

test("Swagger UI canonicalization does not change valid JSON/YAML specs or assets", async (t) => {
  const app = createApp();
  t.after(() => app.close());

  for (const url of ["/docs/json", "/docs/json?utm_source=chatgpt.com"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers["content-type"], /application\/json/);
    const spec = response.json();
    assert.equal(spec.openapi, "3.0.3");
    assert.equal(spec.info.version, version);
    assert.ok(spec.paths["/files"], "File API paths remain documented");
  }

  const yaml = await app.inject({ method: "GET", url: "/docs/yaml?utm_source=chatgpt.com" });
  assert.equal(yaml.statusCode, 200);
  assert.match(yaml.body, /openapi: 3\.0\.3/);

  const initializer = await app.inject({
    method: "GET",
    url: "/docs/static/swagger-initializer.js?utm_source=chatgpt.com"
  });
  assert.equal(initializer.statusCode, 200);
  assert.match(initializer.body, /SwaggerUIBundle/);
});
