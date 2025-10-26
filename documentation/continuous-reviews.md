# Sage Continuous Reviews — Implementation Guide

This document describes how Sage keeps up with an active Claude Code session once the user has selected it in the TUI. It covers the flow from hook bootstrap through Codex follow-up critiques so contributors can safely extend or debug the system.

---

## High-Level Flow

1. **CLI Startup**
   - `src/ui/App.tsx` calls `ensureStopHookConfigured()` before listing sessions.
   - The helper (`src/lib/hooks.ts`) ensures `.claude/settings.local.json` contains a `Stop` hook that runs `specstory sync claude --output-dir "$CLAUDE_PROJECT_DIR/.sage/history" --no-version-check --silent`.

2. **Session Selection**
   - When the user picks a session, Sage:
     1. Runs `syncSpecstoryHistory()` to refresh `.sage/history/*.md`.
     2. Performs the initial critique via `performInitialReview()` (`src/lib/review.ts`), which:
        - Reads the full markdown.
        - Parses every turn with `extractTurns()` (`src/lib/markdown.ts`).
        - Starts a new Codex thread (`runInitialReview()` in `src/lib/codex.ts`).
        - Stores the critique, the parsed turns, and the thread reference.
     3. Saves the signature (SHA-256 of user + agent text) of the latest processed turn so future updates only look at new content.
     4. Starts a chokidar watcher scoped to the active markdown file.

3. **Claude Responds**
   - Claude finishes, triggering the `Stop` hook in `.claude/settings.local.json`.
   - SpecStory rewrites the markdown export under `.sage/history/…`.
   - The chokidar watcher receives a `change` event.

4. **Watcher Handling**
   - `startWatcher()` in `src/ui/App.tsx`:
     - Checks that the file’s `mtime` differs from the last processed timestamp.
     - Reads the entire markdown and parses all turns.
     - Calls `collectNewTurns()` to walk backward from the tail until it sees the stored signature (or the latest turn in the queue). Everything after that point is treated as new.
     - Enqueues a `ReviewQueueItem` containing the ordered list of new turns and a friendly prompt preview.

5. **Queue Worker**
   - A single worker loop drains jobs FIFO (`processQueue()` in `src/ui/App.tsx`):
     - Reuses the existing Codex thread reference (from initial review).
     - Runs `performIncrementalReview()` with the batched turns.
     - Updates the “last processed” signature to the final turn in that job.
     - Appends the new critique to the UI feed and clears the job on success.
   - If Codex fails, the job remains in the queue and a status message is displayed. (No automatic retry/backoff yet—manual intervention is required.)

---

## Key Modules & Responsibilities

| File | Purpose |
| --- | --- |
| `src/lib/hooks.ts` | Creates or extends `.claude/settings.local.json` to include the SpecStory `Stop` hook. Idempotent and safe to run on every startup. |
| `src/lib/specstory.ts` | Wraps the `specstory sync` invocation and provides session metadata derived from `.sage/history`. |
| `src/lib/markdown.ts` | Parses SpecStory markdown into structured turn objects. `extractTurns()` returns the full ordered list; `extractLatestTurn()` is now a convenience wrapper. |
| `src/lib/review.ts` | Orchestrates Codex calls. `performInitialReview()` returns the critique, parsed turns, and a `Thread`; `performIncrementalReview()` runs follow-up critiques against only the new turns. |
| `src/lib/codex.ts` | Builds prompts and interacts with the OpenAI Codex SDK. The initial prompt instructs Codex to map the repo; the follow-up prompt focuses on incremental evaluation. |
| `src/ui/App.tsx` | Manages the Ink UI, watcher lifecycle, queue/process loop, and progress messages. Maintains the active Codex thread and the “last processed turn” signature. |

---

## Turn Tracking & Signatures

