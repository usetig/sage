# Spec: Hook-Driven JSONL Ingestion (Replaces SpecStory)

**Note**: This spec describes the original design. SessionEnd hook was removed in implementation due to unreliability; metadata files now persist.

## Goal
Ingest Claude Code conversations directly from JSONL logs using hook-triggered signals, removing the SpecStory CLI and markdown parsing while preserving Sage's review workflow.

## Assumptions
- Claude Code version ≥ 2.0.24 (modern format with `agent-*.jsonl` sidechain files).
- Sage runs on demand (not a resident daemon); hooks must behave when Sage is offline.
- Users run Sage from a cloned repo (or packaged CLI) located under the active project.
- `.sage/` remains Sage’s workspace; no writes inside `.claude/` except hook config.
- Existing review caches (`.sage/reviews/{sessionId}.json`) remain reusable.
- Sidechain agent files are **ignored** in this implementation; only main transcripts are reviewed.

## High-Level Flow
1. **Hooks** fire on key events, each writing per-session metadata/signal files under `.sage/runtime/`.
2. **Sage** (on startup) reads per-session metadata, drains pending review signals, and starts a watcher for new signals.
3. **JSONL extractor** reads the transcript for new turns (deduped against cache), skipping warmups and compaction noise.
4. **Review pipeline** processes turns, persists cache atomically, and removes the processed signal.

## Phase 0 – Installation & Distribution
- Provide a script (`npm run configure-hooks`) that:
  - Runs `npx tsx src/hooks/sageHook.ts --install` (so we avoid a build prerequisite).
  - Patches `~/.claude/settings.local.json` to register a single hook command referencing `npx tsx $CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts`.
  - Creates `.sage/runtime/` directories if missing.
- On Sage startup, verify hook config is installed; warn in UI if not.

## Phase 1 – Hook Runner
1. **Hook command registration**
   - Events: `SessionStart`, `Stop`, `UserPromptSubmit`. *(SessionEnd removed in implementation)*
   - Command: `npx tsx "$CLAUDE_PROJECT_DIR/src/hooks/sageHook.ts"`.

2. **Hook shim (`src/hooks/sageHook.ts`) responsibilities**
   - Parse STDIN JSON; validate required fields (session_id, transcript_path, cwd, hook_event_name). If validation fails, log to `.sage/runtime/hook-errors.log` and exit 0.
   - Write per-session metadata to `.sage/runtime/sessions/{sessionId}.json` (atomic: write temp, rename). Stored fields:
     ```ts
     {
       sessionId: string;
       transcriptPath: string;
       cwd: string;
       lastPrompt?: string; // from UserPromptSubmit
       lastStopTime?: number; // epoch ms from Stop hook
       lastUpdated: number; // epoch ms
     }
     ```
   - Append review signals by writing `.sage/runtime/needs-review/{sessionId}` containing `{ transcriptPath, queuedAt }`. If the file already exists, leave it (idempotent).
   - ~~`SessionEnd`: delete session metadata file and any pending signal.~~ *(Removed: unreliable, metadata now persists)*
   - Ensure all writes are atomic (fs.writeFile to temp → fs.rename) and use unique temp filenames.
   - Never crash; on unexpected errors, log and exit 0 so hooks don’t fail in Claude Code.

## Phase 2 – JSONL Utility Module (`src/lib/jsonl.ts`)
Add new utilities:
1. `listActiveSessions()`  
   - Read all files under `.sage/runtime/sessions/`.  
   - Ignore sessions whose transcript is missing or whose first prompt is warmup (via `isWarmupSession` helper that streams first user entry).  
   - Derive session title from `lastPrompt` (fallback to placeholder).  
   - Return array sorted by `lastUpdated` desc.

