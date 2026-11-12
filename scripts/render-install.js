"use strict";

// The existing Render Free build command is "npm install --omit=dev".
// Ensure generated Prisma code exists without requiring TypeScript/dev tools,
// package-registry access at startup, or a paid Render pre-deploy hook.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function enabled(env) {
  return env.RENDER === "true" && env.RENDER_SERVICE_TYPE === "web";
}
function execute(env = process.env, spawn = spawnSync, cli = () => require.resolve("prisma/build/index.js")) {
  if (!enabled(env)) return false;
  const steps = [
    [process.execPath, [cli(), "generate"]],
    [process.execPath, [path.join(__dirname, "verify-build.js")]]
  ];
  for (const [command, args] of steps) {
    const result = spawn(command, args, { stdio: "inherit", env, timeout: 180000, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Render build validation failed (exit " + result.status + ")");
  }
  return true;
}
if (require.main === module) {
  try { execute(); } catch (error) {
    console.error("Render build preparation failed:", error.message);
    process.exitCode = 1;
  }
}
module.exports = { enabled, execute };
