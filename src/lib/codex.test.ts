import assert from 'node:assert/strict';
import { buildFollowupPromptPayload, buildInitialPromptPayload } from './codex.js';
import type { TurnSummary } from './markdown.js';

const SAMPLE_TURNS: TurnSummary[] = [
  {
    user: 'Primary prompt',
    agent: 'Main agent begins response line one.',
  },
  {
    user: 'Second user prompt',
    agent: 'Second agent reply',
  },
];

const SAMPLE_LATEST = SAMPLE_TURNS[SAMPLE_TURNS.length - 1];

const payload = buildInitialPromptPayload({
  sessionId: 'session-123',
  turns: SAMPLE_TURNS,
  latestTurnSummary: SAMPLE_LATEST,
});

assert.ok(payload.prompt.includes('<conversation>'), 'prompt should include conversation wrapper');
assert.ok(
  !payload.contextText.includes('Sub-agent'),
  'context should not contain sidechain text',
);
assert.equal(
  payload.contextText,
  [
    'Turn 1',
    'User prompt:',
    'Primary prompt',
    '',
    'Claude response:',
    'Main agent begins response line one.',
    '',
    'Turn 2',
    'User prompt:',
    'Second user prompt',
    '',
    'Claude response:',
    'Second agent reply',
  ].join('\n'),
  'contextText should format turns consistently',
);

console.log('codex initial prompt tests passed');

const followupPayload = buildFollowupPromptPayload({
  sessionId: 'session-123',
  newTurns: SAMPLE_TURNS,
});

assert.equal(
  followupPayload.contextText,
  payload.contextText,
  'follow-up payload should format turns identically to initial payload',
);

console.log('codex follow-up prompt tests passed');
