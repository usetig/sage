# SpecStory Refactor — Hook-Driven JSONL Pipeline

## Overview
This document explains the code changes that replaced the SpecStory-based ingestion flow with Claude Code hooks and direct JSONL parsing.

### Key Goals
- Eliminate the SpecStory CLI dependency and markdown parsing.
- Consume Claude's native JSONL transcripts safely and efficiently.
- Make Sage resilient to being launched intermittently (queue-signals survive between runs).
- Preserve existing review caches and TUI workflows.

## Continuous Review Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: User Interaction in Claude Code                                    │
└─────────────────────────────────────────────────────────────────────────────┘

User types prompt → Claude Code receives input
                    │
                    ├─→ UserPromptSubmit hook fires
                    │   └─→ sageHook.ts receives payload
                    │       └─→ Updates .sage/runtime/sessions/{sessionId}.json
                    │           (writes lastPrompt field)
                    │
                    ├─→ Claude processes prompt & generates response
                    │   └─→ Writes to ~/.claude/projects/{project}/{sessionId}.jsonl
                    │       (appends user + assistant JSONL entries)
                    │
                    └─→ Stop hook fires (when Claude finishes)
                        └─→ sageHook.ts receives payload
                            ├─→ Updates .sage/runtime/sessions/{sessionId}.json
                            │   (writes lastStopTime field)
                            │
                            └─→ Writes signal file:
                                .sage/runtime/needs-review/{sessionId}
                                Content: { sessionId, transcriptPath, queuedAt }

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Sage Detection & Queue Processing                                  │
└─────────────────────────────────────────────────────────────────────────────┘

Chokidar watcher (App.tsx:578-588)
│  Watching: .sage/runtime/needs-review/
│  Config: ignoreInitial: true, depth: 0
│
├─→ 'add' event fires for new signal file
│   └─→ Check: Is file in processedSignalsRef?
│       ├─→ YES: Skip (already processing/processed)
│       └─→ NO: Add to processedSignalsRef
│               └─→ Call processSignalFile(filePath, sessionId)

processSignalFile() (App.tsx:608-652)
│
├─→ Read signal file → parse JSON
│   └─→ Validate: sessionId, transcriptPath exist
│
├─→ Check: Does signal match activeSession?
│   └─→ NO: Remove from processedSignalsRef, return
│   └─→ YES: Continue
│
├─→ Get latest known signature
│   └─→ Check queue for pending jobs with signatures
│   └─→ Fallback to lastTurnSignatureRef.current
│
├─→ Call extractTurns({
│       transcriptPath: signal.transcriptPath,
│       sinceUuid: latestKnownSignature
│   })
│   │
│   └─→ JSONL Parser (jsonl.ts:86-160)
│       ├─→ Stream transcript line-by-line
│       ├─→ Skip: isSidechain === true
│       ├─→ Skip: isCompactSummary === true
│       ├─→ Skip: isMeta === true
│       ├─→ Build user/assistant pairs
│       └─→ Filter: Remove turns before sinceUuid
│           └─→ Returns: { turns: TurnSummary[], latestTurnUuid }
│
├─→ Check: Are there new turns?
│   ├─→ NO: Delete signal file, remove from processedSignalsRef, return
│   └─→ YES: Continue
│
└─→ Call enqueueJob({
        sessionId,
        transcriptPath,
        turns,
        promptPreview,
        latestTurnSignature,
        signalPath
    })
    └─→ Add to queueRef.current (FIFO queue)
    └─→ Update UI queue display
    └─→ Trigger processQueue() if worker not running

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Review Execution                                                   │
└─────────────────────────────────────────────────────────────────────────────┘

processQueue() (App.tsx:498-572)
│  Loop while: queueRef.current.length > 0
│
├─→ Pop first job from queue
│   └─→ setCurrentJob(job)  // Updates UI status
│
├─→ Check: Is codexThreadRef.current available?
│   └─→ NO: Show error, break loop
│   └─→ YES: Continue
│
├─→ Call performIncrementalReview({
│       sessionId,
│       transcriptPath,
│       thread: codexThreadRef.current,
│       turns: job.turns,
│       latestTurnSignature: job.latestTurnSignature
│   })
│   │
│   └─→ Review Pipeline (review.ts:172-253)
│       ├─→ Build follow-up prompt from new turns
│       ├─→ Write debug artifact to .debug/
│       ├─→ Call thread.run() on Codex
│       └─→ Return ReviewResult with critique
│
├─→ Update lastTurnSignatureRef.current
│   └─→ Used for next deduplication
│
├─→ Call appendReview(result)
│   ├─→ Add to reviews array (UI display)
│   ├─→ Call persistReview()
│       └─→ Write to .sage/reviews/{sessionId}.json
│           (includes turnSignature for cache)
│
├─→ Delete signal file (job.signalPath)
│   └─→ fs.unlink() - signal consumed successfully
│
├─→ Remove from processedSignalsRef
│   └─→ Allow re-processing if signal reappears
│
└─→ Remove job from queue, continue loop

┌─────────────────────────────────────────────────────────────────────────────┐
│ KEY DATA STRUCTURES                                                          │
└─────────────────────────────────────────────────────────────────────────────┘

Session Metadata (.sage/runtime/sessions/{sessionId}.json):
{
  sessionId: string,
  transcriptPath: string,        // Path to JSONL
  cwd: string,
  lastPrompt?: string,            // From UserPromptSubmit
  lastStopTime?: number,          // From Stop hook
  lastUpdated: number             // Timestamp
}

