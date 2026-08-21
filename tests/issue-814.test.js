/**
 * Tests for #814 — Mobile OTA bundle MUST be installed only after
 * digest/signature verification. Acceptance:
 *   1. A manifest with a tampered bundle digest does not install.
 *   2. A manifest lacking a digest is not applied.
 *   3. validateManifest rejects a channel that omits digestAlgorithm/digest.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateManifest,
  validateSchema,
  verifyDigest,
  verifyChannelDigest,
} = require('../lib/mobile-manifest-validator');

function makeManifest(channelOverrides = {}) {
  return Object.assign({
    version: '1.2.3',
    tag: 'v1.2.3',
    channels: {
      stable: {
        version: '1.2.3',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v1.2.3/dist.js',
        digest: '69f5c19b96bff62e61f0d6feed0f1dd5ee45e7df6f6e1b81bd95b6b1f48a4cdb',
        digestAlgorithm: 'sha-256',
      },
    },
  }, channelOverrides);
}

test('validateManifest requires digestAlgorithm on every channel', () => {
  const m = makeManifest();
  delete m.channels.stable.digestAlgorithm;
  const r = validateManifest(m, { repoOwner: 'misospace', repoName: 'miso-chat' });
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => /digestAlgorithm/.test(e)),
    `expected error to mention digestAlgorithm, got: ${JSON.stringify(r.errors)}`,
  );
});

test('validateManifest requires digest on every channel', () => {
  const m = makeManifest();
  delete m.channels.stable.digest;
  const r = validateManifest(m, { repoOwner: 'misospace', repoName: 'miso-chat' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /digest/.test(e)));
});

test('validateSchema rejects a channel missing both digestAlgorithm and digest', () => {
  const m = makeManifest();
  delete m.channels.stable.digestAlgorithm;
  delete m.channels.stable.digest;
  const r = validateSchema(m);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /digest/.test(e)));
});

test('verifyDigest returns invalid when manifest lacks a digestAlgorithm (no silent pass)', () => {
  const channel = { bundleUrl: 'https://example.com/x' };
  const r = verifyDigest(channel, Buffer.from('payload'), 'deadbeef');
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 1);
});

test('verifyDigest returns invalid when expectedDigest is missing', () => {
  const channel = { digestAlgorithm: 'sha-256' };
  const r = verifyDigest(channel, Buffer.from('payload'), null);
  assert.equal(r.valid, false);
});

test('verifyDigest returns invalid on tampered payload digest mismatch', () => {
  const payload = Buffer.from('hello world');
  const realDigest = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
  const channel = { digestAlgorithm: 'sha-256' };
  // expectedDigest deliberately tampered
  const r = verifyDigest(channel, payload, '00'.repeat(32));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /mismatch/.test(e)), `expected mismatch error, got: ${JSON.stringify(r.errors)}`);
  // sanity: the real digest does match
  const ok = verifyDigest(channel, payload, realDigest);
  assert.equal(ok.valid, true);
});

test('verifyChannelDigest refuses a channel that omits digest + algorithm', () => {
  const channel = { version: '1.0.0', bundleUrl: 'https://example.com/bundle.js' };
  const r = verifyChannelDigest(channel, Buffer.from('payload bytes'));
  assert.equal(r.valid, false);
});

test('verifyChannelDigest refuses a tampered bundle (digest mismatch)', () => {
  const payload = Buffer.from('payload bytes');
  const channel = {
    version: '1.0.0',
    bundleUrl: 'https://example.com/bundle.js',
    digestAlgorithm: 'sha-256',
    digest: 'ff'.repeat(32), // wrong
  };
  const r = verifyChannelDigest(channel, payload);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /mismatch/.test(e)));
});

test('client update() refuses install when digest is missing (defense-in-depth)', async () => {
  // Load the client script in a sandbox where we mock window/crypto/fetch/updater.
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js'), 'utf8');

  const window = {};
  window.crypto = require('node:crypto').webcrypto;
  window.Capacitor = {};
  window.CapacitorUpdater = {
    // If we ever reach set(), the test fails.
    download: async () => { throw new Error('updater.download should not be called when digest missing'); },
    set: async () => { throw new Error('updater.set should not be called when digest missing'); },
    getCurrent: async () => ({ version: '0.0.0' }),
  };
  window.addEventListener = () => {};
  const sandbox = {
    window,
    self: window,
    document: { body: { appendChild() {} }, createElement() { return { innerHTML: '', classList: { add() {}, remove() {} } }; } },
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    crypto: window.crypto,
    console: { ...console, warn() {}, error() {}, log: console.log.bind(console) },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  const mgr = sandbox.window.MobileUpdateManager;
  mgr.config.debug = false;

  mgr.availableUpdate = {
    version: '1.2.3',
    bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v1.2.3/dist.js',
  };
  const result = await mgr.update();
  assert.equal(result.success, false);
  assert.equal(result.reason, 'missing-digest');
});

test('client update() refuses install when bundle digest does not match manifest', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const crypto = require('node:crypto');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js'), 'utf8');

  const realBundle = Buffer.from('the real bundle bytes');
  const realDigest = crypto.createHash('sha256').update(realBundle).digest('hex');

  // Minimal Response-like object — avoid referencing the global Response
  // (which would lint as undefined in this CommonJS test file).
  function makeResponse(body, status) {
    return {
      ok: status >= 200 && status < 300,
      status: status || 200,
      async arrayBuffer() {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        // Return an ArrayBuffer (the spec type), not a Buffer.
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  }

  function makeSandbox(updater, bundleFn) {
    const window = {};
    window.Capacitor = {};
    window.CapacitorUpdater = updater;
    window.crypto = crypto.webcrypto;
    window.addEventListener = () => {};
    const sandbox = {
      window,
      self: window,
      document: { body: { appendChild() {} }, createElement() { return { innerHTML: '', classList: { add() {}, remove() {} } }; } },
      fetch: async () => bundleFn(),
      crypto: window.crypto,
      console: { ...console, warn() {}, error() {}, log: console.log.bind(console) },
    };
    return sandbox;
  }

  // 1. Tampered digest -> refused.
  {
    const throwingUpdater = {
      download: async () => { throw new Error('updater.download should not be called when digest mismatch'); },
      set: async () => { throw new Error('updater.set should not be called when digest mismatch'); },
      getCurrent: async () => ({ version: '0.0.0' }),
    };
    const sb = makeSandbox(throwingUpdater, () => makeResponse(realBundle, 200));
    const ctx = vm.createContext(sb);
    vm.runInContext(src, ctx);
    const mgr = sb.window.MobileUpdateManager;
    mgr.config.debug = false;
    mgr.availableUpdate = {
      version: '1.2.3',
      bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v1.2.3/dist.js',
      digest: '00'.repeat(32),
      digestAlgorithm: 'sha-256',
    };
    const result = await mgr.update();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'digest-mismatch');
  }

  // 2. Correct digest -> install proceeds and updater.set is invoked.
  {
    let setCalled = false;
    const goodUpdater = {
      download: async () => ({ version: '1.2.3', id: 'new' }),
      set: async () => { setCalled = true; },
      getCurrent: async () => ({ version: '0.0.0' }),
    };
    const sb = makeSandbox(goodUpdater, () => makeResponse(realBundle, 200));
    const ctx = vm.createContext(sb);
    vm.runInContext(src, ctx);
    const mgr = sb.window.MobileUpdateManager;
    mgr.config.debug = false;
    mgr.availableUpdate = {
      version: '1.2.3',
      bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v1.2.3/dist.js',
      digest: realDigest,
      digestAlgorithm: 'sha-256',
    };
    const ok = await mgr.update();
    assert.equal(ok.success, true);
    assert.equal(setCalled, true);
  }
});
