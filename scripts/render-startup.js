"use strict";

// Render Free has no pre-deploy command. This explicit service-only fallback
// applies additive migrations before opening the API port. It is never enabled
// for ordinary development/CI/paid-platform starts unless deliberately opted in.
const { spawnSync } = require("node:child_process");

function enabled(env) {
  return env.VAULTBOX_RENDER_FREE_MODE === "1";
}
function validate(env) {
  if (!enabled(env)) return false;
  if (env.RENDER !== "true" || env.RENDER_SERVICE_TYPE !== "web" ||
      env.NODE_ENV !== "production") {
    throw new Error("VAULTBOX_RENDER_FREE_MODE requires a production Render web service");
  }
  if (!env.DATABASE_URL) throw new Error("Render Free bootstrap requires DATABASE_URL");
  return true;
}
function execute(env = process.env, spawn = spawnSync, cli = () => require.resolve("prisma/build/index.js")) {
  if (!validate(env)) return false;
  // Prisma migrate deploy uses the database migration advisory lock and
  // applies only pending committed migrations. It fails closed on errors.
  // No npx resolution, network package installation, or schema push.
  const result = spawn(process.execPath, [cli(), "migrate", "deploy"], {
    stdio: "inherit", env, timeout: 300000, windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Render Free migration failed (exit " + result.status + ")");
  return true;
}
if (require.main === module) {
  try { execute(); } catch (error) {
    console.error("Render Free startup preparation failed:", error.message);
    process.exitCode = 1;
  }
}
module.exports = { enabled, validate, execute };
