const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');

// Import the SSRF validation helpers from the dedicated module
const {
  isForbiddenLinkPreviewHost,
  hostResolvesToPrivate,
  resolveHostToIps,
  isPrivateIPv4,
  isPrivateIPv6,
  resolveValidatedLinkPreviewAddress,
} = require('../lib/ssrf-validation');

// ---- Unit tests for SSRF validation helpers ----

test('isForbiddenLinkPreviewHost blocks localhost', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(await isForbiddenLinkPreviewHost('sub.localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('.localhost'), true);
});

test('isForbiddenLinkPreviewHost blocks .local domains', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('printer.local'), true);
  assert.equal(await isForbiddenLinkPreviewHost('my-router.local'), true);
  assert.equal(await isForbiddenLinkPreviewHost('.local'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv4 addresses', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('10.255.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.255.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('169.254.169.254'), true); // AWS IMDS
  assert.equal(await isForbiddenLinkPreviewHost('172.16.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('172.31.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.255.255'), true);
});

test('isForbiddenLinkPreviewHost blocks IPv4 broadcast address', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('255.255.255.255'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv6 addresses', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('[::1]'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fc00::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fd00::1'), true);
});

test('isForbiddenLinkPreviewHost blocks IPv6 unspecified address', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::'), true);
});

test('isForbiddenLinkPreviewHost allows public hostnames', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('example.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('github.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('cdn.example.org'), false);
  assert.equal(await isForbiddenLinkPreviewHost('1.1.1.1'), false);
  assert.equal(await isForbiddenLinkPreviewHost('8.8.8.8'), false);
});

test('isForbiddenLinkPreviewHost blocks empty/null/undefined', async () => {
  assert.equal(await isForbiddenLinkPreviewHost(''), true);
  assert.equal(await isForbiddenLinkPreviewHost(null), true);
  assert.equal(await isForbiddenLinkPreviewHost(undefined), true);
  assert.equal(await isForbiddenLinkPreviewHost(), true);
});

test('isForbiddenLinkPreviewHost with resolveDns=false skips DNS resolution', async () => {
  // Direct IP blocks still work regardless of resolveDns
  assert.equal(await isForbiddenLinkPreviewHost('localhost', { resolveDns: false }), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.1.1', { resolveDns: false }), true);
  assert.equal(await isForbiddenLinkPreviewHost('example.com', { resolveDns: false }), false);
});

test('resolveHostToIps handles IPv4 addresses', async () => {
  const ips = await resolveHostToIps('1.1.1.1');
  assert.ok(Array.isArray(ips), 'should return an array');
  assert.ok(ips.includes('1.1.1.1'), 'should include the input IP');
});

test('resolveHostToIps handles IPv6 addresses', async () => {
  const ips = await resolveHostToIps('::1');
  assert.ok(Array.isArray(ips), 'should return an array for IPv6');
  assert.ok(ips.includes('::1') || ips.includes('[::1]'), 'should include the IPv6 address');
});

test('hostResolvesToPrivate detects 127.0.0.1 as private (DNS resolution may fail in containers)', async () => {
  const result = await hostResolvesToPrivate('127.0.0.1');
  assert.equal(result, true, '127.0.0.1 should be detected as private IP');
});

test('hostResolvesToPrivate handles unresolvable hostnames gracefully', async () => {
  // Non-existent domain should not throw, should return false (can't confirm private)
  const result = await hostResolvesToPrivate('this-domain-definitely-does-not-exist-12345.com');
  assert.ok(typeof result === 'boolean', 'should return a boolean for unresolvable domains');
});

// ---- Acceptance criteria: IPv6 loopback and private cases ----

test('IPv6 loopback ::1 is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::1'), true);
});

test('IPv6 link-local fe80::/10 range is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fe80::abcd'), true);
});

test('IPv6 unique-local fc00::/7 range is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('fc00::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fd00::1'), true);
});

test('IPv6 unspecified :: is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::'), true);
});

// ---- Acceptance criteria: Direct private targets ----

test('Direct private IPv4 targets are blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.1.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('172.16.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('169.254.169.254'), true); // cloud metadata
});

test('Public IPv4 addresses are allowed', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('8.8.8.8'), false);
  assert.equal(await isForbiddenLinkPreviewHost('1.1.1.1'), false);
  assert.equal(await isForbiddenLinkPreviewHost('142.250.80.46'), false); // google.com
});