Signal File (.sage/runtime/needs-review/{sessionId}):
{
  sessionId: string,
  transcriptPath: string,
  queuedAt: number
}

Review Cache (.sage/reviews/{sessionId}.json):
{
  sessionId: string,
  lastTurnSignature: string,      // Assistant UUID of last reviewed turn
  reviews: [
    {
      turnSignature: string,
      completedAt: string,
      latestPrompt: string,
      critique: CritiqueResponse,
      artifactPath?: string
    }
  ]
}

┌─────────────────────────────────────────────────────────────────────────────┐
│ CRITICAL DEDUPLICATION LOGIC                                                 │
└─────────────────────────────────────────────────────────────────────────────┘

Why deduplication matters:
- Claude resume creates new JSONL with copied history
- Compaction appends synthetic entries
- Multiple Stop hooks could fire for same turn

How it works:
1. lastTurnSignatureRef.current tracks last reviewed assistant UUID
2. extractTurns(sinceUuid) filters out turns before that UUID
3. After successful review, update lastTurnSignatureRef
4. Persist to .sage/reviews/{sessionId}.json for cross-session memory

Deduplication chain:
  latestKnownSignature() (App.tsx:671-677)
    ├─→ Check queue for pending jobs (use their latestTurnSignature)
    └─→ Fallback to lastTurnSignatureRef.current
        └─→ Passed to extractTurns() as sinceUuid
            └─→ JSONL parser filters turns before this UUID

┌─────────────────────────────────────────────────────────────────────────────┐
│ FAILURE RECOVERY                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Signal file persists until successful review:
  ├─→ If Sage crashes: Signal remains in needs-review/
  ├─→ On restart: drainSignals() processes backlog
  └─→ Only deleted after: Review completes + cache updated

processedSignalsRef prevents duplicate processing:
  ├─→ Added when watcher detects file
  ├─→ Removed only after: Job completes OR processing fails
  └─→ Allows retry if removed from set

Manual sync (M key):
  └─→ Calls drainSignals() to force re-scan of needs-review/
      └─→ Useful if watcher missed an event
```

## Major Components

### 1. Hook Shim (`src/hooks/sageHook.ts`)
- Handles `SessionStart`, `SessionEnd`, `Stop`, and `UserPromptSubmit` events from Claude Code.
- Validates payloads, records per-session metadata under `.sage/runtime/sessions/{sessionId}.json`.
- Appends review "signals" to `.sage/runtime/needs-review/{sessionId}` when a `Stop` event fires.
- Uses atomic writes (temp file → rename) and logs issues to `.sage/runtime/hook-errors.log` without failing the hook.

### 2. Hook Installer (`npm run configure-hooks`)
- New script (`src/scripts/configureHooks.ts`) updates `~/.claude/settings.local.json` to register the hook command: `npx tsx "$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts"` for the four events.
- Users run this once per project; startup still warns if hooks are missing.

### 3. JSONL Utilities (`src/lib/jsonl.ts` + tests)
- `listActiveSessions()` reads metadata files, filters warmups via `isWarmupSession`, builds session titles from the latest prompt, and sorts by `lastUpdated`.
- `extractTurns()` streams a transcript, skipping `isSidechain`, `isCompactSummary`, and `isMeta` entries; returns deduped `TurnSummary[]` and the latest assistant UUID.
- Includes `jsonl.test.ts` to exercise warmup detection, compaction filtering, and since-UUID slicing.

### 4. Review Orchestration (`src/lib/review.ts`)
- Operates on JSONL-derived `TurnSummary[]` instead of markdown.
- Stores transcript paths on `ReviewResult` objects and propagates `turnSignature` (assistant UUID) for cache dedupe.
- Restored `clarifyReview()` with JSONL-aware messaging.

### 5. TUI Runtime (`src/ui/App.tsx`)
- Session list now comes from `listActiveSessions()`. No SpecStory sync; restart logic resets hooks/watchers only.
- Initial review loads `performInitialReview({ transcriptPath, lastReviewedUuid })` and, on success, starts a chokidar watcher on `.sage/runtime/needs-review/`.
- Drain backlog plus real-time watcher: maintains `processedSignalsRef` to avoid duplicate processing; signal files are deleted only after successful review.
- Queue items carry `signalPath`, `transcriptPath`, `latestTurnSignature`. Manual `M` key triggers `drainSignals()` (force processing).

### 6. Documentation & Cleanup
- Deleted `src/lib/specstory.ts`, `src/lib/markdown.ts`, `src/lib/hooks.ts`, and `src/lib/markdown.test.ts`.
- Updated README, what-is-sage.md, agents.md to describe the new hook/JSONL architecture and workflow.
- Added developer spec `documentation/specs/jsonl-hooks-migration.md` (this doc references it), and new `specstory-refactor.md` summarizing actual implementation.

## Testing
- `npm run build` (TypeScript compilation) passes.
- Added unit test `src/lib/jsonl.test.ts` (run via `tsx`) for JSONL parsing logic.
- Manual smoke tests recommended: run `npm run configure-hooks`, use Claude Code, start Sage, verify signal files and critiques.

## Known Limitations / Next Steps
- Hook shim currently runs via `npx tsx`; we may later ship pre-built JS for faster startup.
- No sidechain (agent) transcript parsing yet—future work could surface delegated tool work.
- Needs integration test harness to simulate hook writes end-to-end.

## Upgrade Notes
- Existing `.sage/reviews/*.json` remain compatible; old `.sage/history/*.md` files are ignored.
- Users must run `npm run configure-hooks` once per project after pulling these changes.
- Remove SpecStory from local toolchains; the CLI is no longer required.

