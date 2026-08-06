const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations, getAppliedMigrations, listAvailableMigrations } = require('../lib/migrate');

describe('lib/migrate.js — migration framework', () => {
  it('listAvailableMigrations returns sorted migration versions', () => {
    const migrations = listAvailableMigrations();
    assert.ok(Array.isArray(migrations));
    assert.ok(migrations.length >= 2, 'should have at least 2 migrations');
    assert.equal(migrations[0].version, '001');
    assert.equal(migrations[1].version, '002');
  });

  it('runMigrations creates schema_migrations table', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const hasSchemaMigrations = tables.some(t => t.name === 'schema_migrations');
    assert.ok(hasSchemaMigrations, 'schema_migrations table should exist');

    db.close();
  });

  it('runMigrations applies all pending migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const applied = getAppliedMigrations(db);
    assert.ok(applied.length >= 2, 'should have applied at least 2 migrations');
    assert.equal(applied[0], '001');
    assert.equal(applied[1], '002');

    db.close();
  });

  it('runMigrations creates reactions table with correct schema', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reactions'").get();
    assert.ok(tableInfo.sql, 'reactions table should exist');
    assert.ok(
      tableInfo.sql.includes('UNIQUE(message_id, session_key, emoji, username)'),
      'should have correct unique constraint'
    );

    db.close();
  });

  it('runMigrations creates indexes', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reactions'").all();
    const indexNames = indexes.map(i => i.name);
    assert.ok(indexNames.includes('idx_reactions_message'), 'should have message index');
    assert.ok(indexNames.includes('idx_reactions_session'), 'should have session index');

    db.close();
  });

  it('runMigrations is idempotent — no-op on second run', () => {
    const db = new Database(':memory:');
    const firstRun = runMigrations(db);
    const secondRun = runMigrations(db);

    assert.ok(firstRun.length >= 2, 'first run should apply migrations');
    assert.equal(secondRun.length, 0, 'second run should apply no migrations');

    db.close();
  });

  it('runMigrations records each migration version exactly once', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db);

    const applied = getAppliedMigrations(db);
    const unique = [...new Set(applied)];
    assert.equal(applied.length, unique.length, 'no duplicate migration records');

    db.close();
  });
});
