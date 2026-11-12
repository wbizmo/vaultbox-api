// @ts-check
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Prisma, PrismaClient } = require("@prisma/client");
const { version } = require("../package.json");

// This is a server-side JavaScript project, not a transpiled frontend.
// A valid deploy build must contain the generated Prisma runtime, all route
// modules, and the migrations/release notes matching the packaged version.
const models = new Set(Prisma.dmmf.datamodel.models.map((model) => model.name));
for (const required of [
  "User", "Plan", "File", "Folder", "UploadSession", "UploadPart",
  "TemporaryObject", "FileDeletion", "UploadReservation", "AuditLog"
]) {
  assert.ok(models.has(required), "Generated Prisma client lacks " + required);
}
assert.equal(typeof PrismaClient, "function");
assert.equal(typeof require("../src/app"), "function", "Fastify app must load");
for (const route of [
  "system", "auth", "user", "plan", "file", "upload",
  "folder", "download", "billing", "admin", "infra"
]) {
  assert.equal(typeof require("../src/routes/" + route + ".routes.js"),
    "function", "Route module failed to load: " + route);
}
const root = path.join(__dirname, "..");
assert.ok(fs.existsSync(path.join(root, "prisma", "schema.prisma")));
assert.ok(fs.existsSync(path.join(root, "docs", "RELEASE_NOTES_v" + version + ".md")),
  "Versioned release notes must ship with the deploy candidate");
assert.ok(fs.existsSync(path.join(root, "prisma", "migrations")),
  "Database migrations must ship with the deploy candidate");
console.log("Deploy build verified: generated Prisma client, " +
  models.size + " models, all 11 route modules, release v" + version);
