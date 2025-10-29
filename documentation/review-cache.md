# Review Cache Persistence

Sage keeps a lightweight, read-only record of every critique so reopening the TUI restores the history instantly. This document explains what is stored, where it lives, and how it stays aligned with the JSONL transcripts emitted by Claude Code.

## Storage layout

- All cached reviews live under `.sage/reviews/`.
- Each Claude session gets its own JSON file named `<sessionId>.json`.

```jsonc
{
  "sessionId": "5a3da358-e204-4560-97b7-398e762af828",
  "lastTurnSignature": "sha256-hash-of-latest-turn",
  "reviews": [
    {
      "turnSignature": "sha256-hash-of-turn",
      "completedAt": "2025-10-27T07:25:06.149Z",
      "latestPrompt": "Latest user prompt text",
      "critique": {
        "verdict": "Approved",
        "why": "...",
        "alternatives": "",
        "questions": "",
        "message_for_agent": ""
      },
      "artifactPath": ".debug/review-latest-turn.txt",
      "promptText": "Full instruction segment passed to Codex"
    }
  ]
}
```

The `turnSignature` is the SHA-256 hash of the user + agent content that Sage already uses to detect new turns. It guarantees we only ever store one entry per turn.

## Lifecycle

1. **Session selection**
   - `App.tsx` calls `loadReviewCache(sessionId)` and hydrates the UI before any new Codex call.
   - If the cache contains a `lastTurnSignature`, Sage treats it as the baseline for incremental reviews.
2. **Initial review**
   - After the Codex run completes, `appendReview` persists the new critique to disk via `appendReviewToCache`.
   - If the transcript no longer contains the cached assistant UUID (e.g., the JSONL was truncated or the session restarted with entirely new content), Sage deletes the cache and clears the UI so the user doesn’t see stale cards.
3. **Incremental reviews**
   - Each completed review is appended and written atomically (`.tmp` + rename) so crashes never leave partial files.
4. **Reset**
   - Leaving the session picker resets in-memory state. Removing the JSON file (or hitting the fallback when loading fails) restarts with an empty history.

## Error handling

- Loads: invalid JSON is logged and ignored—Sage simply starts fresh.
- Saves: failures surface a dim status message but never block the UI.
- Deletion: `deleteReviewCache` is invoked when Sage detects the cached assistant UUID no longer exists in the latest transcript.

## Limits

- Each session keeps up to 500 reviews. Oldest entries are trimmed automatically to prevent unbounded growth.
- Running multiple Sage instances against the same repo can race on these files—keep one process active per repo.

## Debugging tips

- Cached files are plain JSON—open them directly in your editor.
- Timestamps (`completedAt`) are ISO strings so you can sort or diff easily.
- The cache does **not** include the full prompt payload; use the artifact path if you need to inspect the exact prompt/body sent to Codex.
