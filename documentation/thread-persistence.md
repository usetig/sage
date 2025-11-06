# Thread Persistence & Resumption

This document explains how Sage persists Codex threads across restarts and automatically resumes them when you re-select sessions.

---

## Overview

When you select a session for review, Sage creates a **Codex thread** that maintains conversation context and codebase exploration history. Starting in v1.0, Sage saves thread metadata to disk so that:

1. Re-selecting the same session resumes the existing Codex thread (preserving context)
2. Sage avoids redundant reviews when conversation hasn't changed
3. Incremental reviews only send new turns to Codex (not the entire history)

This persistence happens in two places:
- **`~/.sage/{project-path}/threads/{sessionId}.json`** — Codex thread metadata (this doc)
- **`~/.sage/{project-path}/reviews/{sessionId}.json`** — Completed critique history (see `review-cache.md`)

---

## Storage Location

**Directory:** `~/.sage/{project-path}/threads/`

**File naming:** One JSON file per Claude Code session: `{sessionId}.json`

**Example:**
```
~/.sage/
└── Users-you-projects-myapp/
    └── threads/
        ├── abc123-session-id.json
        └── xyz789-session-id.json
```

---

## ThreadMetadata Schema

Each file stores:

```typescript
{
  "threadId": "thread_abc123xyz",    // Codex thread ID (from ~/.codex/sessions)
  "sessionId": "abc123-session-id",  // Claude Code session ID
  "timestamp": 1704067200000,        // When thread was created (ms)
  "lastUsed": 1704153600000,         // Last access timestamp (ms)
  "lastReviewedTurnCount": 5         // How many conversation turns were reviewed
}
```

### Field Explanations

| Field | Purpose |
|-------|---------|
| `threadId` | The Codex SDK thread identifier. Stored in `~/.codex/sessions/` by the Codex agent. Used to resume threads via `codex.resumeThread(threadId)`. |
| `sessionId` | Claude Code session ID. Links this thread to a specific Claude conversation. |
| `timestamp` | When Sage first created this thread. Used for cleanup/age tracking. |
| `lastUsed` | Updated every time Sage loads this thread. Tracks recent activity. |
| `lastReviewedTurnCount` | Critical field: tracks how many conversation turns have been reviewed. Sage compares this to the current markdown export to determine if new turns exist. |

---

## The Three Resumption Scenarios

When you select a session, Sage loads the thread metadata and determines which path to take:

### Scenario 1: New Thread (No Metadata)

**When:** First time reviewing this session, or thread metadata was deleted.

**What happens:**
1. Call `codex.startThread()` to create new Codex thread
2. Extract all conversation turns from the JSONL transcript
3. Run `runInitialReview()` with full conversation history
4. Save thread ID + current turn count to `.sage/threads/{sessionId}.json`
5. Display critique and enter continuous mode

**Status messages:**
- `loading session context...`
- `reading conversation history...`
- `analyzing codebase context...`

**`isFreshCritique` flag:** `true` (new analysis performed)

---

### Scenario 2: Resumed Thread - No New Turns

**When:** Thread exists AND conversation hasn't changed since last review.

**Detection logic:**
```typescript
currentTurnCount = turns.length  // From JSONL transcript
lastReviewedTurnCount = metadata.lastReviewedTurnCount
hasNewTurns = currentTurnCount > lastReviewedTurnCount
```

If `!hasNewTurns`, Sage knows conversation is unchanged.

**What happens:**
1. Call `codex.resumeThread(threadId)` to restore context
2. **Skip Codex review entirely** (no API call)
3. Return placeholder critique:
   ```
   verdict: "Approved"
   why: "Session previously reviewed. Entering continuous mode with existing context."
   ```
4. Do NOT save new critique to review cache (prevents duplicates)
5. Restore previous critiques from `.sage/reviews/{sessionId}.json`
6. Enter continuous mode with existing thread

**Status messages:**
- `Resuming Sage thread...` (shown briefly, then cleared)
- `Session previously reviewed. Using existing critiques.`

**`isFreshCritique` flag:** `false` (placeholder, not persisted)