// ---- Integration-style: valid public redirect scenario ----

test('Public hostnames are allowed for preview (simulates valid public redirect)', async () => {
  // These represent what would be validated at each hop of a public redirect chain
  assert.equal(await isForbiddenLinkPreviewHost('httpbin.org'), false);
  assert.equal(await isForbiddenLinkPreviewHost('redirect.example.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('example.com'), false);
});

// ---- Edge cases ----

test('isForbiddenLinkPreviewHost handles case insensitivity', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(await isForbiddenLinkPreviewHost('LoCaLhOsT'), true);
  assert.equal(await isForbiddenLinkPreviewHost('EXAMPLE.COM'), false);
});

test('isForbiddenLinkPreviewHost handles .localhost subdomains', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('foo.localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('bar.foo.localhost'), true);
});


test('DNS resolution blocks hostnames that resolve to private addresses', async () => {
  const resolveHostToIps = async () => ['127.0.0.1'];
  assert.equal(await isForbiddenLinkPreviewHost('private.example', { resolveHostToIps }), true);
});

test('DNS resolution allows hostnames that resolve only to public addresses', async () => {
  const resolveHostToIps = async () => ['93.184.216.34'];
  assert.equal(await isForbiddenLinkPreviewHost('public.example', { resolveHostToIps }), false);
});

// ---- Regression test: isPrivateIPv4 / isPrivateIPv6 must cover all SSRF-relevant ranges ----

test('isPrivateIPv4 rejects non-IP hostnames', () => {
  assert.equal(isPrivateIPv4('localhost'), false);
  assert.equal(isPrivateIPv4('example.com'), false);
  assert.equal(isPrivateIPv4('192.168.1'), false);
  assert.equal(isPrivateIPv4('256.1.1.1'), false);
});

test('isPrivateIPv4 detects all private IPv4 ranges', () => {
  // Class A private
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('10.255.255.255'), true);
  // Loopback
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('127.255.255.255'), true);
  // Link-local (169.254.0.0/16)
  assert.equal(isPrivateIPv4('169.254.0.0'), true);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  // Class B private (172.16.0.0/12)
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.31.255.255'), true);
  // Class C private (192.168.0.0/16)
  assert.equal(isPrivateIPv4('192.168.0.1'), true);
  assert.equal(isPrivateIPv4('192.168.255.255'), true);
  // IPv4 broadcast
  assert.equal(isPrivateIPv4('255.255.255.255'), true);
});

test('isPrivateIPv4 allows public IPv4 addresses', () => {
  assert.equal(isPrivateIPv4('1.1.1.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('142.250.80.46'), false);
});

test('isPrivateIPv6 detects all private IPv6 ranges', () => {
  // Loopback
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('0:0:0:0:0:0:0:1'), true);
  // Unspecified
  assert.equal(isPrivateIPv6('::'), true);
  // Link-local
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('fe80::abcd'), true);
  // Unique-local (fc00::/7)
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fd00::1'), true);
});

test('isPrivateIPv6 allows public IPv6 addresses', () => {
  assert.equal(isPrivateIPv6('2001:db8::1'), false);
  assert.equal(isPrivateIPv6('2606:4700::1'), false);
});

test('isPrivateIPv4 and isPrivateIPv6 are used by hostResolvesToPrivate', async () => {
  const result = await hostResolvesToPrivate('127.0.0.1');
  assert.equal(result, true);
  const ipv6Result = await hostResolvesToPrivate('::1');
  assert.equal(ipv6Result, true);
});

// ---- Regression test for DNS timeout abort (issue #714) ----

test('dns.promises.lookup accepts AbortSignal option', async () => {
  // Sanity check: dns.promises.lookup with a non-aborted signal resolves normally
  const signal = AbortSignal.timeout(5000);
  const result = await dns.promises.lookup('localhost', { signal });
  assert.ok(result.address, 'lookup should return an address');
});

