/**
 * Authenticated route-level tests for the reactions API (issue #815).
 *
 * Covers the layer tests/db.test.js (SQLite primitive) and
 * tests/authz-integration.test.js (unauthenticated non-200 only) do not:
 *   - POST toggle add -> remove contract
 *   - input validation: missing emoji / sessionKey -> 400
 *   - oversized / malformed emoji -> 400 and nothing stored
 *   - GET batch-loading responses in the grouped shape lib/db.js produces
 *
 * The reactions store is a fake that mirrors lib/db.js semantics exactly:
 * toggle dedups on the (message_id, session_key, emoji, username) tuple,
 * getForMessage returns [{ emoji, count, users }], and getForSession
 * returns { [messageId]: { [emoji]: [usernames] } }.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const { createReactionsRoutes } = require('../lib/routes/reactions');

function createFakeReactions() {
  const rows = [];
  const keyOf = (messageId, sessionKey, emoji, username) =>
    [messageId, sessionKey, emoji, username].join('\u0000');

  return {
    toggle(messageId, sessionKey, emoji, username) {
      const key = keyOf(messageId, sessionKey, emoji, username);
      const idx = rows.findIndex((r) => keyOf(r.messageId, r.sessionKey, r.emoji, r.username) === key);
      const added = idx === -1;
      if (added) rows.push({ messageId, sessionKey, emoji, username });
      else rows.splice(idx, 1);
      return { added, emoji };
    },
    getForMessage(messageId, sessionKey) {
      const filtered = rows.filter(
        (r) => r.messageId === messageId && (sessionKey === null || r.sessionKey === sessionKey),
      );
      const grouped = {};
      for (const r of filtered) {
        if (!grouped[r.emoji]) grouped[r.emoji] = [];
        grouped[r.emoji].push(r.username);
      }
      return Object.entries(grouped).map(([emoji, users]) => ({
        emoji,
        count: users.length,
        users,
      }));
    },
    getForSession(sessionKey) {
      const grouped = {};
      for (const r of rows) {
        if (r.sessionKey !== sessionKey) continue;
        if (!grouped[r.messageId]) grouped[r.messageId] = {};
        if (!grouped[r.messageId][r.emoji]) grouped[r.messageId][r.emoji] = [];
        grouped[r.messageId][r.emoji].push(r.username);
      }
      return grouped;
    },
    // Exposed for "stores nothing" assertions.
    _rows: rows,
  };
}

async function withApp(store, run) {
  const app = express();
  app.use(express.json());
  app.use('/api', createReactionsRoutes({
    isAuthenticated: (req, res, next) => {
      req.user = { username: 'tester' };
      next();
    },
    requireSessionAccess: () => (req, res, next) => next(),
    authMode: 'none',
    reactions: store,
  }));
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

function postJson(base, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      new URL(path, base),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function getJson(base, path) {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    }).on('error', reject);
  });
}

test('POST toggle add -> remove contract', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const path = '/api/messages/msg-1/reactions';

    const add = await postJson(base, path, { emoji: '👍', sessionKey: 'sk-1' });
    assert.equal(add.statusCode, 200);
    assert.equal(add.body.success, true);
    assert.equal(add.body.added, true);
    assert.equal(add.body.emoji, '👍');
    assert.equal(store._rows.length, 1);

    const remove = await postJson(base, path, { emoji: '👍', sessionKey: 'sk-1' });
    assert.equal(remove.statusCode, 200);
    assert.equal(remove.body.success, true);
    assert.equal(remove.body.added, false);
    assert.equal(store._rows.length, 0);
  });
});

test('POST toggle is isolated per sessionKey', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const path = '/api/messages/msg-1/reactions';

    const addA = await postJson(base, path, { emoji: '👍', sessionKey: 'sk-a' });
    assert.equal(addA.body.added, true);

    // Same message + emoji in a different session is a distinct reaction.
    const addB = await postJson(base, path, { emoji: '👍', sessionKey: 'sk-b' });
    assert.equal(addB.body.added, true);
    assert.equal(store._rows.length, 2);

    // Removing in sk-a leaves the sk-b reaction intact.
    const removeA = await postJson(base, path, { emoji: '👍', sessionKey: 'sk-a' });
    assert.equal(removeA.body.added, false);
    assert.equal(store._rows.length, 1);
    assert.equal(store._rows[0].sessionKey, 'sk-b');
  });
});

test('POST missing emoji returns 400 and stores nothing', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const res = await postJson(base, '/api/messages/msg-1/reactions', { sessionKey: 'sk-1' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(store._rows.length, 0);
  });
});

test('POST missing sessionKey returns 400 and stores nothing', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const res = await postJson(base, '/api/messages/msg-1/reactions', { emoji: '👍' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(store._rows.length, 0);
  });
});

test('POST oversized emoji returns 400 and stores nothing', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const oversized = '👍'.repeat(101);
    const res = await postJson(base, '/api/messages/msg-1/reactions', {
      emoji: oversized,
      sessionKey: 'sk-1',
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(store._rows.length, 0);
  });
});

test('POST malformed (non-string) emoji returns 400 and stores nothing', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const res = await postJson(base, '/api/messages/msg-1/reactions', {
      emoji: { nested: 'object' },
      sessionKey: 'sk-1',
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(store._rows.length, 0);
  });
});

test('GET message reactions returns the grouped shape', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const path = '/api/messages/msg-1/reactions';
    await postJson(base, path, { emoji: '👍', sessionKey: 'sk-1' });
    await postJson(base, path, { emoji: '🎉', sessionKey: 'sk-1' });

    const res = await getJson(base, '/api/messages/msg-1/reactions?sessionKey=sk-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.messageId, 'msg-1');
    assert.equal(res.body.sessionKey, 'sk-1');
    assert.deepEqual(res.body.reactions, [
      { emoji: '👍', count: 1, users: ['tester'] },
      { emoji: '🎉', count: 1, users: ['tester'] },
    ]);
  });
});

test('GET session reactions returns the batch-loaded grouped shape', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    await postJson(base, '/api/messages/msg-1/reactions', { emoji: '👍', sessionKey: 'sk-1' });
    await postJson(base, '/api/messages/msg-2/reactions', { emoji: '👍', sessionKey: 'sk-1' });
    await postJson(base, '/api/messages/msg-2/reactions', { emoji: '🎉', sessionKey: 'sk-1' });
    // A reaction in another session must not leak into this session's batch.
    await postJson(base, '/api/messages/msg-1/reactions', { emoji: '👍', sessionKey: 'sk-2' });

    const res = await getJson(base, '/api/reactions/sk-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.sessionKey, 'sk-1');
    assert.deepEqual(res.body.reactions, {
      'msg-1': { '👍': ['tester'] },
      'msg-2': { '👍': ['tester'], '🎉': ['tester'] },
    });
  });
});
