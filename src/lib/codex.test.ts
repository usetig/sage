import assert from 'node:assert/strict';
import { buildFollowupPromptPayload, buildInitialPromptPayload } from './codex.js';
import type { TurnSummary } from './jsonl.js';

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
assert.ok(payload.contextText.includes('┌─ Turn 1'), 'context should include formatted turn header');
assert.ok(payload.contextText.includes('USER PROMPT'), 'context should label user prompt');
assert.ok(payload.contextText.includes('CLAUDE RESPONSE'), 'context should include Claude response label');

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

const partialPayload = buildFollowupPromptPayload({
  sessionId: 'session-123',
  newTurns: [
    {
      ...SAMPLE_TURNS[0],
      isPartial: true,
    },
  ],
  isPartial: true,
});

assert.ok(partialPayload.promptText.includes('# Partial Response Notice'), 'partial prompt should include notice');
assert.ok(
  partialPayload.contextText.includes('content may be incomplete'),
  'partial context should warn about incomplete content',
);

console.log('codex follow-up prompt tests passed');
