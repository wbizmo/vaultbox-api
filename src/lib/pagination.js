function serializeCursorValue(value, type) {
  if (type === "bigint") return BigInt(value).toString();
  if (type === "date") return new Date(value).toISOString();
  return String(value);
}

function parseCursorValue(value, type) {
  if (type === "bigint") return BigInt(value);
  if (type === "date") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid cursor date");
    return parsed;
  }
  return String(value);
}

function encodeCursor(item, { sort = "createdAt", order = "desc", type = "date" } = {}) {
  const payload = {
    v: 1,
    id: item.id,
    sort,
    order,
    value: serializeCursorValue(item[sort], type)
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(raw, { sort = "createdAt", order = "desc", type = "date" } = {}) {
  if (!raw || typeof raw !== "string" || raw.length > 1024) throw new Error("Invalid cursor");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }

  if (payload?.v !== 1 || typeof payload.id !== "string" || payload.sort !== sort || payload.order !== order) {
    throw new Error("Invalid cursor");
  }

  return {
    id: payload.id,
    value: parseCursorValue(payload.value, type)
  };
}

function cursorWhere(cursor, { sort = "createdAt", order = "desc" } = {}) {
  if (!cursor) return {};
  const direction = order === "asc" ? "gt" : "lt";
  return {
    OR: [
      { [sort]: { [direction]: cursor.value } },
      { [sort]: cursor.value, id: { [direction]: cursor.id } }
    ]
  };
}

function cursorOrderBy(sort = "createdAt", order = "desc") {
  return [{ [sort]: order }, { id: order }];
}

function finishCursorPage(rows, limit, options) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    pagination: {
      mode: "cursor",
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last, options) : null
    }
  };
}

module.exports = {
  encodeCursor,
  decodeCursor,
  cursorWhere,
  cursorOrderBy,
  finishCursorPage
};
