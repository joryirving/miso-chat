const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./migrate');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'miso-chat.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize schema by running all pending migrations
runMigrations(db);

// Reaction operations
const reactions = {
  // Add or remove a reaction (toggle behavior)
  toggle(messageId, sessionKey, emoji, username) {
    const existing = db.prepare(
      'SELECT id FROM reactions WHERE message_id = ? AND session_key = ? AND emoji = ? AND username = ?'
    ).get(messageId, sessionKey, emoji, username);

    if (existing) {
      // Remove reaction
      db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
      return { action: 'removed', emoji };
    }

    // Add reaction
    const result = db.prepare(
      'INSERT INTO reactions (message_id, session_key, emoji, username) VALUES (?, ?, ?, ?)'
    ).run(messageId, sessionKey, emoji, username);
    return { action: 'added', emoji, id: result.lastInsertRowid };
  },

  // Get all reactions for a message
  getForMessage(messageId, sessionKey = null) {
    const rows = sessionKey
      ? db
          .prepare(
            'SELECT emoji, username, created_at FROM reactions WHERE message_id = ? AND session_key = ? ORDER BY created_at ASC'
          )
          .all(messageId, sessionKey)
      : db
          .prepare('SELECT emoji, username, created_at FROM reactions WHERE message_id = ? ORDER BY created_at ASC')
          .all(messageId);

    // Group by emoji
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.emoji]) {
        grouped[row.emoji] = [];
      }
      grouped[row.emoji].push({
        username: row.username,
        createdAt: row.created_at,
      });
    }

    return Object.entries(grouped).map(([emoji, users]) => ({
      emoji,
      count: users.length,
      users: users.map((u) => u.username),
    }));
  },

  // Get all reactions for a session (for batch loading)
  getForSession(sessionKey) {
    const rows = db.prepare('SELECT message_id, emoji, username FROM reactions WHERE session_key = ?').all(sessionKey);

    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.message_id]) {
        grouped[row.message_id] = {};
      }
      if (!grouped[row.message_id][row.emoji]) {
        grouped[row.message_id][row.emoji] = [];
      }
      grouped[row.message_id][row.emoji].push(row.username);
    }

    return grouped;
  },

  // Remove all reactions for a message (when message is deleted)
  removeForMessage(messageId) {
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  },
};

module.exports = { db, reactions };
