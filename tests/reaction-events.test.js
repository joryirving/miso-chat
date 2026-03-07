const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGatewayReactionEvent } = require('../lib/reaction-events');

test('parses Slack :white_check_mark: reaction events into unicode emoji', () => {
  const event = parseGatewayReactionEvent(
    'Slack reaction added: :white_check_mark: by alice in #general msg 1732906502.139329 from bob'
  );

  assert.deepEqual(event, {
    channel: 'slack',
    action: 'added',
    emoji: '✅',
    actor: 'alice',
    messageId: '1732906502.139329',
    raw: 'Slack reaction added: :white_check_mark: by alice in #general msg 1732906502.139329 from bob',
  });
});

test('keeps unknown shortcodes untouched for diagnostics', () => {
  const event = parseGatewayReactionEvent(
    'Slack reaction added: :custom_team_emoji: by miso in #chat msg 12345'
  );

  assert.equal(event.emoji, ':custom_team_emoji:');
});
