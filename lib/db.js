const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'miso-chat.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

function migrateLegacyReactionUniqueness() {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reactions'")
    .get();

  if (!table?.sql) return;

  const normalizedSql = table.sql.replace(/\s+/g, ' ').toLowerCase();
  const hasScopedUnique = normalizedSql.includes('unique(message_id, session_key, emoji, username)');
  if (hasScopedUnique) return;

  const hasLegacyUnique = normalizedSql.includes('unique(message_id, emoji, username)');
  if (!hasLegacyUnique) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE reactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        emoji TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(message_id, session_key, emoji, username)
      );

      INSERT INTO reactions_new (id, message_id, session_key, emoji, username, created_at)
      SELECT id, message_id, session_key, emoji, username, created_at
      FROM reactions;

      DROP TABLE reactions;
      ALTER TABLE reactions_new RENAME TO reactions;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Initialize schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      emoji TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(message_id, session_key, emoji, username)
    )
  `);

  migrateLegacyReactionUniqueness();

  // Indexes for faster lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_session ON reactions(session_key);
  `);
}

initSchema();

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
