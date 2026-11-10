"use strict";

/*
 * One-way, manually operated local -> S3 migration. Dry-run by default.
 * Deployers must freeze writes, take a database and object backup, then run
 * --apply, then --verify-only, then change STORAGE_BACKEND in a planned cutover.
 * No original local files are ever deleted and no database records are mutated.
 */
const crypto = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { S3StorageAdapter } = require("../src/lib/s3-storage");

function optionsFromArgs(args) {
  const options = { apply: false, verifyOnly: false, limit: 500, after: "", userId: null };
  for (const argument of args) {
    if (argument === "--apply") options.apply = true;
    else if (argument === "--verify-only") options.verifyOnly = true;
    else if (argument.startsWith("--limit=")) options.limit = Number(argument.slice(8));
    else if (argument.startsWith("--after=")) options.after = argument.slice(8);
    else if (argument.startsWith("--user-id=")) options.userId = argument.slice(10);
    else throw new Error("Unknown argument: " + argument);
  }
  if (options.apply && options.verifyOnly) throw new Error("--apply and --verify-only are mutually exclusive");
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100000) {
    throw new Error("--limit must be an integer from 1 to 100000");
  }
  return options;
}

async function digest(stream) {
  const sha = crypto.createHash("sha256");
  let size = 0n;
  for await (const chunk of stream) {
    sha.update(chunk);
    size += BigInt(chunk.length);
  }
  return { checksum: sha.digest("hex"), size };
}

async function verifyObject(storage, file, expected) {
  const actual = await digest(await storage.openReadStreamForFile(file));
  if (actual.size !== expected.size || actual.checksum !== expected.checksum) {
    throw new Error("Destination differs from source for file " + file.id);
  }
}

async function assertNoPendingWrites(client) {
  const active = await client.uploadSession.count({ where: { status: { in: ["UPLOADING", "COMPLETING"] } } });
  const unsettledReservations = await client.uploadReservation.count({
    where: { state: "PENDING" }
  });
  const outbox = await client.fileDeletion.count({ where: { status: { in: ["PENDING", "DEAD"] } } });
  if (active || unsettledReservations || outbox) {
    throw new Error("Cannot migrate with active sessions=" + active +
      " pending reservations=" + unsettledReservations + " unsettled file deletions=" + outbox);
  }
}

async function migrate({ apply = false, verifyOnly = false, limit = 500, after = "", userId = null, local, remote, client = prisma } = {}) {
  await assertNoPendingWrites(client);
  const summary = { mode: verifyOnly ? "verify-only" : apply ? "apply" : "dry-run",
    scanned: 0, copied: 0, verified: 0, wouldCopy: 0, lastId: after };
  let cursor = after;
  while (summary.scanned < limit) {
    const files = await client.file.findMany({
      where: { status: "ACTIVE", ...(userId ? { userId } : {}), ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: Math.min(50, limit - summary.scanned)
    });
    if (!files.length) break;
    for (const file of files) {
      cursor = file.id;
      summary.scanned++;
      summary.lastId = cursor;
      const source = await digest(await local.openReadStreamForFile(file));
      if (source.size !== file.size || (file.checksum && source.checksum !== file.checksum)) {
        throw new Error("Source bytes or checksum mismatch for file " + file.id + " (" + file.storedName + ")");
      }

      const exists = await remote.existsFile(file);
      if (exists) {
        await verifyObject(remote, file, source);
        summary.verified++;
        continue;
      }
      if (verifyOnly) throw new Error("Missing S3 file " + file.id);
      if (!apply) {
        summary.wouldCopy++;
        continue;
      }
      await pipeline(await local.openReadStreamForFile(file), remote.createWriteStream(file.storedName));
      await verifyObject(remote, file, source);
      summary.copied++;
    }
  }
  return summary;
}

async function main() {
  const opts = optionsFromArgs(process.argv.slice(2));
  const env = process.env;
  if (!env.S3_BUCKET || !env.S3_REGION) throw new Error("S3_BUCKET and S3_REGION are required");
  const local = new LocalStorageAdapter(env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), "storage/uploads"));
  const remote = new S3StorageAdapter({
    bucket: env.S3_BUCKET, region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    prefix: env.S3_OBJECT_PREFIX ?? "vaultbox",
    sse: env.S3_SERVER_SIDE_ENCRYPTION ?? "AES256"
  });
  try {
    await Promise.all([local.ready(), remote.ready()]);
    const summary = await migrate({ ...opts, local, remote });
    process.stdout.write(JSON.stringify(summary) + "\n");
    if (summary.scanned === opts.limit) {
      process.stderr.write("Limit reached; use --after=" + summary.lastId + " for the next page.\n");
    }
  } finally {
    await prisma.$disconnect();
    remote.client.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Migration stopped; no originals removed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { optionsFromArgs, digest, migrate, assertNoPendingWrites };
