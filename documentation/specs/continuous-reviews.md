# Continuous Reviews Plan

## Goal
Keep Sage “in sync” with an active Claude Code session. After the initial review the app should automatically critique every new prompt/response pair, queueing work if Codex is already busy, and display the queue and completed critiques to the user.

---

## Proposed Flow

```
User prompts Claude
   └─ Claude finishes response
       └─ (Hook) runs: specstory sync claude --output-dir .sage/history --no-version-check --silent
           └─ SpecStory markdown is updated
               └─ Sage file watcher notices the change
                   └─ Sage queues a review job (latest prompt preview shown)
                       └─ Worker drains queue FIFO → runs Codex review → UI displays result
```

---

## Implementation Steps

1. **Initial Review (unchanged)**  
   - When the user selects a session, run the existing one-shot review so Sage has up-to-date context.  
   - Capture the markdown path (`.sage/history/<file>.md`) and last processed timestamp/hash.  

2. **Hook Trigger**  
   - Configure Claude Code’s `Stop` (and optionally `SubagentStop`) hook to invoke:  
     ```
     specstory sync claude --output-dir .sage/history --no-version-check --silent
     ```  
   - The hook doesn’t need to parse session IDs; refreshing all markdown exports keeps the watcher-driven session up to date.
   - Sage now bootstraps this hook automatically by updating `.claude/settings.local.json` when the CLI starts.

3. **File Watcher**  
   - When the user selects a session, attach a watcher (e.g., `chokidar`) to that session’s markdown file (`.sage/history/<sessionId>.md`).  
   - On change events:  
     - Compare the file’s last processed timestamp/hash; ignore if unchanged.  
     - Extract the newest user prompt (from the tail of the markdown).  
     - Push `{ sessionId, markdownPath, promptPreview }` into a FIFO queue.

4. **Review Queue & Worker**  
   - Maintain a queue in memory.  
   - Single worker loop:  
     ```
     while queue not empty:
         job = dequeue()
         run performInitialReview({ sessionId, markdownPath })
         append critique to history
         notify UI (new result)
     ```  
   - On failure (SpecStory/Codex), push the job back or mark it failed so the user can retry.

5. **UI Enhancements**  
   - “Running” screen shows:  
     - Current review (“Reviewing prompt: …”).  
     - Pending queue (prompt previews).  
   - Completed reviews append to a scrollable feed; consider keeping the latest N on screen.  
   - Add simple commands:  
     - `Q` to clear queue.  
     - `S` to pause/resume continuous mode.

6. **State Tracking**  
   - Store `lastProcessedHash` (or timestamp) per session so repeated file updates don’t duplicate jobs.  
   - Optionally persist to disk (future enhancement) to survive restarts.

7. **Testing Scenarios**  
   - Rapid-fire prompts → ensure queue order is preserved.  
   - Hook offline → manual `R` still works.  
   - SpecStory failure → queue pauses, UI displays error.  
   - Session switch mid-run → clear queue, start fresh with the new session.

---

## Future Enhancements
- Diff the markdown to limit Codex context to the new turn.  
- Implement rate limiting / batching for Codex calls.  
- Persist queue history for later inspection.  
- UI notifications when hook events are missed (fallback to manual refresh).
