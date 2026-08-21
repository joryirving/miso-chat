const test = require('node:test');
const assert = require('node:assert/strict');

// Import the side-effect-free pruning module directly (not server.js) so this
// test does not open the SQLite DB at module load — which would cause
// SQLITE_BUSY when node --test runs files in parallel.
const {
  gatewaySessionSubscriptions,
  noteGatewaySessionSubscription,
  pruneIdleGatewaySessionSubscriptions,
  GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS,
} = require('../lib/gateway-session-subscriptions');

test('prunes idle gateway session subscriptions but keeps active ones', () => {
  gatewaySessionSubscriptions.clear();
  const now = Date.now();

  noteGatewaySessionSubscription('agent:main:active', now);
  noteGatewaySessionSubscription('agent:main:idle', now - (GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS + 1000));

  const pruned = pruneIdleGatewaySessionSubscriptions(now);

  assert.equal(pruned, 1, 'only the idle subscription should be pruned');
  assert.ok(gatewaySessionSubscriptions.has('agent:main:active'), 'active subscription retained');
  assert.ok(!gatewaySessionSubscriptions.has('agent:main:idle'), 'idle subscription removed');
});

test('set returns to a bounded size after repeated sends and pruning', () => {
  gatewaySessionSubscriptions.clear();
  const now = Date.now();

  for (let i = 0; i < 50; i++) {
    noteGatewaySessionSubscription(`agent:main:session-${i}`, now - (GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS + 1000 + i));
  }
  assert.equal(gatewaySessionSubscriptions.size, 50, 'all keys retained before prune');

  pruneIdleGatewaySessionSubscriptions(now);
  assert.equal(gatewaySessionSubscriptions.size, 0, 'all idle keys pruned');
});

test('re-touching a subscription refreshes its idle window', () => {
  gatewaySessionSubscriptions.clear();
  const now = Date.now();

  noteGatewaySessionSubscription('agent:main:x', now - (GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS + 1000));
  noteGatewaySessionSubscription('agent:main:x', now); // re-touched

  pruneIdleGatewaySessionSubscriptions(now);
  assert.ok(gatewaySessionSubscriptions.has('agent:main:x'), 're-touched subscription retained');
});
