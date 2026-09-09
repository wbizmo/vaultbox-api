const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const prisma = require("../src/lib/prisma");
const { recordFirstDownload } = require("../src/lib/download-session");
const { LocalStorageAdapter } = require("../src/lib/storage");

async function fixture() {
  const user = await prisma.user.create({
    data: {
      name: "Download Test",
      email: `download-${crypto.randomUUID()}@example.com`,
      password: "not-used"
    }
  });
  const storedName = crypto.randomUUID();
  const file = await prisma.file.create({
    data: {
      originalName: "range.bin",
      storedName,
      mimeType: "application/octet-stream",
      size: 16n,
      path: storedName,
      userId: user.id
    }
  });
  const token = await prisma.downloadToken.create({
    data: {
      token: crypto.randomUUID(),
      fileId: file.id,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60000)
    }
  });
  return { user, file, token, record: { ...token, file } };
}

test("concurrent first ranges emit one first-download audit", async (t) => {
  const data = await fixture();
  t.after(async () => {
    await prisma.auditLog.deleteMany({ where: { userId: data.user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: data.user.id } });
    await prisma.file.deleteMany({ where: { userId: data.user.id } });
    await prisma.user.delete({ where: { id: data.user.id } });
  });

  const results = await Promise.all([
    recordFirstDownload(data.record, "127.0.0.1"),
    recordFirstDownload(data.record, "127.0.0.1")
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await prisma.auditLog.count({
    where: { userId: data.user.id, action: "DOWNLOAD_SESSION_STARTED" }
  }), 1);
  const stored = await prisma.downloadToken.findUnique({ where: { id: data.token.id } });
  assert.ok(stored.usedAt);
});

test("known-started sessions skip the conditional database update", async () => {
  let updates = 0;
  const client = {
    downloadToken: {
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      }
    },
    auditLog: { create: async () => ({}) }
  };
  const record = {
    id: "token",
    userId: "user",
    usedAt: new Date(),
    file: { id: "file", originalName: "range.bin" }
  };

  assert.equal(await recordFirstDownload(record, "127.0.0.1", client), false);
  assert.equal(updates, 0);
});

test("stream open reports missing bytes before a response stream is returned", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-download-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = new LocalStorageAdapter(root);

  await assert.rejects(
    adapter.openReadStreamForFile({ storedName: "missing.bin" }),
    (error) => error.code === "ENOENT"
  );
});
