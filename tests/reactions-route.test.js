/**
 * Route-level test for issue #813: the POST /api/messages/:messageId/reactions
 * toggle endpoint must normalize shortcode emoji through the same
 * normalizeReactionEmoji helper used by the gateway reaction-event path, so
 * `:thumbsup:` and `👍` resolve to one reaction and toggling back removes it.
 *
 * The reactions store is a fake that mirrors lib/db.js toggle semantics:
 * dedup on the exact (message_id, session_key, emoji, username) tuple. If the
 * route stored raw emoji, `:thumbsup:` and `👍` would appear as two reactions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const { createReactionsRoutes } = require('../lib/routes/reactions');

function createFakeReactions() {
  const rows = new Set();
  const keyOf = (messageId, sessionKey, emoji, username) =>
    [messageId, sessionKey, emoji, username].join('\u0000');

  return {
    toggle(messageId, sessionKey, emoji, username) {
      const key = keyOf(messageId, sessionKey, emoji, username);
      const added = !rows.has(key);
      if (added) rows.add(key);
      else rows.delete(key);
      return { added, emoji };
    },
    getForMessage(messageId, sessionKey) {
      const emojis = new Set();
      for (const key of rows) {
        const [m, s, e] = key.split('\u0000');
        if (m === messageId && s === sessionKey) emojis.add(e);
      }
      return [...emojis];
    },
    getForSession() {
      return [];
    },
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

test('POST toggle normalizes shortcode emoji so :thumbsup: and 👍 are one reaction', async () => {
  const store = createFakeReactions();
  await withApp(store, async (base) => {
    const togglePath = '/api/messages/msg-1/reactions';
    const listPath = '/api/messages/msg-1/reactions?sessionKey=sk-1';

    const first = await postJson(base, togglePath, { emoji: ':thumbsup:', sessionKey: 'sk-1' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.added, true);
    assert.equal(first.body.emoji, '👍');

    const list = await getJson(base, listPath);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body.reactions, ['👍']);

    // Toggling the unicode spelling must remove the same logical reaction.
    const second = await postJson(base, togglePath, { emoji: '👍', sessionKey: 'sk-1' });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.added, false);

    const empty = await getJson(base, listPath);
    assert.deepEqual(empty.body.reactions, []);

    // Toggling back re-adds it, and the unicode spelling removes it again.
    const third = await postJson(base, togglePath, { emoji: ':thumbsup:', sessionKey: 'sk-1' });
    assert.equal(third.body.added, true);
    const fourth = await postJson(base, togglePath, { emoji: '👍', sessionKey: 'sk-1' });
    assert.equal(fourth.body.added, false);

    const final = await getJson(base, listPath);
    assert.deepEqual(final.body.reactions, []);
  });
});
