const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
process.env.PORT = '0';

const { humanizeAgentToken, inferAgentNameFromKey } = require('../server');

// humanizeAgentToken ------------------------------------------------------------

test('humanizeAgentToken strips g-agent- prefix and title-cases words', () => {
  assert.equal(humanizeAgentToken('g-agent-miso_chat'), 'Miso Chat');
});

test('humanizeAgentToken capitalizes each segment of a colon-separated session key', () => {
  assert.equal(humanizeAgentToken('agent:main:main'), 'Main:Main');
});

test('humanizeAgentToken strips agent- prefix and capitalizes remainder', () => {
  assert.equal(humanizeAgentToken('agent-miso_chat'), 'Miso Chat');
});

test('humanizeAgentToken strips agent: prefix and capitalizes remainder', () => {
  assert.equal(humanizeAgentToken('agent:miso_chat'), 'Miso Chat');
});

test('humanizeAgentToken replaces dashes and underscores with spaces', () => {
  assert.equal(humanizeAgentToken('g-agent-foo-bar_baz'), 'Foo Bar Baz');
});

test('humanizeAgentToken capitalizes a single word', () => {
  assert.equal(humanizeAgentToken('agent'), 'Agent');
});

test('humanizeAgentToken returns empty string for falsy input', () => {
  assert.equal(humanizeAgentToken(''), '');
  assert.equal(humanizeAgentToken(null), '');
  assert.equal(humanizeAgentToken(undefined), '');
});

test('humanizeAgentToken trims surrounding whitespace', () => {
  assert.equal(humanizeAgentToken('  miso_chat  '), 'Miso Chat');
});

// inferAgentNameFromKey ---------------------------------------------------------

test('inferAgentNameFromKey parses agent: prefixed session key using parts[1]', () => {
  assert.equal(inferAgentNameFromKey('agent:main:miso_chat'), 'Main');
});

test('inferAgentNameFromKey parses g-agent- subsegment from session key', () => {
  assert.equal(inferAgentNameFromKey('user:g-agent-miso_chat'), 'Miso Chat');
});

test('inferAgentNameFromKey returns null for empty input', () => {
  assert.equal(inferAgentNameFromKey(''), null);
});

test('inferAgentNameFromKey returns null for non-string input', () => {
  assert.equal(inferAgentNameFromKey(null), null);
  assert.equal(inferAgentNameFromKey(undefined), null);
  assert.equal(inferAgentNameFromKey(42), null);
});

test('inferAgentNameFromKey returns null for unrecognised keys', () => {
  assert.equal(inferAgentNameFromKey('unrelated:thing'), null);
});
