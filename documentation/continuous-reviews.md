# Sage Continuous Reviews — Hook & JSONL Pipeline

This guide documents the current continuous-review implementation that rides on Claude Code hooks and native JSONL transcripts. Use it when debugging queue issues, extending automation, or onboarding new contributors.

---

## End-to-End Flow

1. **Hook emits metadata**  
   - Claude Code fires `SessionStart`, `UserPromptSubmit`, `Stop`, and `SessionEnd`.  
   - `src/hooks/sageHook.ts` writes `.sage/runtime/sessions/{sessionId}.json` (metadata) and, on `Stop`, drops a signal file in `.sage/runtime/needs-review/{sessionId}` containing `{ sessionId, transcriptPath, queuedAt }`.

2. **Session selection**  
   - `App.tsx` calls `listActiveSessions()` which loads the metadata files, verifies the transcript still exists, streams the first user entry to filter warmups, and surfaces sessions ordered by `lastUpdated`.

3. **Initial review**  
   - Selecting a session triggers `performInitialReview({ transcriptPath, lastReviewedUuid })`.  
   - `extractTurns()` reads the JSONL transcript, skipping `isSidechain`, `isMeta`, and `isCompactSummary` records, and returns ordered turn pairs plus the latest assistant UUID.  
   - The Codex thread is created or resumed, a critique is returned (or skipped if nothing changed), and `.sage/reviews/{sessionId}.json` is hydrated to restore past critiques.

4. **Signal watcher**  
   - After the initial pass, Sage starts a chokidar watcher on `.sage/runtime/needs-review/` **before** draining any backlog to avoid races.  
   - `drainSignals()` processes existing signal files so missed turns while Sage was offline are handled immediately.

5. **Queueing new work**  
   - `processSignalFile()` validates that the signal belongs to the active session, re-reads the transcript with `extractTurns({ sinceUuid })`, and enqueues new turns alongside the signal path.  
   - Empty extractions imply the signal is stale (e.g., duplicate `Stop`); in that case the file is removed and no review is queued.

6. **Queue worker**  
   - `processQueue()` drains jobs FIFO, reusing the live Codex thread (unless debug mode short-circuits).  
   - Successful critiques append to the UI feed, atomically update the review cache, and delete the signal file.  
   - Failures surface a status message and leave the signal on disk so the job retries when Sage restarts or the user presses `M`.

---

## Responsibilities by Module

| Location | Responsibility |
| --- | --- |
| `src/hooks/sageHook.ts` | Validate hook payloads, maintain per-session metadata, emit review signals, and clean up on `SessionEnd`. All writes are atomic and errors are logged to `.sage/runtime/hook-errors.log`. |
| `src/lib/jsonl.ts` | List active sessions, detect warmups, and stream transcripts into `TurnSummary[]` collections while skipping compaction noise. |
| `src/lib/review.ts` | Drive initial and follow-up Codex prompts, manage thread persistence, and hand back `turnSignature` values (assistant UUIDs) for cache dedupe. |
| `src/ui/App.tsx` | Orchestrate the TUI, signal watcher, queue, Codex thread lifecycle, clarification mode, and persistence of review history. |
| `src/lib/reviewsCache.ts` | Persist completed critiques and the latest assistant UUID, trimming history after 500 entries. |

---

## Turn & Signature Handling

- `TurnSummary.userUuid` is the user event UUID; `assistantUuid` is the paired assistant UUID (or `undefined` if Claude never replied).  
- `extractTurns({ sinceUuid })` drops everything up to and including the last reviewed assistant UUID; the queue worker therefore only receives brand-new content.  
- `latestKnownSignature()` in `App.tsx` checks the queue tail before falling back to the cached signature, ensuring batches remain strictly ordered even when multiple signals arrive back-to-back.  
- Resumed sessions duplicate historical entries into a new JSONL file; because we compare UUIDs, old turns are ignored and only the appended entries trigger reviews.

---

## UI & Hotkeys

- `B` — Exit continuous mode and return to the session list.  
- `M` — Manually rescan `.sage/runtime/needs-review/` (useful after resolving hook issues or when running in debug mode).  
- `W` — Toggle the WHY section for approved critiques (collapses/expands in batch).  
- `C` — Enter clarification mode for the latest critique (see `documentation/specs/interactive-followup-design.md`).

Status messaging reflects the current stage (initial review, incremental review, waiting, debug mode). When debug mode is active the status banner and critique cards explicitly mention it and link to the artifact path.

---

## Failure & Recovery

- **Missing transcript** — If hook metadata points to a deleted transcript, `processSignalFile()` logs a warning, removes the signal, and clears the session entry on the next refresh.  
- **Codex error** — Queue item stays at the head, status logs “Review failed …”. Clearing the error (e.g., restarting Codex) and pressing `M` replays the signal.  
- **Hook writer errors** — Logged to `.sage/runtime/hook-errors.log`; signals are not emitted. Fix the hook (often missing `cwd`/`transcript_path`) and re-run the prompt to regenerate a signal.  
- **Manual session end** — `SessionEnd` deletes both metadata and signal files so the picker immediately hides the closed session.

---

## What Changed vs. the SpecStory Era

- No more `.sage/history/*.md` exports, SpecStory hooks, or markdown parsing.  
- The watcher listens to lightweight signal files instead of large transcript rewrites.  
- Warmups and compaction summaries are filtered during JSONL streaming instead of via markdown heuristics.  
- Continuous mode keeps functioning even if Sage was closed when Claude responded; signals accumulate until Sage drains them.

---

## Future Enhancements

1. **Retries / Backoff** — Track attempt counts per signal and add exponential backoff or jitter to `processQueue()`.
2. **Multi-session awareness** — Allow watching multiple sessions concurrently once the UI supports switching without tearing down the watcher.  
3. **Sidechain insights** — Optionally read `agent-*.jsonl` transcripts for richer critiques or analytics.  
4. **Signal garbage collection** — Periodically purge signals older than N hours when their transcript hasn’t changed.  
5. **Telemetry hooks** — Emit structured logs for queue events to help diagnose timing issues.

Keep this document updated whenever queue semantics, hook wiring, or JSONL parsing changes so future contributors have an accurate reference for the continuous-review pipeline.
