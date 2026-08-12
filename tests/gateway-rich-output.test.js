const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'development';
process.env.LOCAL_AUTH_ENABLED = 'false';
process.env.OIDC_ENABLED = 'false';

const {
  extractUserFacingAssistantText,
  extractNeedsInputPrompt,
  extractThinkingText,
  extractStructuredToolCalls,
  extractMediaUrls,
  mergeHistoryToolResults,
} = require('../server');

test('assistant text excludes reasoning and tool blocks', () => {
  const text = extractUserFacingAssistantText({
    content: [
      { type: 'thinking', text: 'private chain of thought' },
      { type: 'tool_call', name: 'web_search', arguments: '{}' },
      { type: 'text', text: 'Visible answer' },
    ],
  });

  assert.equal(text, 'Visible answer');
});

test('thinking extraction keeps reasoning metadata separate', () => {
  const response = {
    content: [
      { type: 'thinking', text: 'private reasoning metadata' },
      { type: 'text', text: 'Visible answer' },
    ],
  };

  assert.equal(extractUserFacingAssistantText(response), 'Visible answer');
  assert.equal(extractThinkingText(response), 'private reasoning metadata');
  assert.equal(extractThinkingText({ content: 'Visible answer' }), '');
});

test('assistant text removes legacy needs-input directives', () => {
  const text = extractUserFacingAssistantText(
    'Before the question\nOpenClaw needs input: Choose a path\n1. Keep it\n2. Change it\nAfter the question',
  );

  assert.equal(text, 'Before the question\nAfter the question');
});

test('needs-input prompts survive as structured metadata while visible text is sanitized', () => {
  const prompt = extractNeedsInputPrompt({
    response: {
      content: [{
        type: 'text',
        text: 'OpenClaw needs input: Pick one\n1. Keep it\n2. Change it',
      }],
    },
  });

  assert.match(prompt, /^OpenClaw needs input:/);
  assert.equal(extractUserFacingAssistantText({
    content: [{ type: 'text', text: prompt }],
  }), '');
});

test('structured tool calls normalize direct and content-block shapes', () => {
  assert.deepEqual(
    extractStructuredToolCalls({
      toolCalls: [{
        toolCallId: 'call-1',
        toolName: 'web_search',
        input: { query: 'OpenClaw' },
        output: 'done',
      }],
    }),
    [{
      id: 'call-1',
      name: 'web_search',
      arguments: { query: 'OpenClaw' },
      result: 'done',
      status: 'success',
    }],
  );

  assert.deepEqual(
    extractStructuredToolCalls({
      content: [
        { type: 'tool_call', id: 'call-2', name: 'exec', arguments: 'ls' },
        { type: 'tool_result', id: 'call-2', result: 'file.txt' },
      ],
    }),
    [{
      id: 'call-2',
      name: 'exec',
      arguments: 'ls',
      result: 'file.txt',
      status: 'success',
    }],
  );
});

test('media extraction keeps safe HTTPS and image data URLs only', () => {
  assert.deepEqual(
    extractMediaUrls({
      mediaUrls: ['https://cdn.example/image.png', 'http://intranet/image.png'],
      response: {
        content: [{ type: 'image', url: 'data:image/png;base64,abc' }],
      },
    }),
    ['https://cdn.example/image.png', 'data:image/png;base64,abc'],
  );
});

test('history merges separate tool results into the assistant tool card', () => {
  const messages = mergeHistoryToolResults([
    {
      role: 'assistant',
      toolCalls: [{ id: 'call-3', name: 'exec', arguments: 'pwd', status: 'calling' }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-3',
      toolName: 'exec',
      content: [{ type: 'text', text: '/workspace' }],
      isError: false,
    },
  ]);

  assert.deepEqual(messages, [{
    role: 'assistant',
    toolCalls: [{
      id: 'call-3',
      name: 'exec',
      arguments: 'pwd',
      status: 'success',
      result: '/workspace',
    }],
  }]);
});
