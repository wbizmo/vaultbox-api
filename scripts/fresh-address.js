/*
 * Test support: a client address nobody else uses (random, inside the IPv6 documentation prefix).
 *
 * Registration and login are rate limited per address, and those counters live in PostgreSQL/Redis, which
 * outlive a single test process. Tests that register or log in through app.inject without an address would
 * all share 127.0.0.1 and could be refused (429) after enough runs inside one limit window. Give each such
 * call its own address instead. (Lives in scripts/ because every file under test/ is executed as a test.)
 */
const crypto = require("node:crypto");

function freshAddress() {
  const group = () => crypto.randomBytes(2).toString("hex");
  return `2001:db8:${group()}:${group()}::${group()}`;
}

module.exports = { freshAddress };
