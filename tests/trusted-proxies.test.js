'use strict';

const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');

const tp = require('../lib/trusted-proxies');

function makeReq({ peer = '203.0.113.5', headers = {}, ip } = {}) {
  const req = {
    headers: { ...headers },
    socket: { remoteAddress: peer },
  };
  if (ip !== undefined) req.ip = ip;
  return req;
}

before(() => {
  // Make sure no leak from another test file affects env parsing.
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();
});

after(() => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();
});

beforeEach(() => {
  tp.resetTrustedProxiesCache();
});

test('normalizeIp lowercases and strips IPv4-mapped IPv6 prefix', () => {
  assert.equal(tp.normalizeIp('1.2.3.4'), '1.2.3.4');
  assert.equal(tp.normalizeIp('::FFFF:1.2.3.4'), '1.2.3.4');
  assert.equal(tp.normalizeIp('  2001:DB8::1  '), '2001:db8::1');
  assert.equal(tp.normalizeIp(''), null);
  assert.equal(tp.normalizeIp(null), null);
});

test('parseTrustedProxies returns empty list when env is unset/empty', () => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();
  assert.deepEqual(tp.parseTrustedProxies(undefined), []);
  assert.deepEqual(tp.parseTrustedProxies(''), []);
});

test('parseTrustedProxies normalizes plain IPs and rejects bad entries', () => {
  const entries = tp.parseTrustedProxies('1.2.3.4,::FFFF:1.2.3.4,2001:DB8::1,not-an-ip');
  assert.equal(entries.length, 3);
  assert.ok(entries.includes('1.2.3.4'));
  assert.ok(entries.includes('2001:db8::1'));
});

test('parseTrustedProxies supports the cloudflare keyword', () => {
  const entries = tp.parseTrustedProxies('cloudflare');
  assert.ok(entries.length > 0);
  assert.ok(entries.some((c) => c.startsWith('173.245.48.0/20')));
  assert.ok(entries.some((c) => c.startsWith('2400:cb00::/32')));
});

test('parseTrustedProxies preserves CIDR notation and validates prefix length', () => {
  const entries = tp.parseTrustedProxies('10.0.0.0/8,2001:db8::/32,10.0.0.0/99');
  assert.ok(entries.includes('10.0.0.0/8'));
  assert.ok(entries.includes('2001:db8::/32'));
  assert.equal(entries.includes('10.0.0.0/99'), false);
});

test('isTrustedProxy returns false for empty allowlist', () => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();
  assert.equal(tp.isTrustedProxy('1.2.3.4'), false);
  assert.equal(tp.isTrustedProxy('203.0.113.5'), false);
});

test('isTrustedProxy matches CIDR ranges', () => {
  process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8,2001:db8::/32';
  tp.resetTrustedProxiesCache();
  assert.equal(tp.isTrustedProxy('10.5.6.7'), true);
  assert.equal(tp.isTrustedProxy('2001:db8::1'), true);
  assert.equal(tp.isTrustedProxy('11.0.0.1'), false);
});

test('isTrustedProxy normalizes IPv4-mapped IPv6 entries and peers', () => {
  process.env.TRUSTED_PROXY_IPS = '::ffff:1.2.3.4';
  tp.resetTrustedProxiesCache();
  assert.equal(tp.isTrustedProxy('1.2.3.4'), true);
  assert.equal(tp.isTrustedProxy('::ffff:1.2.3.4'), true);
});

test('isCloudflareEdge matches published CF ranges', () => {
  assert.equal(tp.isCloudflareEdge('173.245.48.1'), true);
  assert.equal(tp.isCloudflareEdge('104.16.0.1'), true);
  assert.equal(tp.isCloudflareEdge('2606:4700::1'), true);
  assert.equal(tp.isCloudflareEdge('203.0.113.5'), false);
});

