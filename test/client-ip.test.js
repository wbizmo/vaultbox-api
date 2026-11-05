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
