const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTrustProxy, describeTrustProxy, normalizeAddress, clientIp, PRODUCTION_DEFAULT } = require("../src/lib/client-ip");
const { getConfig, assertRuntimeConfig } = require("../src/config/env");

test("TRUST_PROXY defaults: private-network proxies in production, no proxy elsewhere", () => {
  assert.deepEqual(parseTrustProxy(undefined, { isProduction: true }).policy, PRODUCTION_DEFAULT);
  assert.deepEqual(parseTrustProxy("  ", { isProduction: true }).policy, PRODUCTION_DEFAULT);
  assert.equal(parseTrustProxy(undefined, { isProduction: true }).source, "default");
  assert.equal(parseTrustProxy(undefined, { isProduction: false }).policy, false);
  for (const off of ["none", "FALSE", "off", "0"]) {
    const parsed = parseTrustProxy(off, { isProduction: true });
    assert.equal(parsed.policy, false, off);
    assert.equal(parsed.error, null);
  }
});

test("TRUST_PROXY accepts addresses, CIDR ranges and keywords, normalised and de-duplicated", () => {
  const parsed = parseTrustProxy(" Loopback, 10.0.0.0/8 ,2001:DB8::/32,203.0.113.7,loopback", { isProduction: true });
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.policy, ["loopback", "10.0.0.0/8", "2001:db8::/32", "203.0.113.7"]);
  assert.equal(describeTrustProxy(parsed.policy), "loopback,10.0.0.0/8,2001:db8::/32,203.0.113.7");
  assert.equal(describeTrustProxy(false), "none");
});

test("TRUST_PROXY refuses values that would let a client choose its own IP", () => {
  for (const unsafe of ["true", "TRUE", "all", "*", "1", "2", "10", "0.0.0.0/0", "::/0", "10.0.0.0/33", "2001:db8::/129", "10.0.0.0/x"]) {
    const parsed = parseTrustProxy(unsafe, { isProduction: true });
    assert.ok(parsed.error, `${unsafe} must be rejected`);
    assert.equal(parsed.policy, false, "an invalid value never yields a trusting policy");
  }
  for (const malformed of ["garbage", "10.0.0.256", "10.0.0.0/8,oops", "loopbackk"]) {
    assert.ok(parseTrustProxy(malformed, { isProduction: true }).error, `${malformed} must be rejected`);
  }
});

test("TRUST_PROXY refuses ranges that would make ordinary internet clients trusted proxies", () => {
  // The IPv4-mapped range in every spelling, and IPv6 ranges that contain it: each makes every public IPv4
  // peer a "proxy" whose X-Forwarded-For is believed (verified against Fastify while fixing review feedback).
  for (const range of [
    "::ffff:0:0/96", "::ffff:0.0.0.0/96", "0:0:0:0:0:ffff:0:0/96", "::FFFF:0:0/96", "::/1", "::/2", "::/64", "::/80", "2000::/3", "2000::/4", "2001:db8::/16",
    "::ffff:8.0.0.0/104", "0.0.0.0/1", "128.0.0.0/7", "0.0.0.0/7"
  ]) {
    const parsed = parseTrustProxy(range, { isProduction: true });
    assert.ok(parsed.error, `${range} must be rejected`);
    assert.equal(parsed.policy, false);
  }
  // Legitimate private / documentation / provider ranges stay valid, including mapped single hosts.
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7", "2001:db8::/32", "::ffff:10.1.1.1", "::ffff:10.0.0.0/104", "203.0.113.0/24", "::/95", "fe80::/10", "fd00:1234::/32", "::1", "8000::/1"]) {
    assert.equal(parseTrustProxy(range, { isProduction: true }).error, null, `${range} must be accepted`);
  }
});

test("TRUST_PROXY refuses empty entries instead of silently dropping them", () => {
  for (const value of [",", ",,", "10.0.0.0/8,", ",loopback", "loopback,,uniquelocal", " , "]) {
    const parsed = parseTrustProxy(value, { isProduction: true });
    assert.match(parsed.error || "", /empty entry/, JSON.stringify(value));
    assert.equal(parsed.policy, false);
  }
  assert.equal(parseTrustProxy("loopback, uniquelocal", { isProduction: true }).error, null);
});

test("configuration: the setting is read from TRUST_PROXY and an invalid one stops startup", () => {
  const previous = process.env.TRUST_PROXY;
  const previousEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.TRUST_PROXY;
    assert.deepEqual(getConfig().trustProxy, PRODUCTION_DEFAULT);
    assert.equal(getConfig().trustProxySource, "default");

    process.env.TRUST_PROXY = "10.0.0.0/8";
    assert.deepEqual(getConfig().trustProxy, ["10.0.0.0/8"]);
    assert.equal(getConfig().trustProxySource, "env");

    process.env.TRUST_PROXY = "true";
    const config = getConfig();
    assert.equal(config.trustProxy, false);
    assert.throws(
      () => assertRuntimeConfig({ ...config, databaseUrl: "postgresql://x", jwtSecret: "x".repeat(40) }),
      /TRUST_PROXY=true is not allowed/
    );
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

test("normalizeAddress / clientIp always yield a syntactically valid address", () => {
  assert.equal(normalizeAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeAddress("2001:DB8::1"), "2001:db8::1");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress("garbage"), null);
  assert.equal(normalizeAddress("1.2.3.4, 5.6.7.8"), null);
  assert.equal(normalizeAddress(undefined), null);

  assert.equal(clientIp({ ip: "203.0.113.7", raw: { socket: { remoteAddress: "10.0.0.1" } } }), "203.0.113.7");
  assert.equal(clientIp({ ip: "not-an-ip", raw: { socket: { remoteAddress: "::ffff:10.0.0.1" } } }), "10.0.0.1");
  assert.equal(clientIp({ ip: "'; DROP TABLE", raw: { socket: {} } }), "unknown");
});
