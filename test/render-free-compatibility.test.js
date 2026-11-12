"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const build = require("../scripts/render-install");
const startup = require("../scripts/render-startup");
const renderEnv = Object.freeze({
  RENDER: "true", RENDER_SERVICE_TYPE: "web",
  NODE_ENV: "production", DATABASE_URL: "postgresql://test.invalid/test",
  VAULTBOX_RENDER_FREE_MODE: "1"
});

test("Render install hook skips local, GitHub CI and other service types", () => {
  for (const env of [{}, { CI: "true" }, { RENDER: "true", RENDER_SERVICE_TYPE: "worker" }]) {
    assert.equal(build.execute(env, () => { throw new Error("spawned outside Render web"); }), false);
  }
});

test("Render install hook generates pinned Prisma client and verifies deploy artifact", () => {
  const calls = [];
  assert.equal(build.execute(renderEnv, (cmd, args, opt) => {
    calls.push({ cmd, args, opt });
    return { status: 0 };
  }, () => "/pinned/prisma/build/index.js"), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["/pinned/prisma/build/index.js", "generate"]);
  assert.equal(path.basename(calls[1].args[0]), "verify-build.js");
  assert.ok(calls.every(call => call.cmd === process.execPath && call.opt.stdio === "inherit"));
});

test("Render install hook fails closed on Prisma and build verifier errors", () => {
  assert.throws(() => build.execute(renderEnv, () => ({ status: 17 }), () => "/pinned/prisma"),
    /build validation failed/);
  assert.throws(() => build.execute(renderEnv, () => ({ error: new Error("missing generator") }),
    () => "/pinned/prisma"), /missing generator/);
});

test("free migration opt-in is disabled everywhere by default", () => {
  assert.equal(startup.execute({ ...renderEnv, VAULTBOX_RENDER_FREE_MODE: "0" },
    () => { throw new Error("unexpected migration"); }), false);
  assert.equal(startup.execute({ DATABASE_URL: "postgresql://test.invalid" },
    () => { throw new Error("unexpected migration"); }), false);
});

test("free migration opt-in rejects non-production and non-Render invocation", () => {
  for (const fields of [{ RENDER: undefined }, { RENDER_SERVICE_TYPE: "worker" },
    { NODE_ENV: "test" }, { DATABASE_URL: undefined }]) {
    assert.throws(() => startup.execute({ ...renderEnv, ...fields },
      () => { throw new Error("unexpected migration"); }), /Render Free bootstrap|production Render/);
  }
});

test("free migration uses installed Prisma CLI, existing env and bounded execution", () => {
  const calls = [];
  assert.equal(startup.execute(renderEnv, (cmd, args, opt) => {
    calls.push({ cmd, args, opt });
    return { status: 0 };
  }, () => "/pinned/prisma/build/index.js"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ["/pinned/prisma/build/index.js", "migrate", "deploy"]);
  assert.equal(calls[0].opt.env, renderEnv);
  assert.equal(calls[0].opt.timeout, 300000);
});

test("failed migration prevents API startup and reports the failure", () => {
  assert.throws(() => startup.execute(renderEnv, () => ({ status: 1 }), () => "/pinned/prisma"),
    /migration failed/);
  assert.throws(() => startup.execute(renderEnv, () => ({ error: new Error("timeout") }),
    () => "/pinned/prisma"), /timeout/);
});
