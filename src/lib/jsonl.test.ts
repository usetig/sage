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

  console.log('jsonl extraction tests passed');
}

void runTests();
