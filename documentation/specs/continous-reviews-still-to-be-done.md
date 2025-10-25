# Continuous Reviews – Remaining Work Plan

This document captures the outstanding tasks required to ship the continuous-review experience described in `documentation/specs/continuous-reviews.md`. Another coding agent can pick up this checklist and implement the remaining pieces.

---

## Current State (Branch `use-specstory`)

- Session picker now depends entirely on SpecStory exports under `.sage/history/`.
- On initial selection Sage runs `performInitialReview()` using the chosen markdown file.
- `src/ui/App.tsx` already contains queue state, a chokidar watcher skeleton, and UI surfaces for status/queue/results.
- No Claude Code hook has been configured yet.
- No script exists to run `specstory sync` from the hook.
- Continuous mode does **not** automatically enqueue new turn events; the watcher logic needs to be finalized.

---

## Implementation Tasks

### 1. Hook Configuration
1.1 Update `.claude/settings.local.json` (or the appropriate settings file) so the `Stop` hook runs SpecStory directly:
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "specstory sync claude --output-dir \"$CLAUDE_PROJECT_DIR/.sage/history\" --no-version-check --silent"
          }
        ]
      }
    ]
  }
}
```
1.2 Ensure Sage bootstraps this hook automatically (e.g., during CLI startup) so users don’t have to configure it manually.

### 2. Watcher Finalization
2.1 In `src/ui/App.tsx`, wire `startWatcher` to watch only the active session’s markdown file (already partially implemented). Confirm that the watcher closes/reset when switching sessions or exiting continuous mode.
2.2 Ensure `handleChange` reads the updated markdown, derives the set of unprocessed turns (per Section 3.2), and enqueues each one with its user prompt preview.
2.3 Guarantee duplicate events are ignored by comparing file version hashes (`lastProcessedVersionRef`).

### 3. Incremental Codex Worker
3.1 Keep a dedicated Codex thread alive for the active session. Use `performInitialReview` only for the cold-start pass, then reuse that thread for every queued turn.
3.2 When a queue job runs, parse turns from the end of the markdown backwards until you hit the stored signature of the most recent processed turn. Collect every newer turn after that point (preserving order) and send only those user + assistant messages to the existing thread with a follow-up system prompt tailored for incremental critiques—skip the full repo recap. After Codex returns a critique, update the stored signature to the newest processed turn.
3.3 Ensure the worker loop handles exiting continuous mode (`B`) while appending completed critiques to the UI feed. If Codex errors, surface the failure and leave the job in the queue for manual retry; do not fall back to re-reading the entire transcript.

### 4. Initial Review vs. First Hook
4.1 After the initial review, immediately capture the latest file version so the first hook-triggered change isn’t mistaken for a new turn.  
4.2 When the watcher fires for the first time, ensure the queue gets populated only if a genuinely new prompt exists (not the same prompt reviewed during the initial run).

### 5. Graceful Shutdown & Cleanup
5.1 On app exit or when selecting a new session, close chokidar watchers and reset queue state.  
5.2 Ensure no dangling promises or fs handles remain (the `cleanupWatcher` helper should be invoked in `useEffect` teardown).

### 6. Telemetry / Debugging Aids (Optional but Helpful)
- Add debug logging (guarded by an env flag) for queue events and hook triggers.
- Consider a CLI flag to disable automatic sync/watch if users prefer manual mode.

### 7. Testing Checklist
- Manual: start Claude session, run `sage`, select session, confirm initial review works.
- Hook: trigger a new prompt/response; verify the hook runs (look for the new timestamp in `.sage/history/<sessionId>.md`) and Sage’s queue picks it up.
- Rapid prompts: send multiple prompts quickly; queue should show them in order, clearing as Codex finishes.
- Exit: hit `B` to return to session picker; watcher should detach and state reset.

---

## Deliverables
- Automatic hook bootstrapping that keeps `.sage/history` fresh.
- Incremental Codex worker logic per Section 3, including updated prompting.
- Watcher + queue plumbing in `src/ui/App.tsx` validated end-to-end.
- Documentation updates (README, `continuous-reviews.md`, etc.) describing the hook requirement and continuous-review behavior.

---

## Notes
- This plan assumes the user runs Claude Code locally and can configure hooks.
- If running in environments without hooks (e.g., Claude Web), a fallback file watcher on JSONL logs might still be desirable in future work.
- Keep Codex read-only by maintaining context instructions in `src/lib/codex.ts`.
