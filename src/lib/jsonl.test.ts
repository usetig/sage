import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { extractTurns } from './jsonl.js';

async function createTempJsonl(lines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-jsonl-test-'));
  const filePath = path.join(dir, 'session.jsonl');
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

async function runTests(): Promise<void> {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Primary prompt' }],
      },
      thinkingMetadata: { level: 'none', disabled: false, triggers: [] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Assistant reply' }],
      },
    }),
    JSON.stringify({
      type: 'system',
      isCompactSummary: true,
      content: 'Ignore this summary',
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Second prompt' }],
      },
      thinkingMetadata: { level: 'none', disabled: false, triggers: [] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u2',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second reply' }],
      },
    }),
  ];

  const filePath = await createTempJsonl(lines);

  const all = await extractTurns({ transcriptPath: filePath });
  assert.equal(all.turns.length, 2, 'should parse two primary turns');
  assert.equal(all.latestTurnUuid, 'a2', 'latest turn uuid should match last assistant');

  const sliced = await extractTurns({ transcriptPath: filePath, sinceUuid: 'a1' });
  assert.equal(sliced.turns.length, 1, 'should return only new turns after a1');
  assert.equal(sliced.turns[0]?.assistantUuid, 'a2', 'new turn should point to assistant uuid a2');

  const toolChainLines = [
    JSON.stringify({
      type: 'user',
      uuid: 'prompt-1',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Explain the project' }],
      },
      thinkingMetadata: { level: 'none', disabled: false, triggers: [] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'ack-1',
      parentUuid: 'prompt-1',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Exploring the repository…' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'tool-edit',
      parentUuid: 'ack-1',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { path: 'src/app.ts', diff: '+++', note: 'example edit' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'tool-result',
      parentUuid: 'tool-edit',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-edit',
            content: [{ type: 'text', text: 'Edit applied successfully' }],
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'summary-1',
      parentUuid: 'tool-result',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '## Summary\nProject overview here.' }],
      },
    }),
  ];

  const toolPath = await createTempJsonl(toolChainLines);
  const toolResult = await extractTurns({ transcriptPath: toolPath });
  assert.equal(toolResult.turns.length, 1, 'should yield one primary turn');
  const mergedAgent = toolResult.turns[0]?.agent ?? '';
  assert.ok(
    mergedAgent.includes('Exploring the repository…'),
    'agent text should include initial acknowledgement',
  );
  assert.ok(
    mergedAgent.includes('[Tool Edit]'),
    'agent text should include retained tool use metadata',
  );
  assert.ok(
    mergedAgent.includes('## Summary'),
    'agent text should include final assistant summary',
  );
  assert.equal(
    toolResult.latestTurnUuid,
    'summary-1',
    'latest turn uuid should resolve to ultimate assistant response',
  );

  const inProgressLines = [
    JSON.stringify({
      type: 'user',
      uuid: 'pending-prompt',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Generate documentation' }],
      },
      thinkingMetadata: { level: 'none', disabled: false, triggers: [] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'pending-ack',
      parentUuid: 'pending-prompt',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'On it—scanning the repo now.' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'pending-tool',
      parentUuid: 'pending-ack',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Explore',
            input: { path: '.', note: 'analyze docs' },
          },
        ],
      },
    }),
  ];

  const inProgressPath = await createTempJsonl(inProgressLines);
  const inProgressResult = await extractTurns({ transcriptPath: inProgressPath });
  assert.equal(
    inProgressResult.turns.length,
    0,
    'should defer turns until Claude produces textual output after tool activity',
  );
  assert.equal(
    inProgressResult.latestTurnUuid,
    'pending-ack',
    'latest uuid should still point to the most recent assistant text while waiting',
  );

  const rejectionLines = [
    JSON.stringify({
      type: 'user',
      uuid: 'prompt-pending',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Pending edit request' }],
      },
      thinkingMetadata: { level: 'none', disabled: false, triggers: [] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'text-pending',
      parentUuid: 'prompt-pending',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Applying edit…' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'tool-edit-pending',
      parentUuid: 'text-pending',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { path: 'src/app.ts', diff: '+++', note: 'pending edit' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'tool-result-pending',
      parentUuid: 'tool-edit-pending',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-edit-pending',
            content: 'The user does not want to proceed.',
            is_error: true,
          },
        ],
      },
    }),
  ];

  const rejectionPath = await createTempJsonl(rejectionLines);
  const rejectionResult = await extractTurns({ transcriptPath: rejectionPath });
  assert.equal(
    rejectionResult.turns.length,
    0,
    'tool rejections should not produce a review turn',
  );
  assert.equal(
    rejectionResult.latestTurnUuid,
    'text-pending',
    'latest turn uuid should still advance to the last assistant event',
  );

  console.log('jsonl extraction tests passed');
}

void runTests();