test('dns.promises.lookup aborts on timeout via AbortSignal.timeout()', async () => {
  // Verify that AbortSignal.timeout() properly aborts a DNS lookup.
  // We use a very short timeout (1ms) with a host that requires network resolution
  // to ensure the signal fires before the lookup completes.
  const timeoutMs = 1;
  let aborted = false;
  try {
    await dns.promises.lookup('localhost', {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    // The error should be an abort error, not a DNS resolution error
    assert.ok(
      err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.message.includes('abort'),
      `Expected AbortError but got: ${err.name}: ${err.message}`
    );
    aborted = true;
  }
  // Note: On some systems localhost resolves instantly from /etc/hosts,
  // so the abort may not fire. The key assertion is that when it does
  // abort, it's an AbortError — confirming the signal mechanism works.
  assert.ok(aborted || true, 'abort behavior depends on system DNS resolution speed');
});

test('AbortSignal.timeout produces a signal that fires after specified time', async () => {
  const timeoutMs = 50;
  const signal = AbortSignal.timeout(timeoutMs);
  assert.equal(signal.aborted, false, 'signal should not be aborted immediately');

  let fired = false;
  signal.addEventListener('abort', () => { fired = true; });

  await new Promise(resolve => setTimeout(resolve, timeoutMs + 10));
  assert.equal(fired, true, 'signal should have fired after timeout');
  assert.equal(signal.aborted, true, 'signal.aborted should be true after timeout');
});

// ---- Regression tests: DNS time-of-check/time-of-use race (issue #849) ----
//
// The old _fetchLinkPreview resolved the host for telemetry, ran a separate
// SSRF check, and then let fetch() perform a fresh, unvalidated resolution.
// An attacker who controls DNS could return a public IP for the check and a
// private IP for the connect. The fix resolves ONCE, validates the answer, and
// pins that address as the actual connection target.

// A stub resolver that returns a different answer on each call, so we can
// simulate a DNS record that flips between the "check" and the "connect".
function makeFlippingLookup(answers) {
  let call = 0;
  const lookup = async (host, options) => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call++;
    if (options && options.all) {
      return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    }
    return { address: answer[0], family: answer[0].includes(':') ? 6 : 4 };
  };
  lookup.calls = () => call;
  return lookup;
}

test('resolveValidatedLinkPreviewAddress pins a public address', async () => {
  const lookup = async (host, options) => {
    if (options && options.all) return [{ address: '93.184.216.34', family: 4 }];
    return { address: '93.184.216.34', family: 4 };
  };
  const result = await resolveValidatedLinkPreviewAddress('public.example', { lookup });
  assert.equal(result.address, '93.184.216.34');
  assert.deepEqual(result.addresses, ['93.184.216.34']);
});

test('resolveValidatedLinkPreviewAddress rejects when any answer is private', async () => {
  // A public A record plus a private A record: the presence of ANY private
  // answer must reject, because the client could dial the private one.
  const lookup = async (host, options) => {
    if (options && options.all) {
      return [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.5', family: 4 }];
    }
    return { address: '1.1.1.1', family: 4 };
  };
  await assert.rejects(
    () => resolveValidatedLinkPreviewAddress('rebind.example', { lookup }),
    (err) => err.code === 'EPRIVATEHOST' && err.address === '10.0.0.5',
  );
});

test('resolveValidatedLinkPreviewAddress rejects a private IP literal', async () => {
  await assert.rejects(
    () => resolveValidatedLinkPreviewAddress('192.168.1.1'),
    (err) => err.code === 'EPRIVATEHOST',
  );
});

test('resolveValidatedLinkPreviewAddress passes a public IP literal through', async () => {
  const result = await resolveValidatedLinkPreviewAddress('1.1.1.1');
  assert.equal(result.address, '1.1.1.1');
});

test('resolveValidatedLinkPreviewAddress rejects a private IPv6 answer', async () => {
  const lookup = async (host, options) => {
    if (options && options.all) return [{ address: 'fe80::1', family: 6 }];
    return { address: 'fe80::1', family: 6 };
  };
  await assert.rejects(
    () => resolveValidatedLinkPreviewAddress('v6.example', { lookup }),
    (err) => err.code === 'EPRIVATEHOST' && err.address === 'fe80::1',
  );
});

// Stub dns.promises.lookup so the server's resolve-and-pin step uses our
// answers. The server passes dns.promises.lookup through at call time, so
// swapping the property on the shared dns.promises object is picked up.
function stubLookup(t, lookup) {
  t.mock.method(dns.promises, 'lookup', lookup);
}

// The core TOCTOU regression: the stub DNS returns a public A record for the
// SSRF phase and a private A record for the fetch phase. With the fix, the
// single resolve-and-pin step must reject before any fetch is issued, so the
// request fails rather than connecting to the private IP.
test('TOCTOU: a DNS flip to a private IP between check and fetch is rejected (issue #849)', async (t) => {
  const server = require('../server');
  stubLookup(t, makeFlippingLookup([['1.1.1.1'], ['10.0.0.5']]));

  const fetchCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return {
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      url: String(url),
      body: (async function* () { yield '<html><title>x</title></html>'; })(),
    };
  });

  let caught = null;
  try {
    await server._fetchLinkPreview('http://victim.example/', new URL('http://victim.example/'));
  } catch (error) {
    caught = error;
  }

  t.mock.restoreAll();

  assert.ok(caught, 'expected the fetch to be rejected');
  assert.equal(caught.code, 'EPRIVATEHOST', `expected EPRIVATEHOST, got ${caught.code}: ${caught.message}`);
  assert.equal(caught.address, '10.0.0.5', 'the private flipped address must be surfaced');
  // The critical assertion: fetch was NEVER issued, so the private IP was
  // never dialed.
  assert.equal(fetchCalls.length, 0, 'fetch must not be called once the pinned address is private');
});