**Why this matters:** Without the `isFreshCritique` flag, Sage would append a duplicate critique card every time you resumed. This flag tells the UI to skip appending/persisting the placeholder.

---

### Scenario 3: Resumed Thread - New Turns Exist

**When:** Thread exists AND conversation has new turns since last review.

**What happens:**
1. Call `codex.resumeThread(threadId)` to restore context
2. Extract only new turns: `turns.slice(lastReviewedTurnCount)`
3. Run `runFollowupReview()` with new turns only
4. Update turn count: `updateThreadTurnCount(sessionId, currentTurnCount)`
5. Display new critique and continue watching

**Status messages:**
- `examining new dialogue...`
- `reviewing changes...`

**`isFreshCritique` flag:** `true` (new analysis performed)

**Efficiency:** Codex already knows the codebase context from the previous review. Only new conversation content is sent, making incremental reviews much faster.

---

## The `isFreshCritique` Flag

### Purpose

Distinguishes between:
- **Fresh critiques** (`true`) — New analysis from Codex that should be displayed and persisted
- **Resume placeholders** (`false`) — Informational message that review was skipped

### Where It's Set

In `src/lib/review.ts`:

```typescript
// Scenario 1: New thread
isFreshCritique = true;

// Scenario 2: Resumed, no new turns
isFreshCritique = false;

// Scenario 3: Resumed with new turns
isFreshCritique = true;

// Incremental reviews (continuous mode)
isFreshCritique = true;
```

### How It's Used

In `src/ui/App.tsx`:

```typescript
// Skip appending placeholder critiques
if (!result.isFreshCritique) {
  // Don't add to UI or save to cache
  return;
}

// Only persist real critiques
if (review.isFreshCritique === false) {
  return;
}
```

This prevents duplicate critique cards when resuming unchanged threads.

---

## Relationship to Review Cache

**Thread metadata** and **review cache** serve different purposes:

| Feature | Thread Metadata (`.sage/threads/`) | Review Cache (`.sage/reviews/`) |
|---------|-----------------------------------|--------------------------------|
| **Purpose** | Track Codex thread state | Store completed critique results |
| **Contains** | Thread ID, turn count | Full critique objects with verdicts/reasoning |
| **Tracking** | Uses turn count (integer) | Uses turn signatures (SHA-256 hashes) |
| **Used for** | Determining if review needed | Restoring UI history on restart |
| **Lifecycle** | Persists until manually deleted | Pruned after 500 reviews per session |

**How they work together:**

1. You select a session
2. Sage loads thread metadata → determines if review needed
3. Sage loads review cache → displays previous critiques in UI
4. If thread has no new turns:
   - Skip Codex review (per thread metadata)
   - Show cached critiques (from review cache)
   - Don't append placeholder (per `isFreshCritique` flag)
5. If thread has new turns:
   - Run incremental review (send only new turns)
   - Append new critique to UI
   - Persist to review cache

---

## Continuous Mode & Signal Processing

Once the initial review completes, Sage enters **continuous mode**:

1. A chokidar watcher listens to `~/.sage/{project-path}/runtime/needs-review/` for new signal files (one per `Stop` hook).
2. Each signal is processed by re-reading the transcript with `extractTurns({ sinceUuid })`, which slices away previously reviewed turns using assistant UUIDs.
3. Non-empty results enqueue an incremental review job and include the originating signal path so it can be deleted on success.
4. `performIncrementalReview()` runs on the existing Codex thread, appends the critique, and updates the cache; failures leave the signal file in place for retry.

**Turn tracking difference:**
- Initial reviews rely on the turn count stored in thread metadata to determine whether anything changed since the last critique.
- Continuous mode uses assistant UUIDs from the review cache to detect new content inside the same transcript.
- Both approaches prevent re-reviewing the same turns, even when Claude resumes a session and clones prior history into a new JSONL file.

---

## Edge Cases & Special Handling

### Thread Deleted from `~/.codex/sessions`

Codex may purge old threads from its internal storage.

**Detection:**
```typescript
try {
  thread = codex.resumeThread(threadId, options);
} catch (err) {
  // Thread not found in ~/.codex/sessions
  await deleteThreadMetadata(sessionId);
  // Falls through to create new thread
}
```

