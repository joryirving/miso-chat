'use strict';

/**
 * Regression test for #782: the `/lib` static route must serve only the
 * browser-loaded modules that public/index.html references. Server-only
 * modules (auth-session, db, ssrf-validation, etc.) must not be reachable
 * unauthenticated. The /lib mount is intentionally not installed — the
 * six browser modules are served by `express.static('public')` because
 * they live under public/lib/.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

function startApp() {
  const app = express();
  // Mirror the production-relevant static mounts (no /lib mount).
  app.use(express.static('public', { index: false }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function get(base, urlPath) {
  const res = await fetch(`${base}${urlPath}`);
  return {
    status: res.status,
    body: await res.text(),
  };
}

test('lib static route: allowlisted browser module is served', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  // Sanity: the allowlisted file must exist on disk.
  const onDisk = path.join(__dirname, '..', 'public', 'lib', 'render-utils.js');
  assert.ok(fs.existsSync(onDisk), `expected ${onDisk} to exist`);

  const r = await get(base, '/lib/render-utils.js');
  assert.equal(r.status, 200, 'GET /lib/render-utils.js should return 200');
  assert.ok(r.body.length > 0, 'response body should be non-empty');
});

test('lib static route: server-only modules return 404', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const name of ['db.js', 'auth-session.js', 'ssrf-validation.js']) {
    const r = await get(base, `/lib/${name}`);
    assert.equal(r.status, 404, `GET /lib/${name} should return 404`);
  }
});

test('lib static route: single-encoded path traversal does not serve server-only files', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  // %2F is a URL-encoded '/'. /lib/..%2Fdb.js must not resolve to lib/db.js.
  const r = await get(base, '/lib/..%2Fdb.js');
  assert.notEqual(r.status, 200, 'encoded traversal must not yield server-only file');
});

test('lib static route: double-encoded traversal is rejected', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  // %252F is a double-encoded '/'. Must not yield lib/db.js.
  const r = await get(base, '/lib/..%252Fdb.js');
  assert.notEqual(r.status, 200, 'double-encoded traversal must not yield server-only file');
});

test('lib static route: null byte injection does not bypass extension', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  // Append a %00 (null byte) then .js. Some legacy static servers truncate
  // at the null byte and serve the parent path. express.static must not.
  const r = await get(base, '/lib/db.js%00.js');
  assert.notEqual(r.status, 200, 'null-byte injection must not serve a server-only file');
});

test('lib static route: no symlinks in public/lib/ escape the public root', async (t) => {
  const { server, port, base } = await startApp();
  t.after(() => server.close());

  // If anyone ever drops a symlink in public/lib/ pointing outside public/,
  // express.static would happily follow it. Verify that the public/lib/
  // directory contains no symlinks today.
  const publicLib = path.join(__dirname, '..', 'public', 'lib');
  const entries = fs.readdirSync(publicLib, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(publicLib, entry.name);
    const st = fs.lstatSync(full);
    assert.ok(!st.isSymbolicLink(), `${entry.name} must not be a symlink`);
  }
});

test('lib static route: allowlisted browser modules (full set) are served', async (t) => {
  const { server, port, base } = await startApp();
  t.after(() => server.close());

  const expected = [
    'api-client.js',
    'capacitor-detect.js',
    'reaction-events-browser.js',
    'render-utils.js',
    'secure-storage.js',
    'session-key-hydration.js',
  ];
  for (const name of expected) {
    const r = await get(base, `/lib/${name}`);
    assert.equal(r.status, 200, `GET /lib/${name} should return 200`);
  }
});
