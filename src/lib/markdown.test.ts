import assert from 'node:assert/strict';
import { extractTurns } from './markdown.js';

const SIDECHAIN_FIXTURE = `
_**User**_
Primary prompt

---

_**Agent (claude-sonnet-4-5-20250929)**_
Main agent begins response line one.

---

_**User (sidechain)**_
Sub-agent prompt should be ignored.

---

_**Agent (claude-haiku-4-5-20251001) (sidechain)**_
Sub-agent analysis that should be ignored.

---

_**Agent (claude-sonnet-4-5-20250929)**_
Main agent wraps up after sub-agent work.
`;

const SIDECHAIN_ONLY_FIXTURE = `
_**User (sidechain)**_
Warmup

---

_**Agent (claude-haiku-4-5-20251001) (sidechain)**_
Ready to help!
`;

function runTests(): void {
  const turns = extractTurns(SIDECHAIN_FIXTURE);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user, 'Primary prompt');
  assert.ok(
    turns[0]?.agent?.includes('Main agent begins response line one.'),
    'expected primary agent response to be captured',
  );
  assert.ok(
    turns[0]?.agent?.includes('Main agent wraps up after sub-agent work.'),
    'expected concluding agent response to be captured',
  );
  assert.ok(
    !turns[0]?.user.includes('Sub-agent prompt'),
    'sidechain user content should not appear in the primary user prompt',
  );
  assert.ok(
    !turns[0]?.agent?.includes('Sub-agent analysis'),
    'sidechain agent content should not appear in the primary response',
  );

  const sidechainOnlyTurns = extractTurns(SIDECHAIN_ONLY_FIXTURE);
  assert.equal(sidechainOnlyTurns.length, 0);
}

runTests();
console.log('markdown sidechain filtering tests passed');
