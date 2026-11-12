"use strict";

// Only compile-time literal keys reach Prisma; request.query.sort never
// becomes a computed JavaScript property. This complements Fastify's enum
// validation and protects callers that use these helpers directly.
function filePageOrderBy(sort, order) {
  const direction = order === "asc" ? "asc" : "desc";
  switch (sort) {
    case "updatedAt": return { updatedAt: direction };
    case "size": return { size: direction };
    case "originalName": return { originalName: direction };
    default: return { createdAt: direction };
  }
}

function fileCursorOrderBy(sort, order) {
  return [filePageOrderBy(sort, order), { id: order === "asc" ? "asc" : "desc" }];
}

function fileCursorWhere(cursor, sort, order) {
  if (!cursor) return {};
  const compare = (value) => order === "asc" ? { gt: value } : { lt: value };
  const idComparison = compare(cursor.id);
  switch (sort) {
    case "updatedAt": return { OR: [
      { updatedAt: compare(cursor.value) },
      { updatedAt: cursor.value, id: idComparison }
    ] };
    case "size": return { OR: [
      { size: compare(cursor.value) },
      { size: cursor.value, id: idComparison }
    ] };
    case "originalName": return { OR: [
      { originalName: compare(cursor.value) },
      { originalName: cursor.value, id: idComparison }
    ] };
    default: return { OR: [
      { createdAt: compare(cursor.value) },
      { createdAt: cursor.value, id: idComparison }
    ] };
  }
}

module.exports = { filePageOrderBy, fileCursorOrderBy, fileCursorWhere };