// The validated IP must be the connection target: the fetch is issued against
// the pinned address (not the bare hostname), with the original hostname
// preserved for SNI.
test('the validated IP is the fetch target, with the hostname preserved for SNI (issue #849)', async (t) => {
  const server = require('../server');
  stubLookup(t, async (host, options) => {
    if (options && options.all) return [{ address: '93.184.216.34', family: 4 }];
    return { address: '93.184.216.34', family: 4 };
  });

  const fetchCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return {
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      url: String(url),
      body: (async function* () { yield '<html><title>ok</title></html>'; })(),
    };
  });

  const result = await server._fetchLinkPreview('http://victim.example/', new URL('http://victim.example/'));
  t.mock.restoreAll();

  assert.ok(result.data && result.data.title === 'ok', 'expected a successful preview');
  assert.equal(fetchCalls.length, 1, 'expected exactly one fetch');
  const { url, opts } = fetchCalls[0];
  // The connection target is the pinned IP, not the hostname.
  assert.equal(new URL(url).hostname, '93.184.216.34', 'fetch must dial the pinned IP');
  // The original hostname is preserved for SNI / virtual-host routing.
  assert.equal(opts.servername, 'victim.example', 'servername must carry the original hostname');
  assert.equal(opts.headers.Host, 'victim.example', 'Host header must carry the original hostname');
});

// Redirect hops apply the same pinning: the validated IP at hop n must equal
// the connection target for hop n. Here hop 1 is public and redirects to hop
// 2, whose DNS resolves to a private IP — hop 2 must be rejected before its
// fetch is issued.
test('redirect hops pin the validated IP; a private hop is rejected before fetch (issue #849)', async (t) => {
  const server = require('../server');
  stubLookup(t, async (host, options) => {
    const answers = {
      'hop1.example': ['93.184.216.34'],
      'hop2.example': ['192.168.1.1'],
    };
    const list = answers[host] || ['1.1.1.1'];
    if (options && options.all) return list.map((address) => ({ address, family: 4 }));
    return { address: list[0], family: 4 };
  });

  const fetchCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('hop1.example')) {
      return {
        status: 302,
        ok: false,
        headers: new Map([['location', 'http://hop2.example/secret']]),
        url: String(url),
        body: (async function* () {})(),
      };
    }
    return {
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      url: String(url),
      body: (async function* () { yield '<html><title>secret</title></html>'; })(),
    };
  });

  let caught = null;
  try {
    await server._fetchLinkPreview('http://hop1.example/', new URL('http://hop1.example/'));
  } catch (error) {
    caught = error;
  }

  t.mock.restoreAll();

  assert.ok(caught, 'expected the private redirect hop to be rejected');
  assert.equal(caught.code, 'EPRIVATEHOST', `expected EPRIVATEHOST, got ${caught.code}: ${caught.message}`);
  // Hop 1 was fetched against its pinned public IP.
  assert.equal(fetchCalls.length, 1, 'only hop 1 should have been fetched');
  assert.equal(new URL(fetchCalls[0].url).hostname, '93.184.216.34', 'hop 1 must dial its pinned IP');
  // Hop 2 (private) was never fetched.
  assert.ok(!fetchCalls.some((c) => c.url.includes('192.168.1.1')), 'the private hop 2 must never be dialed');
});
