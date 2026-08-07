const fs = require('fs');
const path = require('path');

/**
 * Database migration framework for better-sqlite3 (synchronous).
 *
 * Tracks applied migrations in a `schema_migrations` table and runs
 * pending numbered SQL files from the `migrations/` directory in order.
 *
 * Usage:
 *   const { runMigrations } = require('./migrate');
 *   runMigrations(db);
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Create the schema_migrations tracking table if it doesn't exist.
 */
function createMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY
    )
  `);
}

/**
 * Return an array of already-applied migration version strings.
 */
function getAppliedMigrations(db) {
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return (rows || []).map(r => r.version);
}

/**
 * Record that a migration version has been applied.
 */
function recordMigration(db, version) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

/**
 * List all available migration files, sorted by name.
 * Returns an array of { version, file } objects (e.g. [{ version: '001', file: '001_create_reactions.sql' }]).
 */
function listAvailableMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({ version: f.replace(/_(.+)\.sql$/, ''), file: f }));
}

/**
 * Run all pending migrations in order.
 * Each migration is executed as a single transaction so it either fully
 * succeeds or fully rolls back.
 */
function runMigrations(db) {
  createMigrationsTable(db);

  const applied = getAppliedMigrations(db);
  const available = listAvailableMigrations();
  const pending = available.filter(m => !applied.includes(m.version));

  for (const migration of pending) {
    const filePath = path.join(MIGRATIONS_DIR, migration.file);
    const sql = fs.readFileSync(filePath, 'utf8');

    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(sql);
      recordMigration(db, migration.version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return pending.map(m => m.version);
}

module.exports = {
  runMigrations,
  createMigrationsTable,
  getAppliedMigrations,
  recordMigration,
  listAvailableMigrations
};
