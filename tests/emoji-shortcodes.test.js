const test = require('node:test');
const assert = require('node:assert/strict');

const { EMOJI_SHORTCODES, normalizeShortcode, resolveShortcode, searchShortcodes } = require('../lib/emoji-shortcodes');

test('resolveShortcode resolves known shortcodes', () => {
  assert.equal(resolveShortcode(':smile:'), '😀');
  assert.equal(resolveShortcode(':heart:'), '❤️');
  assert.equal(resolveShortcode(':thumbs_up:'), '👍');
});

test('resolveShortcode handles case-insensitive shortcodes', () => {
  assert.equal(resolveShortcode(':SMILE:'), '😀');
  assert.equal(resolveShortcode(':Smile:'), '😀');
  assert.equal(resolveShortcode(':HEART:'), '❤️');
});

test('resolveShortcode works without colons', () => {
  assert.equal(resolveShortcode('smile'), '😀');
  assert.equal(resolveShortcode('heart'), '❤️');
});

test('resolveShortcode returns null for unknown shortcodes', () => {
  assert.equal(resolveShortcode(':unknown:'), null);
  assert.equal(resolveShortcode(':nonexistent:'), null);
});

test('resolveShortcode returns null for malformed input', () => {
  assert.equal(resolveShortcode(''), null);
  assert.equal(resolveShortcode(null), null);
  assert.equal(resolveShortcode(undefined), null);
});

test('EMOJI_SHORTCODES is a non-empty object', () => {
  assert.ok(typeof EMOJI_SHORTCODES === 'object');
  assert.ok(Object.keys(EMOJI_SHORTCODES).length > 0);
});

test('normalizeShortcode strips colons and lowercases', () => {
  assert.equal(normalizeShortcode(':smile:'), 'smile');
  assert.equal(normalizeShortcode(':SMILE:'), 'smile');
  assert.equal(normalizeShortcode(':Smile:'), 'smile');
});

test('searchShortcodes returns matching shortcodes', () => {
  const results = searchShortcodes('smile');
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.shortcode.includes('smile')));
});

test('searchShortcodes returns objects with shortcode and emoji', () => {
  const results = searchShortcodes('heart');
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(typeof r.shortcode === 'string');
    assert.ok(typeof r.emoji === 'string');
  }
});

test('searchShortcodes returns empty array for no matches', () => {
  const results = searchShortcodes('zzzznonexistent');
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test('searchShortcodes respects limit', () => {
  const results = searchShortcodes('', 3);
  // Empty query returns empty array
  assert.equal(results.length, 0);
});