test('buildRateLimitKey returns socket address when allowlist is empty (spoofed headers ignored)', () => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();

  const req1 = makeReq({
    peer: '203.0.113.5',
    headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.99' },
  });
  const req2 = makeReq({
    peer: '203.0.113.5',
    headers: { 'cf-connecting-ip': '198.51.100.8', 'x-forwarded-for': '198.51.100.100' },
  });

  const k1 = tp.buildRateLimitKey(req1);
  const k2 = tp.buildRateLimitKey(req2);
  assert.equal(k1, '203.0.113.5');
  assert.equal(k2, '203.0.113.5');
  // Critical: spoofed headers must not produce different buckets when no
  // proxy is trusted.
  assert.equal(k1, k2);
});

test('buildRateLimitKey honors cf-connecting-ip only when peer is a Cloudflare edge', () => {
  process.env.TRUSTED_PROXY_IPS = 'cloudflare';
  tp.resetTrustedProxiesCache();

  // Peer is a known Cloudflare edge.
  const fromCf = makeReq({
    peer: '173.245.48.10',
    headers: { 'cf-connecting-ip': '198.51.100.42', 'x-forwarded-for': '198.51.100.99' },
  });
  assert.equal(tp.buildRateLimitKey(fromCf), '198.51.100.42');

  // Peer is not a Cloudflare edge; even though 'cloudflare' is in the
  // allowlist, cf-connecting-ip must not be trusted for non-CF peers.
  const fromOther = makeReq({
    peer: '198.51.100.10',
    headers: { 'cf-connecting-ip': '198.51.100.42' },
  });
  // No trusted proxy other than CF, so the peer itself is not trusted
  // and the key falls back to the socket address.
  assert.equal(tp.buildRateLimitKey(fromOther), '198.51.100.10');
});

test('buildRateLimitKey honors x-forwarded-for leftmost only when peer is trusted', () => {
  process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';
  tp.resetTrustedProxiesCache();

  const trusted = makeReq({
    peer: '10.0.0.5',
    headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.5' },
  });
  assert.equal(tp.buildRateLimitKey(trusted), '198.51.100.1');

  const untrusted = makeReq({
    peer: '203.0.113.5',
    headers: { 'x-forwarded-for': '198.51.100.1' },
  });
  assert.equal(tp.buildRateLimitKey(untrusted), '203.0.113.5');
});

test('buildRateLimitKey ignores spoofed cf-connecting-ip for non-trusted peers', () => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();

  // A client rotates cf-connecting-ip per request — every request must
  // land in the same bucket as the direct-IP key.
  const a = tp.buildRateLimitKey(
    makeReq({ peer: '198.51.100.1', headers: { 'cf-connecting-ip': '1.1.1.1' } })
  );
  const b = tp.buildRateLimitKey(
    makeReq({ peer: '198.51.100.1', headers: { 'cf-connecting-ip': '2.2.2.2' } })
  );
  const c = tp.buildRateLimitKey(
    makeReq({ peer: '198.51.100.1', headers: { 'x-forwarded-for': '3.3.3.3' } })
  );
  const direct = tp.buildRateLimitKey(makeReq({ peer: '198.51.100.1' }));
  assert.equal(a, direct);
  assert.equal(b, direct);
  assert.equal(c, direct);
  assert.equal(a, '198.51.100.1');
});

test('buildRateLimitKey normalizes IPv4-mapped IPv6 peer addresses', () => {
  process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
  tp.resetTrustedProxiesCache();

  // Peer reports as IPv4-mapped IPv6 — should match the configured IPv4 entry.
  const req = makeReq({
    peer: '::ffff:1.2.3.4',
    headers: { 'x-forwarded-for': '198.51.100.1' },
  });
  assert.equal(tp.buildRateLimitKey(req), '198.51.100.1');
});

test('getTrustedProxyEntries reflects the current env value', () => {
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();
  assert.deepEqual(tp.getTrustedProxyEntries(), []);

  process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
  tp.resetTrustedProxiesCache();
  const entries = tp.getTrustedProxyEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0], '1.2.3.4');
});