// Regression test for #780: the link preview overall-timeout was
// implemented as a setTimeout that threw from a timer callback, so a slow
// upstream could take down the Node process via an uncaughtException.
// The fix wires the overall budget through an AbortController so the
// fetch aborts and the function returns a phased 504 timeout error
// while the process stays alive.

// Pin the timeout env vars BEFORE requiring server.js so the values
// are in place when the server module reads them at load time.
// Without pinning, a CI environment that exports a larger overall
// budget would let the 7.5s trickle stream below complete and turn
// this test from a "timeout abort" check into a false positive
// successful-preview check.
process.env.LINK_PREVIEW_TIMEOUT_MS = '1000';
process.env.LINK_PREVIEW_BODY_READ_TIMEOUT_MS = '5000';
// Disable auth for this test so the route-level assertion can hit
// the link-preview endpoint without going through the login flow.
process.env.AUTH_MODE = 'none';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Allow 127.0.0.1 (and other loopback) hosts in this test: the SSRF
// guard would normally block them, but the bug being fixed only
// manifests when the function actually reaches a fetch, so we have
// to bypass that guard to exercise the overall-timeout path.
const ssrfModule = require('../lib/ssrf-validation');
const originalIsForbidden = ssrfModule.isForbiddenLinkPreviewHost;
ssrfModule.isForbiddenLinkPreviewHost = async () => false;

const server = require('../server');
const { app } = server;

// Default overall budget is 5s. We trickle chunks every 250ms for ~7s
// so the body-read phase (30s) outlives the overall budget (5s) and
// the overall timer is guaranteed to fire while the body is still
// streaming.
const TRICKLE_INTERVAL_MS = 250;
const TRICKLE_CHUNKS = 30; // 30 * 250ms = 7.5s, well over the 5s overall budget

async function startTrickleServer() {
  const serverInstance = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= TRICKLE_CHUNKS) {
        clearInterval(interval);
        res.end('</html>');
        return;
      }
      if (res.writableEnded || res.destroyed) {
        clearInterval(interval);
        return;
      }
      res.write(`<!-- trickle chunk ${sent} -->`);
      sent++;
    }, TRICKLE_INTERVAL_MS);
    req.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  const { port } = serverInstance.address();
  return { serverInstance, port };
}

test.after(() => {
  ssrfModule.isForbiddenLinkPreviewHost = originalIsForbidden;
});

test('slow upstream trickling body past overall budget no longer crashes the process', async () => {
  const { serverInstance, port } = await startTrickleServer();
  const url = `http://127.0.0.1:${port}/`;

  // If the overall timer ever throws from a setTimeout callback, the
  // process dies before we reach the next assertion. Install a
  // process-level listener that records any uncaught exception; the
  // assertion at the end fails the test if one fired.
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  let caughtError = null;
  try {
    await server._fetchLinkPreview(url, new URL(url));
  } catch (error) {
    caughtError = error;
  }

  // Phased overall timeout error: must look like an AbortError with
  // phase 'overall' so the route handler returns 504.
  assert.ok(caughtError, 'expected a phased timeout error to be thrown');
  assert.equal(
    caughtError.name,
    'AbortError',
    `expected AbortError, got ${caughtError.name}: ${caughtError.message}`,
  );
  assert.equal(
    caughtError.phase,
    'overall',
    `expected phase 'overall', got ${caughtError.phase}`,
  );
  assert.ok(
    typeof caughtError.ms === 'number' && caughtError.ms > 0,
    `expected a positive ms, got ${caughtError.ms}`,
  );

  // Give a short window for any latent uncaughtException to surface,
  // then verify the process is still alive and that no uncaught
  // exception fired from the timer callback.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    uncaught.length,
    0,
    `uncaughtException fired: ${uncaught.map((e) => e.stack || e.message).join('\n')}`,
  );

  process.off('uncaughtException', onUncaught);
  await new Promise((resolve) => serverInstance.close(resolve));
});

test('overall timer is abort-based, not a throwing setTimeout', () => {
  // Static check: the source must not contain a setTimeout that
  // throws from inside its callback, because that is the pattern
  // that crashed the process.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.ok(
    !/setTimeout\(\s*\(\)\s*=>\s*\{\s*throw/.test(source),
    'server.js must not contain a setTimeout that throws from its callback (issue #780)',
  );
});

test('GET /api/link-preview maps an overall-timeout abort to a 504', async () => {
  // Acceptance criterion 1 also requires the HTTP route to
  // surface the overall-timeout abort as a 504 response, not just
  // _fetchLinkPreview. Mount the express app on a random local
  // port, point it at a slow trickle server, and assert the route
  // returns 504 with phase 'overall' (and the process survives).
  const trickle = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<!doctype html><html><head><title>x</title></head><body>');
    const trickleInterval = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write('<p>tick</p>');
        } catch (_) {
          clearInterval(trickleInterval);
        }
      } else {
        clearInterval(trickleInterval);
      }
    }, 200);
    // Hold the response open long enough for the overall budget
    // (1s, pinned at the top of this file) to fire and the route
    // to respond with 504.
    setTimeout(() => {
      clearInterval(trickleInterval);
      try { res.end('</body></html>'); } catch (_) { /* ignore */ }
    }, 5000);
  });
  await new Promise((resolve) => trickle.listen(0, '127.0.0.1', resolve));
  const tricklePort = trickle.address().port;
  const trickleUrl = `http://127.0.0.1:${tricklePort}/slow`;

  const routeApp = http.createServer(app);
  await new Promise((resolve) => routeApp.listen(0, '127.0.0.1', resolve));
  const routePort = routeApp.address().port;

  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  try {
    const { status, body } = await new Promise((resolve, reject) => {
      const path = `/api/link-preview?url=${encodeURIComponent(trickleUrl)}`;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: routePort,
          path,
          method: 'GET',
          timeout: 10000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(
      status,
      504,
      `expected 504 from /api/link-preview on overall-timeout, got ${status}: ${body}`,
    );
    // The route should also label the failure with phase='overall'
    // so the client can distinguish it from DNS / connect / body
    // timeouts. The route embeds the phase in the error message
    // text (e.g. "Preview fetch timed out during overall phase
    // after 1000ms") rather than as a separate JSON field, so
    // assert on the human-readable message containing 'overall'.
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
    const message = parsed && parsed.error ? String(parsed.error) : body;
    assert.ok(
      /overall/.test(message),
      `expected /api/link-preview error message to mention 'overall' phase, got: ${message}`,
    );

    // Process must still be alive: no uncaughtException should
    // have fired from a throwing timer callback.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      uncaught.length,
      0,
      `uncaughtException fired during route-level test: ${uncaught.map((e) => e.stack || e.message).join('\n')}`,
    );
  } finally {
    process.off('uncaughtException', onUncaught);
    await new Promise((resolve) => routeApp.close(resolve));
    await new Promise((resolve) => trickle.close(resolve));
  }
});
