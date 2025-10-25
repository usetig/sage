# Session Picker Refactor Plan

## Goal
Replace the current JSONL-based session discovery with SpecStory exports so Sage’s conversation list and reviews operate directly on the markdown that SpecStory generates.

## Steps

1. **Kick off SpecStory sync when Sage starts**
   - Command: `specstory sync claude --output-dir .sage/history --no-version-check --silent`.
   - Run once per launch (and on manual refresh). If the CLI is missing or the command fails, capture the error and display a helpful message in the TUI instead of crashing.

2. **Build the session list from SpecStory exports**
   - After a successful sync, scan `.sage/history/*.md`.
   - Extract metadata from the markdown header (`<!-- Claude Code Session … -->`):
     - Session ID
     - Timestamp (already baked into the filename and header)
     - Title (first heading or summary; treat bare timestamps or “Warmup” as warmups).
   - Filter out warmup files (files whose title is empty or matches the timestamp pattern).
   - Sort by timestamp descending and feed this list to the Ink picker.

3. **Adapt the review pipeline to reuse existing markdown**
   - When a session is selected, pass the markdown path from `.sage/history` straight into the review flow.
   - Skip the extra export/copy into `.sage/sessions/<sessionId>`; the file already exists.
   - Ensure progress logging still prints the markdown path and latest prompt before the Codex call.

4. **Documentation and logging updates**
   - Note in `what-is-sage.md` / `agents.md` that Sage syncs SpecStory on launch and uses `.sage/history` for listing and reviews.
   - Add concise log messages for:
     - SpecStory sync start/end (and failures).
     - Number of sessions loaded and warmups skipped.

## Future Considerations
- Continuous review hooks can reuse this setup: when a hook fires, re-run `specstory sync` for the specific session ID and re-run the same picker/review pipeline.
- If users want cross-project history, allow switching the sync’s working directory or output path per repo, but keep the default scoped to the current repo.
