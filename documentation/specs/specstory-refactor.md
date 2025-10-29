# SpecStory Refactor — Hook-Driven JSONL Pipeline

## Overview
This document explains the code changes that replaced the SpecStory-based ingestion flow with Claude Code hooks and direct JSONL parsing.

### Key Goals
- Eliminate the SpecStory CLI dependency and markdown parsing.
- Consume Claude’s native JSONL transcripts safely and efficiently.
- Make Sage resilient to being launched intermittently (queue-signals survive between runs).
- Preserve existing review caches and TUI workflows.

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

