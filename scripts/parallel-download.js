const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

function usage() {
  console.error(
    "Usage: node scripts/parallel-download.js <download-url> <output-file> [parallel=8] [partMiB=8]"
  );
  process.exit(2);
}

function parsePositiveInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function makeSegments(size, partBytes) {
  const segments = [];
  for (let start = 0; start < size; start += partBytes) {
    const end = Math.min(size - 1, start + partBytes - 1);
    segments.push({ index: segments.length, start, end, length: end - start + 1 });
  }
  return segments;
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeManifest(manifestPath, manifest) {
  const tmp = `${manifestPath}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.promises.rename(tmp, manifestPath);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function inspect(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HEAD failed with HTTP ${response.status}`);
  }

  const rawSize = response.headers.get("content-length");
  const acceptRanges = response.headers.get("accept-ranges");
  const etag = response.headers.get("etag");

  if (!rawSize || !/^\d+$/.test(rawSize)) {
    throw new Error("Server did not provide a valid Content-Length");
  }
  if (acceptRanges !== "bytes") {
    throw new Error("Server does not advertise byte-range downloads");
  }

  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("File size exceeds this client's safe integer range");
  }

  return { size, etag };
}

async function downloadSegment({ url, segment, fileHandle, etag }) {
  const headers = {
    Range: `bytes=${segment.start}-${segment.end}`
  };
  if (etag) headers["If-Range"] = etag;

  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status !== 206) {
    throw new Error(`Range ${segment.index} expected HTTP 206, got ${response.status}`);
  }

  const contentRange = response.headers.get("content-range");
  const expectedPrefix = `bytes ${segment.start}-${segment.end}/`;
  if (!contentRange?.startsWith(expectedPrefix)) {
    throw new Error(`Range ${segment.index} returned an unexpected Content-Range`);
  }

  let position = segment.start;
  let received = 0;

  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesWritten } = await fileHandle.write(
        buffer,
        offset,
        buffer.length - offset,
        position
      );
      if (bytesWritten <= 0) throw new Error("Zero-byte write while downloading");
      offset += bytesWritten;
      position += bytesWritten;
      received += bytesWritten;
    }
  }

  if (received !== segment.length) {
    throw new Error(
      `Range ${segment.index} was incomplete: expected ${segment.length} bytes, received ${received}`
    );
  }
}

async function main() {
  const [url, outputArg, parallelArg, partMiBArg] = process.argv.slice(2);
  if (!url || !outputArg) usage();

  const parallel = parsePositiveInteger(parallelArg, 8, 32);
  const partMiB = parsePositiveInteger(partMiBArg, 8, 128);
  const partBytes = partMiB * 1024 * 1024;
  const outputPath = path.resolve(outputArg);
  const manifestPath = `${outputPath}.vaultbox-resume.json`;

  const metadata = await inspect(url);
  const segments = makeSegments(metadata.size, partBytes);
  const existing = await readManifest(manifestPath);

  if (
    existing &&
    (existing.size !== metadata.size ||
      existing.etag !== metadata.etag ||
      existing.partBytes !== partBytes)
  ) {
    throw new Error(
      `Resume metadata does not match the current file. Remove ${manifestPath} to restart intentionally.`
    );
  }

  const manifest = existing || {
    version: 1,
    size: metadata.size,
    etag: metadata.etag,
    partBytes,
    completed: []
  };
  const completed = new Set(manifest.completed);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const fileHandle = await fs.promises.open(outputPath, existing ? "r+" : "w+");
  await fileHandle.truncate(metadata.size);

  const pending = segments.filter((segment) => !completed.has(segment.index));
  let cursor = 0;
  let bytesThisRun = 0;
  const startedAt = process.hrtime.bigint();
  let manifestWrite = Promise.resolve();

  async function persistCompleted(index) {
    completed.add(index);
    manifest.completed = [...completed].sort((a, b) => a - b);
    manifestWrite = manifestWrite.then(() => writeManifest(manifestPath, manifest));
    await manifestWrite;
  }

  async function worker() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= pending.length) return;

      const segment = pending[current];
      await downloadSegment({ url, segment, fileHandle, etag: metadata.etag });
      bytesThisRun += segment.length;
      await persistCompleted(segment.index);

      const done = completed.size;
      const percent = ((done / segments.length) * 100).toFixed(1);
      process.stderr.write(`\r${done}/${segments.length} parts complete (${percent}%)`);
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(parallel, Math.max(1, pending.length)) }, () => worker())
    );
    await manifestWrite;
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  process.stderr.write("\n");

  if (completed.size !== segments.length) {
    throw new Error("Download ended before all byte ranges completed");
  }

  const expectedChecksum = metadata.etag?.match(/^"sha256-([a-f0-9]{64})"$/i)?.[1]?.toLowerCase();
  let checksum = null;

  if (expectedChecksum) {
    checksum = await sha256File(outputPath);
    if (checksum !== expectedChecksum) {
      throw new Error(`SHA-256 mismatch: expected ${expectedChecksum}, got ${checksum}`);
    }
  }

  await fs.promises.unlink(manifestPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });

  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const mebibytes = bytesThisRun / (1024 * 1024);

  console.log(JSON.stringify({
    output: outputPath,
    sizeBytes: metadata.size,
    parallelRequests: parallel,
    partBytes,
    resumedParts: segments.length - pending.length,
    downloadedParts: pending.length,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    throughputMiBPerSecond: elapsedSeconds > 0
      ? Number((mebibytes / elapsedSeconds).toFixed(2))
      : null,
    sha256: checksum,
    verified: Boolean(expectedChecksum)
  }, null, 2));
}

main().catch((error) => {
  console.error(`VaultBox parallel download failed: ${error.message}`);
  process.exit(1);
});
