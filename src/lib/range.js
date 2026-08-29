function parseSingleRange(header, size) {
  const total = BigInt(size);
  if (total <= 0n) return null;
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) {
    const error = new Error("Malformed Range header");
    error.code = "INVALID_RANGE";
    throw error;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    const error = new Error("Empty byte range");
    error.code = "INVALID_RANGE";
    throw error;
  }

  let start;
  let end;

  if (!rawStart) {
    const suffixLength = BigInt(rawEnd);
    if (suffixLength <= 0n) throw Object.assign(new Error("Invalid suffix range"), { code: "INVALID_RANGE" });
    start = suffixLength >= total ? 0n : total - suffixLength;
    end = total - 1n;
  } else {
    start = BigInt(rawStart);
    end = rawEnd ? BigInt(rawEnd) : total - 1n;
  }

  if (start >= total || start < 0n || end < start) {
    const error = new Error("Requested range is not satisfiable");
    error.code = "RANGE_NOT_SATISFIABLE";
    throw error;
  }

  if (end >= total) end = total - 1n;

  return {
    start,
    end,
    length: end - start + 1n
  };
}

function rangeHeader(range, totalSize) {
  return `bytes ${range.start}-${range.end}/${BigInt(totalSize)}`;
}

module.exports = {
  parseSingleRange,
  rangeHeader
};
