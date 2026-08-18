/**
 * Contract tests for SSE broadcast backpressure (issue #786).
 *
 * broadcastToSseClients() must not buffer writes to a stalled client without
 * bound: when client.write() returns false (or the socket's writable queue
 * exceeds SSE_MAX_WRITABLE_BYTES), the client is dropped so memory cannot
 * grow without limit for the lifetime of a stalled-but-open connection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sseClients,
  broadcastToSseClients,
  dropSseClient,
  SSE_MAX_WRITABLE_BYTES,
} = require('../server');

function makeStalledClient() {
  const written = [];
  return {
    written,
    writableLength: 0,
    write(chunk) {
      written.push(chunk);
      return false; // simulate a stalled socket: everything is buffered
    },
    end() {
      this.ended = true;
    },
  };
}

function makeHealthyClient() {
  const written = [];
  return {
    written,
    writableLength: 0,
    write(chunk) {
      written.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

test('SSE broadcast drops a client whose write() returns false (backpressure)', () => {
  sseClients.clear();
  const stalled = makeStalledClient();
  sseClients.add(stalled);

  broadcastToSseClients('gateway-event', { type: 'chat' });

  assert.equal(sseClients.has(stalled), false, 'stalled client should be removed from sseClients');
  assert.equal(stalled.ended, true, 'stalled client should be ended');
});

test('SSE broadcast drops a client whose writableLength exceeds the bound', () => {
  sseClients.clear();
  const slow = makeHealthyClient();
  slow.writableLength = SSE_MAX_WRITABLE_BYTES + 1;
  sseClients.add(slow);

  broadcastToSseClients('gateway-event', { type: 'chat' });

  assert.equal(sseClients.has(slow), false, 'over-bound client should be removed from sseClients');
  assert.equal(slow.ended, true, 'over-bound client should be ended');
});

test('SSE broadcast keeps healthy clients and stops buffering to dropped ones', () => {
  sseClients.clear();
  const stalled = makeStalledClient();
  const healthy = makeHealthyClient();
  sseClients.add(stalled);
  sseClients.add(healthy);

  broadcastToSseClients('gateway-event', { type: 'chat' });
  broadcastToSseClients('gateway-event', { type: 'chat' });

  assert.equal(sseClients.has(stalled), false, 'stalled client should be dropped');
  assert.equal(sseClients.has(healthy), true, 'healthy client should stay connected');
  assert.ok(stalled.written.length <= 1, 'stalled client should receive at most one write before being dropped');
  assert.equal(healthy.written.length, 2, 'healthy client should receive every event');
});

test('dropSseClient removes the client from the set and ends it', () => {
  sseClients.clear();
  const client = makeHealthyClient();
  sseClients.add(client);

  dropSseClient(client);

  assert.equal(sseClients.has(client), false);
  assert.equal(client.ended, true);
});

test('dropSseClient tolerates a client that throws on end()', () => {
  sseClients.clear();
  const broken = {
    end() {
      throw new Error('socket already destroyed');
    },
  };
  sseClients.add(broken);

  assert.doesNotThrow(() => dropSseClient(broken));
  assert.equal(sseClients.has(broken), false);
});

test('SSE broadcast tolerates a client whose write() throws', () => {
  sseClients.clear();
  const broken = {
    writableLength: 0,
    write() {
      throw new Error('socket hang up');
    },
    end() {
      this.ended = true;
    },
  };
  sseClients.add(broken);

  assert.doesNotThrow(() => broadcastToSseClients('gateway-event', { type: 'chat' }));
  assert.equal(sseClients.has(broken), false, 'broken client should be dropped');
  assert.equal(broken.ended, true);
});
