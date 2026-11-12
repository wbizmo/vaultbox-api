"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const prisma = require("../src/lib/prisma");
const buildApp = require("../src/app");
const { LocalStorageAdapter } = require("../src/lib/storage");

const config = {
  nodeEnv: "test", isProduction: false, corsOrigins: [],
  jwtSecret: "pagination-count-optimization-test-secret", jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024, uploadChunkBytes: 4096,
  uploadSessionExpiresMinutes: 60, uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4, downloadTokenExpiresMinutes: 15,
  downloadSuggestedPartBytes: 4096, downloadMaxRanges: 4
};

test("optional total count preserves old metadata by default and never reveals other tenants", async (t) => {
  const tag = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-count-"));
  const plan = await prisma.plan.create({ data: {
    name: "count-" + tag, priceMonthly: 0, storageLimit: 10000n
  } });
  const owner = await prisma.user.create({ data: {
    name: "Count owner", email: "count-owner-" + tag + "@example.invalid",
    password: "unused", planId: plan.id, role: "ADMIN"
  } });
  const other = await prisma.user.create({ data: {
    name: "Count other", email: "count-other-" + tag + "@example.invalid",
    password: "unused", planId: plan.id
  } });
  const folder = await prisma.folder.create({ data: { name: "Only owner", userId: owner.id } });
  await prisma.folder.create({ data: { name: "Empty owned folder", userId: owner.id } });
  const files = [
    { userId: owner.id, name: "Report One.pdf", folderId: folder.id, status: "ACTIVE" },
    { userId: owner.id, name: "Report Two.pdf", folderId: folder.id, status: "ACTIVE" },
    { userId: owner.id, name: "Report Three.pdf", folderId: null, status: "ACTIVE" },
    { userId: owner.id, name: "Report Deleted.pdf", folderId: null, status: "DELETED" },
    { userId: other.id, name: "Other Report.pdf", folderId: null, status: "ACTIVE" }
  ];
  for (const f of files) {
    const key = crypto.randomUUID();
    await prisma.file.create({ data: {
      userId: f.userId, originalName: f.name, storedName: key,
      mimeType: "application/pdf", size: 2n, path: key,
      folderId: f.folderId, status: f.status
    } });
  }
  const app = buildApp({ config, storage: new LocalStorageAdapter(root), logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    await prisma.file.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.folder.deleteMany({ where: { userId: owner.id } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  const auth = { authorization: "Bearer " + app.jwt.sign({ id: owner.id }) };
  const get = async (query) => {
    const response = await app.inject({ method: "GET", url: "/files?" + query, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  const legacy = await get("limit=2&sort=originalName&order=asc");
  assert.equal(legacy.pagination.total, 3);
  assert.equal(legacy.pagination.pages, 2);
  assert.equal(legacy.files.length, 2);

  // CodeQL regression: untrusted sort keys never become Prisma object keys.
  const invalidSort = await app.inject({
    method: "GET", url: "/files?sort=__proto__&order=asc", headers: auth
  });
  assert.equal(invalidSort.statusCode, 400);
  const invalidOrder = await app.inject({
    method: "GET", url: "/files?sort=constructor&includeTotal=false", headers: auth
  });
  assert.equal(invalidOrder.statusCode, 400);

  const first = await get("limit=2&sort=originalName&order=asc&includeTotal=false");
  assert.equal(first.pagination.total, null);
  assert.equal(first.pagination.pages, null);
  assert.equal(first.pagination.hasMore, true);
  assert.deepEqual(first.files.map((f) => f.id), legacy.files.map((f) => f.id));

  const second = await get("limit=2&page=2&sort=originalName&order=asc&includeTotal=false");
  assert.equal(second.files.length, 1);
  assert.equal(second.pagination.hasMore, false);

  const folderFiltered = await get("limit=1&includeTotal=false&folderId=" + folder.id);
  assert.equal(folderFiltered.files.length, 1);
  assert.equal(folderFiltered.pagination.hasMore, true);
  assert.equal(folderFiltered.files[0].folderId, folder.id);

  const searched = await get("includeTotal=false&search=report&sort=originalName&order=asc");
  assert.equal(searched.files.length, 3);
  assert.equal(searched.pagination.hasMore, false);
  assert.ok(searched.files.every((f) => f.originalName.startsWith("Report")));

  const rootOnly = await get("includeTotal=false&folderId=root");
  assert.equal(rootOnly.files.length, 1);
  assert.equal(rootOnly.files[0].originalName, "Report Three.pdf");

  const cursored = await get("pagination=cursor&limit=2&includeTotal=false");
  assert.equal(cursored.pagination.mode, "cursor");
  assert.equal(cursored.files.length, 2);

  const getExtra = async (url) => {
    const response = await app.inject({ method: "GET", url, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const oldFolders = await getExtra("/folders?limit=1");
  const optimizedFolders = await getExtra("/folders?limit=1&includeTotal=false");
  assert.equal(oldFolders.pagination.total, 2);
  assert.equal(optimizedFolders.pagination.total, null);
  assert.equal(optimizedFolders.pagination.pages, null);
  assert.equal(optimizedFolders.pagination.hasMore, true);
  assert.equal((await getExtra("/folders?limit=1&page=2&includeTotal=false")).pagination.hasMore, false);

  const oldUsers = await getExtra("/admin/users?search=" + tag + "&limit=1");
  const optimizedUsers = await getExtra("/admin/users?search=" + tag + "&limit=1&includeTotal=false");
  assert.equal(oldUsers.pagination.total, 2);
  assert.equal(optimizedUsers.pagination.total, null);
  assert.equal(optimizedUsers.pagination.hasMore, true);
  assert.equal(optimizedUsers.users.length, 1);
  assert.equal((await getExtra("/admin/users?search=" + tag + "&limit=1&page=2&includeTotal=false")).pagination.hasMore, false);

  const otherAuth = { authorization: "Bearer " + app.jwt.sign({ id: other.id }) };
  const forbidden = await app.inject({
    method: "GET", url: "/admin/users?includeTotal=false", headers: otherAuth
  });
  assert.equal(forbidden.statusCode, 403);
});
