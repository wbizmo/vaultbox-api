const net = require("node:net");

/*
 * Client-IP policy (issue #47).
 *
 * `request.ip` is derived by Fastify from the TCP peer plus X-Forwarded-For, according to the
 * `trustProxy` setting. The setting must say WHICH PEERS are our own reverse proxies: Fastify then walks
 * the chain from the connection backwards and stops at the first address that is not a trusted proxy.
 * That address is the client. Entries a client writes into X-Forwarded-For sit further left, beyond the
 * first untrusted address, so they are never consulted.
 *
 *   trustProxy: true   -> trusts every peer and returns the LEFTMOST entry: fully attacker-controlled. Rejected.
 *   trustProxy: <N>    -> Fastify 5 treats a bare hop count as "trust nobody" (it cannot validate the peer). Rejected
 *                         so a configured number can never silently mean something else.
 *   trustProxy: list   -> exact addresses, CIDR ranges and the keywords loopback / linklocal / uniquelocal. Accepted.
 *
 * Production default: the private-network ranges, i.e. "my ingress reaches me from a private address".
 * A direct public connection is therefore never trusted, whatever headers it carries.
 */

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const PRODUCTION_DEFAULT = ["loopback", "linklocal", "uniquelocal"];
const OFF_VALUES = new Set(["none", "false", "off", "0"]);

function isValidAddressOrRange(token) {
  if (KEYWORDS.has(token)) return null;
  const slash = token.indexOf("/");
  if (slash === -1) {
    return net.isIP(token) ? null : `"${token}" is not an IP address, CIDR range or keyword (loopback, linklocal, uniquelocal)`;
  }
  const address = token.slice(0, slash);
  const prefixText = token.slice(slash + 1);
  const family = net.isIP(address);
  if (!family) return `"${token}" has an invalid address`;
  if (!/^\d{1,3}$/.test(prefixText)) return `"${token}" has an invalid prefix length`;
  const prefix = Number(prefixText);
  const max = family === 4 ? 32 : 128;
  if (prefix > max) return `"${token}" has an out-of-range prefix length`;
  if (prefix === 0) return `"${token}" would trust every address`;
  return null;
}

/**
 * Parse TRUST_PROXY. Returns { policy, source, error }:
 *   policy  false (trust no proxy) or an array Fastify accepts as `trustProxy`;
 *   source  "env" | "default";
 *   error   a message when the value is unsafe or malformed (callers refuse to start).
 */
function parseTrustProxy(raw, { isProduction = false } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { policy: isProduction ? [...PRODUCTION_DEFAULT] : false, source: "default", error: null };
  }

  const lowered = text.toLowerCase();
  if (OFF_VALUES.has(lowered)) return { policy: false, source: "env", error: null };

  if (lowered === "true" || lowered === "all" || lowered === "*" || /^\d+$/.test(lowered)) {
    return {
      policy: false,
      source: "env",
      error: `TRUST_PROXY=${text} is not allowed: it would let clients choose their own IP via X-Forwarded-For ` +
        "(Fastify treats a bare hop count as trusting nobody). List the proxy addresses, CIDR ranges or keywords " +
        "(loopback, linklocal, uniquelocal) instead, or use none"
    };
  }

  const tokens = text.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    const problem = isValidAddressOrRange(token);
    if (problem) return { policy: false, source: "env", error: `TRUST_PROXY: ${problem}` };
  }
  return { policy: [...new Set(tokens)], source: "env", error: null };
}

function describeTrustProxy(policy) {
  return policy === false || policy === undefined ? "none" : [].concat(policy).join(",");
}

function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  const candidate = mapped ? mapped[1] : text.replace(/%.+$/, "");
  return net.isIP(candidate) ? candidate : null;
}

/**
 * The one client identity used by rate limits, audit logs and request logs. Always a syntactically valid
 * IP address: a malformed value (for example a garbage X-Forwarded-For entry a lenient proxy forwarded)
 * is replaced by the connection's own address, so it can neither pick a throttle bucket nor poison logs.
 */
function clientIp(request) {
  return normalizeAddress(request.ip) || normalizeAddress(request.raw?.socket?.remoteAddress) || "unknown";
}

module.exports = {
  PRODUCTION_DEFAULT,
  parseTrustProxy,
  describeTrustProxy,
  normalizeAddress,
  clientIp
};
