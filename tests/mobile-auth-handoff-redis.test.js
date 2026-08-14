'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Ensure REDIS_URL is not set so initMobileAuthRedis() does not try to dial.
delete process.env.REDIS_URL;

const authSession = require('../lib/auth-session');
const {
  issueMobileAuthToken,
  consumeMobileAuthToken,
  _setMobileAuthHandoffRedisForTesting,
} = authSession;

function createFakeRedis() {
  const store = new Map();
  const calls = [];
  return {
    calls,
    store,
    async set(key, value) {
      calls.push(['set', key, value]);
      store.set(key, value);
      return 'OK';
    },
    async setWithEx(key, value, opts) {
      calls.push(['set', key, value, opts]);
      store.set(key, value);
      return 'OK';
    },
    async getDel(key) {
      calls.push(['getDel', key]);
      const v = store.get(key);
      store.delete(key);
      return v ?? null;
    },
  };
}

test('mobile auth handoff: writes token to Redis with EX TTL when configured', async () => {
  const fake = createFakeRedis();
  // Patch set to capture the EX option.
  fake.set = async (key, value, opts) => fake.setWithEx(key, value, opts);
  _setMobileAuthHandoffRedisForTesting(fake);

  const token = issueMobileAuthToken({ id: 'u-ttl' });
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 48);

  // Allow the fire-and-forget Redis write to resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const setCall = fake.calls.find((c) => c[0] === 'set');
  assert.ok(setCall, 'expected a Redis set call');
  assert.equal(setCall[1], 'miso-chat:mobile-auth:' + token);
  assert.ok(setCall[2]);
  const parsed = JSON.parse(setCall[2]);
  assert.equal(parsed.user.id, 'u-ttl');
  assert.ok(parsed.expiresAt > Date.now());
  assert.ok(setCall[3] && setCall[3].EX >= 1, 'expected EX TTL >= 1s');
});

test('mobile auth handoff: consume succeeds from Redis after in-memory map reset', async () => {
  const fake = createFakeRedis();
  fake.set = async (key, value, opts) => fake.setWithEx(key, value, opts);
  _setMobileAuthHandoffRedisForTesting(fake);

  const user = { id: 'u-restart' };
  const token = issueMobileAuthToken(user);

  // Allow the fire-and-forget Redis write to resolve.
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Simulate restart / different replica by clearing the in-memory map
  // (and any internal module state the test can reach). The fake Redis
  // still holds the handoff, so consume must still succeed.
  const { mobileAuthHandoffs } = require('../lib/auth-session');
  mobileAuthHandoffs.clear();

  const resolved = await consumeMobileAuthToken(token);
  assert.ok(resolved, 'expected consume to succeed from Redis');
  assert.equal(resolved.id, 'u-restart');
});

test('mobile auth handoff: unknown token returns null when Redis is configured', async () => {
  const fake = createFakeRedis();
  _setMobileAuthHandoffRedisForTesting(fake);

  const result = await consumeMobileAuthToken('nope-not-a-real-token');
  assert.equal(result, null);
});

test('mobile auth handoff: falls back to in-memory map when no Redis client', async () => {
  _setMobileAuthHandoffRedisForTesting(null);

  // Force re-init with no REDIS_URL set: returns false sentinel.
  delete process.env.REDIS_URL;
  // Re-issue using a fresh token; consume should still work via Map.
  const token = issueMobileAuthToken({ id: 'u-mem' });
  const resolved = await consumeMobileAuthToken(token);
  assert.ok(resolved);
  assert.equal(resolved.id, 'u-mem');
});

test('mobile auth handoff: malformed Redis payload is treated as invalid, not a 500', async () => {
  const fake = createFakeRedis();
  fake.store.set('miso-chat:mobile-auth:corrupt-token', 'this is not json {');
  _setMobileAuthHandoffRedisForTesting(fake);

  const resolved = await consumeMobileAuthToken('corrupt-token');
  assert.equal(resolved, null);
});