- Each `TurnSummary` contains raw markdown text for the user and agent segments.
- `collectNewTurns()` hashes each turn (`user + '\n' + agent`) with SHA-256.
- When we enqueue jobs, we also check the current queue tail so that multiple watcher events arriving before the worker drains the queue still process in sequence.
- If the stored signature is missing (e.g., on first run or after a reset), the watcher treats the entire markdown as new to avoid silently skipping content.

---

## Codex Threads

- **Initial review** — `runInitialReview()` starts a fresh thread (via `Codex.startThread()`) and issues a comprehensive prompt including the full conversation transcript.
- **Follow-up reviews** — `runFollowupReview()` sends only the new turn(s) to the existing thread. The prompt:
  - Reminds Codex it is continuing the same session.
  - Supplies each new turn in order.
  - Requests a critique card without repeating the repo reconnaissance instructions.
- **Thread lifetime** — the thread reference lives in `codexThreadRef`; it is cleared when the user exits continuous mode or selects a new session.
- **Error handling** — if the thread is missing (e.g., after a crash) when a job arrives, Sage logs a status message and leaves the job in the queue so the user can restart the session cleanly.

---

## UI & Commands

- **Running Screen**
  - Displays current status messages, the job being processed, queued reviews (with a `(+N more turns)` suffix when batching occurs), and the list of completed critiques.
  - **Commands:**
    - `M` to manually trigger SpecStory sync. Runs `syncSpecstoryHistory()` which executes the same command as the Stop hook. The file watcher detects the updated markdown and automatically enqueues any new turns for review. Useful when the Stop hook doesn't fire, for forcing a refresh check, or during testing/debugging.
    - `B` to exit continuous mode and return to session picker.
- **Queue Behavior**
  - Items are enqueued as soon as the watcher parses new turns.
  - The worker marks jobs as "completed" only after Codex returns successfully.
  - On failure, the job stays in the queue and status messaging indicates the error (no automatic retries).

---

## Failure & Recovery Notes

- **SpecStory Sync Fails**
  - `ensureStopHookConfigured()` throws and the App transitions to the error screen with a message prompting the user to resolve the issue (`src/ui/App.tsx:359-395`).
  - The user can fix the environment and press `R` to retry.
- **Codex Failure During Follow-Up**
  - Status message “Review failed: …” is logged.
  - Job remains at the head of the queue; currently requires manual resolution (e.g., re-running `R` to refresh or restarting Sage).
- **Watcher Resync After Downtime**
  - Because we walk backwards using signatures, multiple turns accumulated while Sage was offline are processed in order on the next change event.
- **Switching Sessions**
  - `resetContinuousState()` clears the watcher, queue, signatures, and thread references to avoid cross-session contamination.

---

## Extending the System

1. **Retries / Backoff**  
   - Add metadata to `ReviewQueueItem` (e.g., attempt count, timestamps) and implement exponential backoff in `processQueue()`.

2. **Persistent State**  
   - Persist the last processed signature per session (e.g., JSON under `.sage/state.json`) to survive full restarts.

3. **Richer Follow-Up Prompts**  
   - Include a summary of unresolved concerns from previous critiques or request Codex to acknowledge whether prior warnings are resolved.

4. **Additional Hooks**  
   - Optionally add `SubagentStop` to the hook configuration by extending `ensureStopHookConfigured()` to update both events.

5. **Telemetry**  
   - Implement a debug logger flag (environment variable) to mirror queue activity to disk for troubleshooting.

---

## Quick Reference

- CLI code path: `src/ui/App.tsx`
- Hook bootstrap: `src/lib/hooks.ts`
- Turn parsing: `src/lib/markdown.ts`
- Initial review: `performInitialReview()` → `runInitialReview()`
- Follow-up review: `performIncrementalReview()` → `runFollowupReview()`
- Signature helpers: `computeTurnSignature()` and `collectNewTurns()` in `src/ui/App.tsx`

Keep this document updated whenever the continuous-review pipeline changes (e.g., new commands, retry logic, or prompt tweaks) so future contributors understand how Sage handles ongoing Claude sessions.
