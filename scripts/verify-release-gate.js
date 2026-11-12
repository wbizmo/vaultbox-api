// @ts-check
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {{headSha: string, headBranch: string, event: string,
 *   status: string, conclusion: string}} CheckedWorkflowRun
 * @param {{version: string, sha: string, mainSha: string,
 *   packageVersion: string, runs: CheckedWorkflowRun[], notesDirectory: string}} input
 */
function validateReleaseGate({ version, sha, mainSha, packageVersion, runs, notesDirectory }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Release version must be stable semver");
  if (!/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("Release SHA must be a full lowercase git SHA");
  if (sha !== mainSha) throw new Error("Release SHA must equal protected main HEAD");
  if (version !== packageVersion) throw new Error("Release version must equal package.json version");
  const notes = path.join(notesDirectory, "RELEASE_NOTES_v" + version + ".md");
  if (!fs.existsSync(notes)) throw new Error("Release notes are required: " + notes);
  const firstLine = fs.readFileSync(notes, "utf8").split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith("# ") || !firstLine.includes("v" + version)) {
    throw new Error("Release heading must contain the exact tag version");
  }
  if (/\b(?:UNRELEASED|DRAFT)\b/i.test(firstLine)) {
    throw new Error("Cannot publish a draft release heading marked UNRELEASED");
  }
  if (!Array.isArray(runs) || !runs.some((run) =>
    run.headSha === sha && run.headBranch === "main" &&
    run.event === "push" && run.status === "completed" && run.conclusion === "success"
  )) throw new Error("An exact-SHA successful completed push CI run on main is required");
  return { version, sha, tag: "v" + version, notes };
}

/** @param {string[]} argv */
function args(argv) {
  /** @type {Record<string,string>} */
  const result = {};
  for (const value of argv) {
    const i = value.indexOf("=");
    if (i < 3 || !value.startsWith("--")) throw new Error("Invalid input " + value);
    result[value.slice(2, i)] = value.slice(i + 1);
  }
  return result;
}

function main() {
  const input = args(process.argv.slice(2));
  const runs = JSON.parse(fs.readFileSync(input.runs, "utf8"));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const ok = validateReleaseGate({
    version: input.version,
    sha: input.sha,
    mainSha: input["main-sha"],
    packageVersion: pkg.version,
    runs,
    notesDirectory: "docs"
  });
  console.log("Release verification passed for " + ok.tag + " at " + ok.sha);
}
if (require.main === module) {
  try { main(); } catch (error) {
    console.error("Release gate rejected:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { validateReleaseGate };