**Result:** Sage detects the failure, deletes stale metadata, and creates a fresh thread.

### Thread ID Not Available After First Run

Thread IDs should be available after the first turn completes.

**Graceful fallback:**
```typescript
if (threadId) {
  await saveThreadMetadata(sessionId, threadId, currentTurnCount);
} else {
  onProgress?.('Warning: thread ID not available for persistence');
  // Continue without persistence (will create new thread next time)
}
```

### Session History Changed in Claude Code

If you manually edit `.sage/history/{sessionId}.md` or Claude's conversation changes (e.g., undo/redo), the review cache becomes stale.

**Detection:** Review cache uses turn signatures to validate cached critiques still match current conversation.

**Resolution:** If signatures don't match, clear entire review cache and start fresh. Thread metadata remains valid (tracks turn count, not content hashes).

### Multiple Sage Instances

Running multiple Sage instances on the same session can cause race conditions:
- Both try to save thread metadata simultaneously
- Last write wins (atomic writes via temp file prevent corruption)

**Recommendation:** Avoid running multiple Sage instances for the same session. Document this in troubleshooting.

---

## Troubleshooting

### "No active Codex thread to continue the review"

**Cause:** Thread metadata exists but thread reference was lost in memory.

**Fix:**
1. Exit Sage (`B` to return to picker)
2. Re-select the session (will resume thread properly)

### Duplicate Critique Cards

**Cause:** Bug in `isFreshCritique` handling (should be fixed in v1.0+).

**Fix:**
1. Delete `~/.sage/{project-path}/reviews/{sessionId}.json`
2. Exit and re-select session

### Thread Seems Out of Sync

**Symptoms:**
- Sage reviews turns that were already reviewed
- Codex doesn't have context from previous reviews

**Fix:**
1. Delete `~/.sage/{project-path}/threads/{sessionId}.json`
2. Exit and re-select session (will create fresh thread)

### Clear All Thread State

To reset everything and start fresh:

```bash
rm -rf ~/.sage/Users-you-projects-myapp/threads/
rm -rf ~/.sage/Users-you-projects-myapp/reviews/
```

(Replace `Users-you-projects-myapp` with your encoded project path)

Then restart Sage. All sessions will start with new threads.

---

## Implementation Details

### Key Functions

**`src/lib/threads.ts`:**
- `saveThreadMetadata()` — Persists thread info after initial review
- `loadThreadMetadata()` — Loads existing thread (updates `lastUsed`)
- `updateThreadTurnCount()` — Increments turn count after incremental reviews
- `getOrCreateThread()` — Core decision point: resume or create new

**`src/lib/review.ts`:**
- `performInitialReview()` — Implements three resumption scenarios
- Sets `isFreshCritique` flag based on whether Codex review ran

**`src/ui/App.tsx`:**
- `handleSessionSelection()` — Orchestrates thread loading and review cache restoration
- Validates review cache against current conversation
- Skips appending/persisting when `isFreshCritique === false`

### File Permissions

Thread metadata files are created with default permissions (0644). They contain no secrets, just session IDs and turn counts.

---

## Future Enhancements

Potential improvements to thread persistence:

1. **Automatic cleanup** — Delete threads older than 30 days with no activity
2. **Thread chain tracking** — When Claude resumes with new session ID, link back to parent thread
3. **Thread export/import** — Share thread state across machines
4. **Thread health checks** — Validate thread still exists in `~/.codex/sessions` before resuming
5. **Turn count validation** — Compare thread metadata turn count to markdown export for consistency

---

## Summary

- **Thread persistence** enables Sage to maintain Codex context across restarts
- **Three scenarios** determine review behavior: new thread, resumed unchanged, resumed with new turns
- **`isFreshCritique` flag** prevents duplicate critiques when resuming unchanged threads
- **Thread metadata** (turn counts) and **review cache** (turn signatures) serve complementary purposes
- **Continuous mode** uses file watching with turn signatures to detect new content
- **Edge cases** are handled gracefully with fallbacks and cleanup logic

Thread persistence makes Sage's reviews faster, smarter, and more context-aware over time.
