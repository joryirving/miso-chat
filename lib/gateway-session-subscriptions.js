/**
 * Pruning for gatewaySessionSubscriptions.
 *
 * Without pruning, gatewaySessionSubscriptions only ever receives .add() and
 * never a .delete(), so every distinct session key touched over the process
 * lifetime is retained forever — unbounded memory growth, and on every gateway
 * WS reconnect the connected handler re-issues sessions.messages.subscribe for
 * every session ever messaged (see #811).
 *
 * This module is side-effect-free: it exports pure functions and a Map that
 * server.js owns.  Tests can import this file without loading server.js (and
 * thus without opening the SQLite DB).
 */

const gatewaySessionSubscriptions = new Set();
const gatewaySessionSubscriptionLastSeen = new Map();
const GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record that a session key was just used for a gateway subscription.
 * Called from subscribeToGatewaySession (send / send-stream / history paths).
 */
function noteGatewaySessionSubscription(key, now = Date.now()) {
  const k = String(key || '').trim();
  if (!k) return;
  gatewaySessionSubscriptions.add(k);
  gatewaySessionSubscriptionLastSeen.set(k, now);
}

/**
 * Remove session keys that have been idle longer than the TTL.
 * Also cleans activeGatewaySessionSubscriptions so the reconnect handler
 * doesn't re-subscribe stale sessions.
 */
function pruneIdleGatewaySessionSubscriptions(now = Date.now()) {
  let pruned = 0;
  for (const key of gatewaySessionSubscriptions) {
    const lastSeen = gatewaySessionSubscriptionLastSeen.get(key);
    if (lastSeen === undefined || now - lastSeen > GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS) {
      gatewaySessionSubscriptions.delete(key);
      gatewaySessionSubscriptionLastSeen.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

module.exports = {
  gatewaySessionSubscriptions,
  noteGatewaySessionSubscription,
  pruneIdleGatewaySessionSubscriptions,
  GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS,
};
