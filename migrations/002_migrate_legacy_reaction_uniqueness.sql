-- Migration 002: Ensure reactions table has the correct unique constraint.
--
-- The original schema had UNIQUE(message_id, emoji, username) which allowed
-- the same user to react multiple times with different emojis on the same
-- message. This migration updates it to UNIQUE(message_id, session_key, emoji, username)
-- to properly scope reactions per session.

DROP TABLE IF EXISTS reactions_new;

CREATE TABLE reactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  emoji TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, session_key, emoji, username)
);

INSERT OR IGNORE INTO reactions_new (id, message_id, session_key, emoji, username, created_at)
SELECT id, message_id, session_key, emoji, username, created_at
FROM reactions;

DROP TABLE IF EXISTS reactions;
ALTER TABLE reactions_new RENAME TO reactions;

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_session ON reactions(session_key);