2. `extractTurns({ transcriptPath, lastReviewedUuid })`  
   - Stream transcript line-by-line.  
   - Skip entries where `isCompactSummary` or `isMeta` is true.  
   - Build `TurnSummary[]` capturing user/assistant pairs (main session only).  
   - Filter out previously reviewed turns by comparing their assistant/user UUIDs to `lastReviewedUuid`.  
   - Return new turns + latest turn signature (UUID of last assistant entry).

3. Helper `latestPromptPreview(turns)` for UI tooltip.

4. Tests under `tests/jsonl/` covering resume duplication, compaction, warmups, corrupted lines (ensure graceful failure).

## Phase 3 – Sage Runtime Updates
1. **Startup bootstrap (`src/ui/App.tsx`)**
   - Load `activeSessions = listActiveSessions()`.  
   - Start chokidar watcher on `.sage/runtime/needs-review/` **before** draining backlog. Maintain `processedSignals = new Set()`.  
   - Drain backlog: for each signal file, add to `processedSignals`, process, then remove file.

2. **Signal processing**
   - `processSignal(sessionId)` flow:
     1. Read metadata `sessions/{sessionId}.json`; if missing → remove signal and return.  
     2. Call `extractTurns`.  
     3. If no new turns, remove signal and return.  
     4. Enqueue review job with new turns; on success, atomically update `.sage/reviews/{sessionId}.json` (write temp → rename) and delete signal file.  
     5. On failure, leave signal file (retry on restart) and log warning.

3. **Manual sync key**  
   - “M” key triggers re-scan of `needs-review/` (useful after fixing errors).

4. **Cleanup on session removal**
   - ~~If `SessionEnd` removes metadata, ensure active session list updates immediately (watcher on `sessions/` or periodic refresh).~~ *(SessionEnd removed: metadata persists, stale sessions remain visible)*

## Phase 4 – Review Pipeline Adjustments
- Update `src/lib/review.ts` to accept `TurnSummary[]` from the JSONL module instead of SpecStory markdown.
- Reuse `lastReviewedUuid` in review cache for dedupe.
- Continue writing `.debug/review-*.txt` artifacts using JSONL-derived prompt/context.

## Phase 5 – Remove SpecStory
- Delete `src/lib/specstory.ts`, `src/lib/markdown.ts`, related tests, and SpecStory hook logic.
- Update docs (`README.md`, `what-is-sage.md`, `agents.md`, troubleshooting) to describe the new setup and remove SpecStory instructions.
- Note in docs that existing `.sage/history/` markdown files are ignored; review caches remain compatible.

## Error Handling & Edge Cases
- **Corrupted JSONL line**: log warning, skip line; if entire file fails, surface error in UI and leave signal for retry.
- **Missing transcript path**: delete session metadata and signal; log warning.
- **Partial review cache writes**: always write to temp file then rename.
- **Timestamps**: used only for display/sorting; never for ordering events.
- **Clock skew**: irrelevant because we rely on UUID dedupe rather than timestamps.
- **Multiple projects**: hooks run with `$CLAUDE_PROJECT_DIR`; each project keeps its own `.sage/` directory, so sessions stay isolated.

## Testing Strategy
- Unit tests for hook shim (using fixtures for each event type).
- JSONL parser tests (resume duplication, compaction, warmups, malformed data).
- Integration test simulating hook writes → ensure single review per turn.
- Manual smoke tests: create session, resume, compact, run multiple concurrent sessions.

## Risks & Mitigations
- **Hook misconfiguration** → Installer + startup check; log if hook shim not found.
- **Concurrent hook execution** → Per-session metadata files + atomic writes prevent clobbering.
- **Signal backlog growth** → Signals deleted only after successful review; failures auto-retry.
- **Users on older Claude versions** → Start-up guard that detects missing fields (e.g., no `isCompactSummary` or old format) and prompts upgrade.

## Deliverables
- `src/hooks/sageHook.ts` (TypeScript shim with install command).
- `src/lib/jsonl.ts` + accompanying tests.
- Updated `App.tsx`, `review.ts`, queue logic.
- Documentation updates and removal of SpecStory codepaths.
