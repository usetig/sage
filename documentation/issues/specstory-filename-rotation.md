# SpecStory creates multiple snapshot paths per session

## Summary
A single Claude session can accumulate multiple exports under `.sage/history/`, all sharing the same `sessionId` but different timestamps in the filename (e.g., `2025-10-26_16-29-36Z-get-context-on-this.md` and `2025-10-26_16-29-47Z-get-context-on-this.md`). Sage currently latches onto whichever path the user picked during the initial review and never notices when SpecStory writes subsequent snapshots to a new file. As a result, the TUI stops receiving updates even though SpecStory continues exporting newer turns for that session.

## Observed behavior
- Launch Sage and select a session whose export filename is `…16-29-36Z…`.
- SpecStory later writes a newer snapshot for the same `sessionId` into `…16-29-47Z…`.
- Sage’s file watcher keeps polling the old path and does not process additional turns.
- Manual inspection of `.sage/history/` shows the new file contains the latest conversation state, but Sage remains idle.

## Impact
Continuous reviews silently stall whenever SpecStory rotates the export filename. Users see “Status: ⏺ Idle • Waiting for Claude activity” even though Claude produced more turns, and the only workaround is to exit to the picker and reselect the session using the newest markdown file.
