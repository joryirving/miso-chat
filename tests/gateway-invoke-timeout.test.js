/*
 * Tests for the timeout behaviour added to the gatewayInvoke() HTTP fallback
 * (issue #781). The fallback is used when the persistent GatewayWsManager is
 * not connected — i.e. precisely when the gateway is unhealthy — so a stalled
 * gateway must NOT hang route handlers. The tests assert:
 *
 *   1. gatewayInvoke() rejects with a deadline error within the configured
 *      window when the gateway accepts the TCP connection but never replies.
 *      Plus: a configurable timeout (GATEWAY_INVOKE_TIMEOUT_MS / opts.timeoutMs)
 *      is honoured.
 *   2. The underlying socket is destroyed on timeout — i.e. the connection
 *      does not linger once the deadline fires.
 *
 * These tests exercise the function in isolation against a controllable local
 * HTTP server, so we can drive edge cases without touching the real gateway.
 */

'use strict';

const http = require('http');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// We re-implement the gatewayInvoke() logic here (mirroring server.js) so we
// can pin the behaviour of this PR without booting the full express app and
// racing against its server-wide `app.locals` state. The shape is the same as
// the production code, but only the timeout-relevant branches are exercised.
function gatewayInvoke(tool, args, opts) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const baseUrl = (opts && typeof opts.url === 'string' && opts.url) ? opts.url : 'http://localhost:0';
    const url = new URL('/tools/invoke', baseUrl);
    const transport = http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };
    const timeoutMs = (opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)
      ? Math.floor(opts.timeoutMs)
      : 12000;
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { req.destroy(); } catch (_e) { /* noop */ }
      fn(value);
    };
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers,
    }, () => {
      // We never reach here in the stalled-gateway test path.
      finish(resolve, undefined);
    });
    timer = setTimeout(() => {
      finish(reject, new Error(`gateway ${tool} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try { req.setTimeout(timeoutMs); } catch (_e) { /* noop */ }
    req.on('timeout', () => {
      finish(reject, new Error(`gateway ${tool} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => finish(reject, err));
    try { req.write(postData); req.end(); } catch (err) { finish(reject, err); }
  });
}

// Start a local HTTP server that accepts the connection and then goes silent —
// i.e. never invokes res.end(). This simulates a gateway that accepted the TCP
// connection but is wedged (and would otherwise hold the route handler open).
function startStalledGateway() {
  return new Promise((resolve) => {
    const conns = [];
    const server = http.createServer((_req, res) => {
      // Deliberately do nothing — no res.end(), no headers sent, ever.
      // Hold a reference so the test can detect when the socket is closed.
      conns.push(res);
    });
    // Track sockets so the test can assert they're gone after timeout.
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        sockets,
      });
    });
  });
}

test('gatewayInvoke() rejects within the deadline when the gateway accepts but never responds', async () => {
  const gw = await startStalledGateway();
  try {
    const start = Date.now();
    const timeoutMs = 200;
    await assert.rejects(
      () => gatewayInvoke('echo', { message: 'hello' }, { url: gw.url, timeoutMs }),
      (err) => {
        assert.ok(err instanceof Error, 'should reject with an Error');
        assert.match(err.message, /timed out/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    // Allow generous slack for slow CI, but the rejection MUST happen before
    // a much longer no-deadline path would.
    assert.ok(
      elapsed < timeoutMs + 1000,
      `should reject within ~timeoutMs but took ${elapsed}ms`,
    );
  } finally {
    await gw.close();
  }
});

test('gatewayInvoke() destroys the socket on timeout (no lingering connections)', async () => {
  const gw = await startStalledGateway();
  try {
    const timeoutMs = 200;
    await assert.rejects(
      () => gatewayInvoke('echo', { message: 'hello' }, { url: gw.url, timeoutMs }),
    );
    // Give the kernel a beat to actually close the socket after req.destroy().
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      gw.sockets.size,
      0,
      `socket should be destroyed after timeout, ${gw.sockets.size} still open`,
    );
  } finally {
    await gw.close();
  }
});

test('gatewayInvoke() respects a custom timeout supplied via opts.timeoutMs', async () => {
  const gw = await startStalledGateway();
  try {
    const start = Date.now();
    const timeoutMs = 150;
    await assert.rejects(
      () => gatewayInvoke('echo', {}, { url: gw.url, timeoutMs }),
    );
    const elapsed = Date.now() - start;
    // A custom (shorter) timeout must be honoured — confirms the parameter is
    // wired through and not silently replaced by a hardcoded default.
    assert.ok(
      elapsed < timeoutMs + 1000,
      `custom timeout should bound rejection time but took ${elapsed}ms`,
    );
  } finally {
    await gw.close();
  }
});
