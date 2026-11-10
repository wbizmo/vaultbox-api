"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateReleaseGate } = require("../scripts/verify-release-gate");
const pkg = require("../package.json");

const SHA = "a".repeat(40);
const GOOD = [{
  headSha: SHA, headBranch: "main", event: "push",
  status: "completed", conclusion: "success"
}];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbox-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "RELEASE_NOTES_v2.5.0.md"), "# VaultBox v2.5.0\nRelease notes");
  return { version: "2.5.0", sha: SHA, mainSha: SHA,
    packageVersion: "2.5.0", notesDirectory: root, runs: GOOD };
}

test("manual release gate requires exact verified main SHA, package/notes/version alignment", (t) => {
  const ok = fixture(t);
  assert.equal(validateReleaseGate(ok).tag, "v2.5.0");
  const invalid = [
    { sha: "b".repeat(40) }, { mainSha: "b".repeat(40) },
    { version: "2.5.1" }, { packageVersion: "2.4.0" },
    { runs: [{ ...GOOD[0], conclusion: "failure" }] },
    { runs: [{ ...GOOD[0], headSha: "b".repeat(40) }] },
    { runs: [{ ...GOOD[0], headBranch: "staging" }] },
    { runs: [{ ...GOOD[0], event: "pull_request" }] },
    { runs: [{ ...GOOD[0], status: "in_progress" }] },
    { runs: [] }
  ];
  for (const change of invalid) {
    assert.throws(() => validateReleaseGate({ ...ok, ...change }), "Must reject " + JSON.stringify(change));
  }
  fs.writeFileSync(path.join(ok.notesDirectory, "RELEASE_NOTES_v2.5.0.md"), "# Wrong title\n");
  assert.throws(() => validateReleaseGate(ok), /heading/);
});

test("production startup and migrations use locally installed pinned Prisma without remote npx", () => {
  assert.equal(pkg.scripts.start, "node src/server.js");
  assert.equal(pkg.scripts["deploy:generate"], "prisma generate");
  assert.equal(pkg.scripts["deploy:migrate"], "prisma migrate deploy");
  assert.equal(pkg.dependencies.prisma, pkg.dependencies["@prisma/client"]);
  assert.ok(!pkg.scripts.start.includes("npx"));
});

test("workflow is explicit-only; draft PRs do not spawn expensive CI runners", () => {
  const release = fs.readFileSync(".github/workflows/release-v2.yml", "utf8");
  const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /workflow_run:/);
  assert.match(release, /environment: vaultbox-release/);
  assert.match(release, /scripts\/verify-release-gate.js/);
  assert.match(release, /current_main/);
  assert.match(ci, /pull_request\.draft == false/);
  assert.match(ci, /ready_for_review/);
  assert.match(ci, /branches:\s*\n\s*- main/);
});
