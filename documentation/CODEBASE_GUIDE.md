# Sage Codebase Guide

**A Comprehensive Walkthrough of the Sage AI Code Reviewer**

> This document provides a detailed technical breakdown of the Sage codebase. It's designed to be read sequentially, walking you through the architecture, implementation details, and design decisions that make Sage work.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture & Design Patterns](#architecture--design-patterns)
3. [Core Data Structures](#core-data-structures)
4. [Entry Point & Application Flow](#entry-point--application-flow)
5. [File-by-File Breakdown](#file-by-file-breakdown)
6. [Key Algorithms & Logic](#key-algorithms--logic)
7. [State Management](#state-management)
8. [Error Handling Patterns](#error-handling-patterns)
9. [Integration Points](#integration-points)
10. [Testing Strategy](#testing-strategy)
11. [Code Patterns & Conventions](#code-patterns--conventions)
12. [Future Considerations](#future-considerations)

---

## Project Overview

### What Sage Does

Sage is a **passive AI code reviewer** that monitors Claude Code sessions and provides automated second opinions. It:

- **Reads** Claude Code conversation transcripts (JSONL format)
- **Watches** for new responses via Claude Code hooks
- **Reviews** Claude's suggestions using OpenAI Codex SDK
- **Displays** structured critiques in a terminal UI
- **Never modifies** files or executes code (read-only by design)

### Core Value Proposition

Developers using Claude Code often want a second opinion but don't want to:
- Break their workflow to copy conversations
- Lose repository context
- Manually trigger reviews

Sage solves this by integrating seamlessly into the workflow with zero additional commands after initial setup.

### Technology Stack

- **Runtime**: Node.js 18+ (ES modules)
- **Language**: TypeScript (strict mode)
- **UI Framework**: React + Ink (terminal UI)
- **AI Agent**: OpenAI Codex SDK (`@openai/codex-sdk`)
- **File Watching**: Chokidar
- **Build Tool**: TypeScript compiler (`tsc`)
- **Execution**: `tsx` (TypeScript execution)

---

## Architecture & Design Patterns

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code (External)                   │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ SessionStart │  │      Stop    │  │UserPromptSubmit  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│                           ▼                                 │
└─────────────────────── sageHook.ts ─────────────────────────┘
                              │
                              │ Writes metadata & signals
                              ▼
        ┌────────────────────────────────────────────────────┐
        │    ~/.sage/{project-path}/runtime/sessions/*.json     │
        │    ~/.sage/{project-path}/runtime/needs-review/*.json │
        └────────────────────────────────────────────────────┘
                              │
                              │ Reads & watches
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Sage TUI (App.tsx)                        │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │Session Picker│  │ Signal Watch │  │ Review Queue │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│                           ▼                                 │
│                    ┌──────────────┐                         │
│                    │ review.ts    │                         │
│                    └──────┬───────┘                         │
│                           │                                 │
│                           ▼                                 │
│                    ┌──────────────┐                         │
│                    │  codex.ts    │                         │
│                    └──────┬───────┘                         │
│                           │                                 │
│                           ▼                                 │
└───────────────────── Codex SDK ─────────────────────────────┘
```

### Design Patterns Used

1. **Singleton Pattern**: Codex instance (`codexInstance` in `codex.ts`)
2. **Observer Pattern**: File watcher (chokidar) observes signal directory
3. **Queue Pattern**: FIFO queue for pending reviews
4. **State Machine**: Screen transitions (`loading` → `session-list` → `running` → `chat`)
5. **Factory Pattern**: Thread creation/resumption (`getOrCreateThread`)
6. **Strategy Pattern**: Different prompt builders for initial vs. incremental reviews
7. **Cache Pattern**: Review history persistence (`reviewsCache.ts`)

### Data Flow

```
User Action → Claude Code → Hook Event → Signal File
                                              ↓
                                         File Watcher
                                              ↓
                                         Queue Item
                                              ↓
                                         JSONL Parser
                                              ↓
                                         Turn Extraction
                                              ↓
                                         Codex Review
                                              ↓
                                         Critique Card
```

---

## Core Data Structures

### Type Definitions (`src/types.ts`)

```typescript
export interface Critique {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives?: string;
  questions?: string;
  raw: string;
}

export interface Session {
  id: string;
  filePath: string;
  timestamp: Date;
}
```

**Note**: These types appear to be legacy. The codebase primarily uses types defined in other modules.

### Active Session (`src/lib/jsonl.ts`)

```typescript
export interface ActiveSession {
  sessionId: string;
  transcriptPath: string;      // Path to Claude's JSONL log file
  cwd: string;                 // Working directory
  lastPrompt?: string;         // Last user prompt text
  lastStopTime?: number;       // Timestamp of last Stop hook
  lastUpdated: number;         // Last metadata update timestamp
  title: string;               // Display title (derived from lastPrompt)
}
```

**Purpose**: Represents a discoverable Claude Code session that Sage can review.

### Turn Summary (`src/lib/jsonl.ts`)

```typescript
export interface TurnSummary {
  user: string;                 // User's prompt text
  agent?: string;              // Claude's response text
  userUuid?: string;           // UUID of user message entry
  assistantUuid?: string;      // UUID of assistant response entry
}
```

**Purpose**: Represents a single user-Claude exchange. Used for:
- Formatting conversation history for Codex prompts
- Tracking which turns have been reviewed
- Incremental processing (only new turns)

### Critique Response (`src/lib/codex.ts`)

```typescript
export interface CritiqueResponse {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;                  // Required: Main reasoning
  alternatives: string;         // Optional: Alternative approaches
  questions: string;           // Optional: Questions for developer
  message_for_agent: string;   // Optional: Direct message to Claude
}
```

**Purpose**: Structured output from Codex reviews. All fields are required by JSON schema (OpenAI constraint), but empty strings indicate optional sections.

### Review Result (`src/lib/review.ts`)

```typescript
export interface ReviewResult {
  critique: CritiqueResponse;
  transcriptPath: string;
  completedAt: string;          // ISO timestamp
  turnSignature?: string;       // assistantUuid of reviewed turn
  latestPrompt?: string;        // User prompt that triggered review
  debugInfo?: {
    artifactPath: string;       // Path to .debug/review-*.txt
    promptText: string;         // Full prompt sent to Codex
  };
  isFreshCritique: boolean;     // false if resumed from cache
}
```

**Purpose**: Complete result of a review operation, including metadata for caching and display.

### Thread Metadata (`src/lib/threads.ts`)

```typescript
interface ThreadMetadata {
  threadId: string;             // Codex thread ID
  sessionId: string;            // Claude session ID
  timestamp: number;            // Creation timestamp
  lastUsed: number;             // Last access timestamp
  lastReviewedTurnCount: number; // Number of turns last reviewed
}
```

**Purpose**: Persists Codex thread state across Sage restarts. Enables:
- Resuming existing Codex threads (context preservation)
- Detecting if new turns exist since last review
- Avoiding duplicate reviews

### Review Cache (`src/lib/reviewsCache.ts`)

```typescript
export interface SessionReviewCache {
  sessionId: string;
  lastTurnSignature: string | null;  // UUID of last reviewed turn
  reviews: StoredReview[];            // Cached critique history
}

export interface StoredReview {
  turnSignature: string;
  completedAt: string;
  latestPrompt?: string | null;
  critique: CritiqueResponse;
  artifactPath?: string;
  promptText?: string;
}
```

**Purpose**: Persists critique history so Sage can:
- Restore previous critiques when re-selecting a session
- Skip reviews for already-reviewed turns
- Display critique history even after restart

---

## Entry Point & Application Flow

### Entry Point (`src/index.tsx`)

```1:7:src/index.tsx
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './ui/App.js';

render(<App />);
```

**Flow**:
1. Shebang (`#!/usr/bin/env node`) makes it executable
2. Imports React and Ink's `render` function
3. Renders the root `App` component
4. Ink handles terminal rendering and input

**Key Point**: This is a React app that renders to the terminal, not a browser.

### Application Initialization Flow

```
index.tsx
  ↓
App.tsx (mount)
  ↓
useEffect → init()
  ↓
ensureHooksConfigured()  // Auto-configure Claude hooks
  ↓
reloadSessions()
  ↓
listActiveSessions()
  ↓
Read .sage/runtime/sessions/*.json
  ↓
Filter warmup sessions
  ↓
Display session picker (with "✓ Hooks configured" if first run)
```

### Session Selection Flow

```
User presses Enter
  ↓
handleSessionSelection(session)
  ↓
loadReviewCache(sessionId)  // Restore cached critiques
  ↓
performInitialReview()      // Initial Codex review
  ↓
initializeSignalWatcher()    // Start watching for new signals
  ↓
drainSignals()              // Process any pending signals
  ↓
Enter continuous mode (screen = 'running')
```

### Continuous Review Flow

```
Claude Code Stop hook fires
  ↓
sageHook.ts writes signal file
  ↓
File watcher detects new file
  ↓
processSignalFile()
  ↓
extractTurns() with sinceUuid filter
  ↓
enqueueJob() → FIFO queue
  ↓
processQueue() (FIFO worker)
  ↓
performIncrementalReview()
  ↓
Display CritiqueCard
```

---

## File-by-File Breakdown

### `src/ui/App.tsx` - Main Application Orchestrator

**Purpose**: Central state management and UI orchestration for the entire application.

**Key Responsibilities**:
- Session discovery and selection
- File watching for hook signals
- FIFO queue management
- Review state persistence
- Screen state machine
- Keyboard input handling

**State Variables**:

```typescript
const [screen, setScreen] = useState<Screen>('loading');
const [sessions, setSessions] = useState<ActiveSession[]>([]);
const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
const [reviews, setReviews] = useState<CompletedReview[]>([]);
const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
const [currentJob, setCurrentJob] = useState<ReviewQueueItem | null>(null);
const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
```

**Refs (for values that shouldn't trigger re-renders)**:

```typescript
const queueRef = useRef<ReviewQueueItem[]>([]);
const workerRunningRef = useRef(false);
const watcherRef = useRef<FSWatcher | null>(null);
const codexThreadRef = useRef<Thread | null>(null);
const lastTurnSignatureRef = useRef<string | null>(null);
const processedSignalsRef = useRef<Set<string>>(new Set());
```

**Why Refs?**: Refs don't trigger re-renders when updated. Used for:
- Queue state (updated frequently, but UI reads from `queue` state)
- Worker lock (prevents concurrent queue processing)
- File watcher instance (lifecycle management)
- Codex thread (persisted across renders)
- Turn signature tracking (avoids unnecessary re-renders)

**Key Functions**:

1. **`reloadSessions()`** (lines 695-715)
   - Calls `listActiveSessions()` to discover sessions
   - Filters warmup-only sessions automatically
   - Sorts by `lastUpdated` (most recent first)
   - Handles errors gracefully

2. **`handleSessionSelection()`** (lines 192-305)
   - Loads cached reviews for the session
   - Restores previous critique history
   - Performs initial review (or resumes if no new turns)
   - Initializes file watcher
   - Drains any pending signals

3. **`processQueue()`** (lines 501-575)
   - FIFO worker that processes review queue
   - Uses `workerRunningRef` to prevent concurrent execution
   - Calls `performIncrementalReview()` for each job
   - Handles errors without stopping the queue
   - Cleans up signal files after processing

4. **`processSignalFile()`** (lines 610-655)
   - Reads signal file from `.sage/runtime/needs-review/`
   - Extracts new turns since last reviewed signature
   - Enqueues job if new turns exist
   - Deduplicates signals using `processedSignalsRef`

5. **`handleChatSubmit()`** (lines 338-389)
   - Handles user questions to Sage
   - Calls `chatWithSage()` with Codex thread
   - Adds messages to chat history
   - Prevents duplicate submissions with `isWaitingForChat`

**Screen State Machine**:

```typescript
type Screen = 'loading' | 'error' | 'session-list' | 'running' | 'chat';
```

- `loading`: Initial session discovery
- `error`: Error state (can retry with 'R')
- `session-list`: Session picker (arrow keys + Enter)
- `running`: Continuous review mode (watching for signals)
- `chat`: Chat mode with Sage (press 'C' in running mode)

**Keyboard Controls**:

- **Session List**: ↑/↓ navigate, Enter select, R refresh
- **Running Mode**: Ctrl+O stream overlay, M manual sync, B back to list, C chat
- **Chat**: ESC exit, Enter send

**Performance Considerations**:

- Queue processing uses refs to avoid re-renders during processing
- Signal deduplication prevents processing same file twice
- Debounced status messages prevent UI flicker
- WHY section hidden for Approved verdicts reduces terminal noise

### `src/lib/jsonl.ts` - JSONL Transcript Parser

**Purpose**: Parses Claude Code's JSONL log files to extract user-Claude conversation turns.

**Key Challenges**:
- JSONL format (one JSON object per line)
- Filtering sidechain/internal entries
- Matching user prompts to assistant responses
- Handling resume sessions (same UUIDs reused)
- Detecting warmup-only sessions

**Core Function: `extractTurns()`** (lines 86-188)

**Algorithm**:

```
1. Stream JSONL file line-by-line
2. Parse each line as JSON
3. Filter entries:
   - Skip if isSidechain === true
   - Skip if isCompactSummary === true
   - Skip if isMeta === true
4. Build two collections:
   - primaryUserPrompts: [{ uuid, text }]
   - assistantEntries: [{ uuid, parentUuid, message }]
5. For each assistant entry:
   - Resolve root user UUID (traverse parentUuid chain)
   - Group responses by root user UUID
6. Build TurnSummary[]:
   - Pair each user prompt with its responses
   - Format assistant messages (text + tool_use)
   - Track UUIDs for signature matching
7. If sinceUuid provided:
   - Filter to only turns after that UUID
```

**Helper Functions**:

1. **`isPrimaryUserPrompt()`** (lines 190-196)
   - Validates entry is a primary user prompt
   - Checks: `type === 'user'`, `message.role === 'user'`
   - Requires `thinkingMetadata` (indicates primary chain)
   - Excludes empty text

2. **`resolveRootUserUuid()`** (lines 203-227)
   - Traverses `parentUuid` chain upward
   - Finds root user prompt UUID
   - Prevents infinite loops with visited set
   - Returns `null` if no root found

3. **`formatAssistantMessage()`** (lines 229-255)
   - Formats Claude's response message
   - Handles string, object, or array content
   - Includes tool_use entries (except Read/Task)
   - Joins text chunks with double newlines

4. **`isWarmupSession()`** (lines 274-299)
   - Checks if session's only primary prompt is "Warmup"
   - Used to filter warmup-only sessions from picker
   - Returns `true` if first primary prompt is "Warmup" (case-insensitive)

**Edge Cases Handled**:

- Invalid JSON lines (warns and skips)
- Missing UUIDs (skips entry)
- Circular parent chains (returns null)
- Empty messages (skips)
- Missing files (returns empty turns)

**Performance**:

- Streams file (doesn't load entire file into memory)
- Uses `readline` interface for efficient line-by-line reading
- Single pass through file
- Early exit for warmup detection

### `src/lib/codex.ts` - Codex SDK Integration

**Purpose**: Wraps OpenAI Codex SDK, builds prompts, and structures output.

**Key Components**:

1. **Singleton Codex Instance** (lines 43-46)

```typescript
const singleton = new Codex();
export const codexInstance = singleton;
```

**Why Singleton?**: Codex SDK manages connections internally. One instance is sufficient and more efficient.

2. **JSON Schema for Structured Output** (lines 13-27)

```typescript
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['Approved', 'Concerns', 'Critical Issues'] },
    why: { type: 'string' },
    alternatives: { type: 'string' },
    questions: { type: 'string' },
    message_for_agent: { type: 'string' },
  },
  required: ['verdict', 'why', 'alternatives', 'questions', 'message_for_agent'],
  additionalProperties: false,
};
```

**Purpose**: Ensures Codex returns structured JSON matching our `CritiqueResponse` interface. All fields must be in `required` array (OpenAI constraint).

3. **Initial Review Prompt Builder** (`buildInitialPromptPayload()`, lines 104-180)

**Prompt Structure**:

```
# Role
You are Sage, an AI code reviewer...

# Audience
You are speaking directly to the DEVELOPER...
- Use "you/your" for developer
- Use "Claude" or "it" for the AI assistant

# CRITICAL CONSTRAINTS
Your role is OBSERVATION AND ANALYSIS ONLY...
NEVER modify, write, or delete any files

# Task
1. Explore the codebase
2. Review the conversation
3. Critique the latest Claude turn
4. Verify alignment

# Conversation Transcript Details
[Explains sidechain filtering]

# Output Format
[Structured critique card format]

# message_for_agent Guidelines
[When to use message_for_agent field]

# Guidelines
[Focus areas and style]

Session ID: {sessionId}
Latest Claude turn:
{latestTurnSummary}

Full conversation transcript follows between <conversation> tags.
<conversation>
{formattedTurns}
</conversation>
```

**Key Prompt Design Decisions**:

- **Audience Clarity**: Explicitly states who Sage is addressing (developer vs. Claude)
- **Read-Only Enforcement**: Repeated emphasis on never modifying files
- **Sidechain Explanation**: Tells Codex not to flag missing tool calls (they're filtered)
- **Latest Turn Focus**: Emphasizes critiquing only the most recent response
- **Structured Output**: Clear JSON schema requirements

4. **Followup Review Prompt Builder** (`buildFollowupPromptPayload()`, lines 182-257)

**Differences from Initial**:

- Reminds Codex it already explored the codebase
- Focuses on new turns only
- Shorter context (doesn't repeat full conversation)
- References prior context when needed

5. **Review Execution** (`runInitialReview()`, `runFollowupReview()`)

```typescript
export async function runInitialReview(
  context: InitialReviewContext,
  thread?: Thread,
): Promise<{ thread: Thread; critique: CritiqueResponse; promptPayload: PromptPayload }> {
  const reviewThread = thread ?? singleton.startThread(getConfiguredThreadOptions());
  const payload = buildInitialPromptPayload(context);
  const result = await reviewThread.run(payload.prompt, { outputSchema: CRITIQUE_SCHEMA });
  
  const critique = typeof result.finalResponse === 'object'
    ? result.finalResponse as CritiqueResponse
    : JSON.parse(result.finalResponse as string) as CritiqueResponse;
  
  return { thread: reviewThread, critique, promptPayload: payload };
}
```

**Process**:
1. Get or create Codex thread
2. Build prompt payload
3. Call `thread.run()` with JSON schema
4. Parse structured response
5. Return thread, critique, and payload

**Error Handling**: Assumes Codex SDK throws errors that propagate up. No try/catch here (handled in `review.ts`).

### `src/lib/review.ts` - Review Orchestration

**Purpose**: Coordinates initial and incremental reviews, manages thread lifecycle, handles caching.

**Key Functions**:

1. **`performInitialReview()`** (lines 32-170)

**Flow**:

```
1. Extract turns from JSONL
2. Build initial prompt payload
3. Write artifact to `.debug/` (always)
4. Load thread metadata
5. Get or create Codex thread
6. Check if thread resumed:
   a. If resumed && no new turns:
      → Return cached critique (isFreshCritique: false)
   b. If resumed && new turns:
      → Review only new turns
   c. If new thread:
      → Full initial review
7. Save thread metadata
8. Return ReviewResult
```

**Resume Detection Logic** (lines 94-152):

```typescript
const metadata = await loadThreadMetadata(sessionId);
const thread = await getOrCreateThread(codexInstance, sessionId, onProgress);

const isResumedThread = metadata !== null;
const currentTurnCount = turns.length;
const lastReviewedTurnCount = metadata?.lastReviewedTurnCount ?? 0;
const hasNewTurns = currentTurnCount > lastReviewedTurnCount;

if (isResumedThread && !hasNewTurns) {
  // No new work → resume without new critique
  critique = { verdict: 'Approved', why: 'Session previously reviewed...', ... };
  isFreshCritique = false;
} else if (isResumedThread && hasNewTurns) {
  // New turns → review incrementally
  const newTurns = turns.slice(lastReviewedTurnCount);
  critique = await runFollowupReview(thread, { sessionId, newTurns });
  await updateThreadTurnCount(sessionId, currentTurnCount);
} else {
  // New thread → full review
  critique = await runInitialReview({ sessionId, turns, latestTurnSummary }, thread);
  await saveThreadMetadata(sessionId, threadId, currentTurnCount);
}
```

**Why This Matters**: Prevents duplicate reviews when re-selecting a session with no new turns.

2. **`performIncrementalReview()`** (lines 180-253)

**Flow**:

```
1. Validate turns exist
2. Build followup prompt payload
3. Write artifact to `.debug/` (always)
4. Validate thread exists
5. Call runFollowupReview()
6. Return ReviewResult
```

**Timeout Handling**: Both initial and incremental reviews have 5-minute timeouts (lines 116-117, 234-236).

3. **`clarifyReview()`** (lines 261-328)

**Purpose**: Allows users to ask Sage questions about its critiques.

**Prompt Design**:

- Emphasizes **EXPLANATION ONLY**
- Explicitly forbids suggesting implementations or fixes
- Tells Codex to reference files already read
- Reminds Codex it's a reviewer, not an implementer

**Key Constraint**: "If they ask you to suggest fixes or write code, politely remind them: 'That's outside my scope as a reviewer.'"

**Why?**: Sage is read-only and should focus on helping the developer understand the codebase and critique.

### `src/lib/threads.ts` - Thread Persistence

**Purpose**: Manages Codex thread lifecycle and persistence across Sage restarts.

**Key Functions**:

1. **`saveThreadMetadata()`** (lines 31-48)

```typescript
export async function saveThreadMetadata(
  sessionId: string,
  threadId: string,
  turnCount: number = 0,
): Promise<void> {
  await ensureThreadsDir();
  
  const metadata: ThreadMetadata = {
    threadId,
    sessionId,
    timestamp: Date.now(),
    lastUsed: Date.now(),
    lastReviewedTurnCount: turnCount,
  };
  
  const filePath = path.join(THREADS_DIR, `${sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf8');
}
```

**Storage**: `~/.sage/{project-path}/threads/{sessionId}.json`

2. **`loadThreadMetadata()`** (lines 67-83)

- Reads metadata file
- Updates `lastUsed` timestamp on access
- Returns `null` if file doesn't exist or is corrupted

3. **`getOrCreateThread()`** (lines 103-132)

**Flow**:

```
1. Try to load metadata
2. If metadata exists:
   a. Try to resume thread via codex.resumeThread()
   b. If resume fails:
      → Delete metadata (thread deleted on Codex side)
      → Fall through to create new
3. Create new thread via codex.startThread()
4. Save metadata if thread.id available
5. Return thread
```

**Resume Benefits**:
- Preserves Codex's context (files read, reasoning)
- Faster incremental reviews (doesn't re-read codebase)
- Maintains conversation continuity

**Error Handling**: If resume fails (thread deleted externally), silently creates new thread.

### `src/lib/reviewsCache.ts` - Critique History Persistence

**Purpose**: Stores critique history so Sage can restore previous critiques when re-selecting sessions.

**Storage**: `~/.sage/{project-path}/reviews/{sessionId}.json`

**Key Functions**:

1. **`loadReviewCache()`** (lines 40-54)

- Reads cache file
- Normalizes data (validates structure)
- Sorts reviews by `completedAt` timestamp
- Returns `null` if file doesn't exist

2. **`appendReviewToCache()`** (lines 77-93)

- Appends new review to cache
- Deduplicates by `turnSignature` (replaces if exists)
- Updates `lastTurnSignature`
- Enforces `MAX_REVIEWS_PER_SESSION` (500) limit

**Why Deduplicate?**: Same turn might be reviewed multiple times (edge case during race conditions).

3. **`normalizeCache()`** (lines 99-140)

**Purpose**: Validates and sanitizes cache data structure.

**Validations**:
- Ensures `reviews` is an array
- Validates each review has required fields (`turnSignature`, `completedAt`, `critique`)
- Sorts by timestamp
- Computes `lastTurnSignature` from reviews if missing

**Safety**: Prevents crashes from corrupted cache files.

### `src/lib/debug.ts` - Artifact Generation

**Purpose**: Artifact generation utilities for inspecting Codex prompts.

**Artifact Generation** (`writeDebugReviewArtifact()`):

**Always Created** (for all reviews):

```
.debug/review-{sanitized-prompt-label}.txt
```

**File Format**:

```
================================================================================
CODEX PROMPT DEBUG ARTIFACT
================================================================================
Session: {sessionId}
Review Type: {Initial Review | Incremental Review}

================================================================================
INSTRUCTIONS
================================================================================

{promptText}

================================================================================
CONTEXT (Conversation Turns)
================================================================================

{contextText}
```

**Purpose**: Allows inspection of exactly what was sent to Codex during reviews. Useful for debugging and understanding how Sage formulates critiques.

**Filename Sanitization** (`sanitizeFilename()`):

- Replaces spaces with hyphens
- Removes non-alphanumeric characters (except `-`, `_`, `.`)
- Collapses multiple hyphens
- Truncates to 60 characters
- Deduplicates with numeric suffix (`-1`, `-2`, etc.)

### `src/hooks/sageHook.ts` - Claude Code Hook Shim

**Purpose**: Receives hook events from Claude Code and writes metadata/signals for Sage.

**Hook Events Handled**:

- `SessionStart`: Creates session metadata file
- `Stop`: Updates metadata, creates review signal
- `UserPromptSubmit`: Updates last prompt in metadata

**Note**: SessionEnd hook was removed due to unreliability. Metadata files accumulate over time but are harmless.

**Input**: JSON payload via stdin

**Payload Structure**:

```typescript
interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}
```

**Output**:

1. **Session Metadata** (`~/.sage/{project-path}/runtime/sessions/{sessionId}.json`):

```json
{
  "sessionId": "...",
  "transcriptPath": "...",
  "cwd": "...",
  "lastPrompt": "...",
  "lastStopTime": 1234567890,
  "lastUpdated": 1234567890
}
```

2. **Review Signal** (`~/.sage/{project-path}/runtime/needs-review/{sessionId}-{timestamp}-{random}.json`):

```json
{
  "sessionId": "...",
  "transcriptPath": "...",
  "queuedAt": 1234567890
}
```

**Key Functions**:

1. **`handlePayload()`** (lines 68-160)

**Flow**:

```
1. Parse JSON from stdin
2. Validate required fields (session_id, transcript_path, hook_event_name)
3. Ensure runtime directories exist
4. Load existing session metadata (if exists)
5. Update metadata:
   - sessionId, transcriptPath
   - cwd (if provided)
   - lastUpdated
   - lastPrompt (if UserPromptSubmit)
   - lastStopTime (if Stop)
7. Write metadata atomically
8. If Stop event:
   → Create review signal file
```

**Atomic Writes** (`writeFileAtomic()`, lines 42-47):

```typescript
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.promises.writeFile(tempPath, contents, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}
```

**Why Atomic?**: Prevents Sage from reading partial files if hook is interrupted.

**Error Handling** (`appendError()`, lines 59-66):

- Writes errors to `~/.sage/{project-path}/runtime/hook-errors.log`
- Best-effort (doesn't throw if logging fails)
- Includes timestamps

**Project Root Detection** (lines 13-15):

```typescript
const projectRoot = process.env.CLAUDE_PROJECT_DIR
  ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
  : process.cwd();
```

**Why?**: Claude Code sets `CLAUDE_PROJECT_DIR` to the project root, not the Sage repo root.

### `src/scripts/configureHooks.ts` - Hook Auto-Configuration

**Purpose**: Automatically configures Sage hooks on startup. Also available as CLI script.

**Automatic**: Called during App initialization (`App.tsx` useEffect)

**Manual Command**: `npm run configure-hooks`

**Target File**: `.claude/settings.local.json` (in the project directory)

**Hook Configuration**:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/sage/dist/hooks/sageHook.js\"",
        "timeout": 30
      }]
    }],
    "Stop": [...],
    "UserPromptSubmit": [...]
  }
}
```

**Key Design Decisions**:

1. **Absolute Path**: Uses absolute path to Sage's compiled hook script (`dist/hooks/sageHook.js`), computed at runtime from `import.meta.url`. This ensures hooks work regardless of where Sage is installed (local dev, npm global, etc.).

2. **Compiled JS**: Points to `dist/hooks/sageHook.js` (not `src/`), so it works with npm packages (which only include `dist/`).

3. **Node instead of tsx**: Uses `node` directly for faster hook execution (no TypeScript compilation overhead).

**Exported Function**:

```typescript
export interface HookConfigResult {
  configured: boolean;
  alreadyConfigured: boolean;
}

export async function ensureHooksConfigured(): Promise<HookConfigResult>
```

**Algorithm** (`ensureHooksConfigured()`):

```
1. Compute SAGE_ROOT from import.meta.url (works for both dev and npm install)
2. Read existing settings.local.json (or create empty object)
3. Ensure hooks object exists
4. For each target event:
   a. Get existing hooks array (or empty array)
   b. Find any existing Sage hook (by checking for "sageHook.ts" in command)
   c. If not present:
      → Append Sage hook entry
      → Set anyAdded = true
   d. If present but wrong path:
      → Update to correct path
      → Set anyAdded = true
5. Write updated settings file
6. Return { configured: true, alreadyConfigured: !anyAdded }
```

**Features**:

- **Auto-update**: If an old/broken Sage hook exists, updates it to the correct path
- **Deduplication**: Detects existing Sage hooks by looking for "sageHook" in command
- **Non-destructive**: Preserves other hooks configured by the user
- **Graceful errors**: Failures are caught in App.tsx and shown as warnings (non-blocking)

### `src/ui/CritiqueCard.tsx` - Critique Renderer

**Purpose**: Renders structured critique cards in the terminal UI.

**Props**:

```typescript
interface CritiqueCardProps {
  critique: CritiqueResponse;
  prompt?: string;
  index: number;
}
```

**Visual Design**:

- **Verdict**: Symbol + color-coded text
  - `✓` Approved (green)
  - `⚠` Concerns (yellow)
  - `✗` Critical Issues (red)

- **Sections**:
  - WHY (only shown for non-Approved verdicts)
  - ALTERNATIVES (blue, only if non-empty)
  - QUESTIONS (magenta, only if non-empty)
  - MESSAGE FOR AGENT (cyan, only if non-empty)

**Terminal Width Handling** (lines 32-34):

```typescript
const { stdout } = useStdout();
const terminalWidth = (stdout?.columns ?? 80) - 2;
```

**Why?**: Accounts for App container padding to draw separator lines correctly.

**Truncation** (`truncatePrompt()`, lines 83-87):

- Cleans whitespace
- Truncates to 60 chars by default
- Adds ellipsis

### `src/ui/ChatCard.tsx` - Chat Message Renderer

**Purpose**: Renders user questions and Sage responses in chat mode.

**Visual Design**:

- User messages: `> {content}`
- Sage messages: `● {content}`

**Simple Component**: Just displays role and content, no complex logic.

### `src/ui/StreamOverlay.tsx` - Codex Activity Stream Viewer

**Purpose**: Full-screen overlay that surfaces streamed Codex events for the current review. Toggled with `Ctrl+O` while in continuous mode.

**Highlights**:

- Displays timestamped events with color-coded tags for assistant messages, reasoning traces, command executions, file changes, todos, and errors.
- Updates live during a review and keeps the most recent stream log available after completion.
- Shows the active session/prompt context plus instructions for exiting (`Ctrl+O` again).

### `src/ui/Spinner.tsx` - Loading Spinner

**Purpose**: Animated spinner for loading states.

**Implementation**:

```typescript
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

useEffect(() => {
  const timer = setInterval(() => {
    setFrame((prevFrame) => (prevFrame + 1) % SPINNER_FRAMES.length);
  }, 80);
  return () => clearInterval(timer);
}, []);
```

**Animation**: 10-frame cycle, 80ms per frame = 800ms full cycle.

---

## Key Algorithms & Logic

### Turn Extraction Algorithm (`extractTurns()`)

**Problem**: Claude's JSONL logs contain:
- Primary user prompts
- Assistant responses
- Sidechain/internal entries (filtered)
- Tool calls (some included, some filtered)
- Resume sessions (UUIDs reused)

**Solution**: Two-pass algorithm:

**Pass 1: Collection**

```typescript
const primaryUserPrompts: Array<{ uuid: string; text: string }> = [];
const assistantEntries: Array<{ uuid: string; parentUuid: string | null; message: any }> = [];
const entriesByUuid = new Map<string, any>();

// Stream JSONL file
for await (const line of rl) {
  const entry = JSON.parse(line);
  
  // Skip sidechains
  if (entry?.isSidechain) continue;
  
  // Store for UUID resolution
  if (entry?.uuid) {
    entriesByUuid.set(entry.uuid, entry);
  }
  
  // Collect primary user prompts
  if (entry?.type === 'user' && isPrimaryUserPrompt(entry)) {
    primaryUserPrompts.push({ uuid: entry.uuid, text: extractText(entry.message) });
  }
  
  // Collect assistant responses
  if (entry?.type === 'assistant') {
    assistantEntries.push({
      uuid: entry.uuid ?? entry.parentUuid,
      parentUuid: entry.parentUuid,
      message: entry.message,
    });
  }
}
```

**Pass 2: Matching**

```typescript
const responsesByUser = new Map<string, Array<{ uuid: string; message: any }>>();

// Group assistant responses by root user UUID
for (const entry of assistantEntries) {
  const rootUuid = resolveRootUserUuid(entry.parentUuid, entriesByUuid, primaryUserSet);
  if (!rootUuid) continue;
  
  if (!responsesByUser.has(rootUuid)) {
    responsesByUser.set(rootUuid, []);
  }
  responsesByUser.get(rootUuid)!.push({ uuid: entry.uuid, message: entry.message });
}

// Build turn pairs
for (const userEntry of primaryUserPrompts) {
  const responses = responsesByUser.get(userEntry.uuid) ?? [];
  const agentText = formatAssistantMessage(responses);
  
  turns.push({
    user: userEntry.text,
    agent: agentText,
    userUuid: userEntry.uuid,
    assistantUuid: responses[responses.length - 1]?.uuid,
  });
}
```

**Complexity**: O(n) where n = number of JSONL lines. Single pass through file.

### Root UUID Resolution (`resolveRootUserUuid()`)

**Problem**: Assistant responses have `parentUuid` pointing to their immediate parent, but we need the root user prompt UUID (which may be several levels up).

**Solution**: Traverse parent chain upward:

```typescript
function resolveRootUserUuid(
  parentUuid: string | null,
  entriesByUuid: Map<string, any>,
  primaryUserSet: Set<string>,
): string | null {
  let current = parentUuid ?? null;
  const visited = new Set<string>(); // Prevent infinite loops
  
  while (current) {
    if (visited.has(current)) {
      return null; // Circular reference
    }
    visited.add(current);
    
    if (primaryUserSet.has(current)) {
      return current; // Found root user prompt
    }
    
    const parentEntry = entriesByUuid.get(current);
    if (!parentEntry) {
      return null; // Chain broken
    }
    
    current = parentEntry.parentUuid ?? null;
  }
  
  return null; // No root found
}
```

**Complexity**: O(d) where d = depth of parent chain (typically < 10).

### Queue Processing Algorithm (`processQueue()`)

**Problem**: Multiple review signals may arrive while Sage is processing. Need FIFO ordering without race conditions.

**Solution**: Single worker with ref-based queue:

```typescript
const workerRunningRef = useRef(false);
const queueRef = useRef<ReviewQueueItem[]>([]);

async function processQueue(): Promise<void> {
  if (workerRunningRef.current) return; // Already processing
  if (!activeSession) return;
  if (queueRef.current.length === 0) return;
  
  workerRunningRef.current = true;
  
  while (queueRef.current.length > 0 && activeSession) {
    const job = queueRef.current[0];
    setCurrentJob(job); // Update UI
    
    try {
      const result = await performIncrementalReview(...);
      appendReview(result);
      await fs.unlink(job.signalPath); // Cleanup
    } catch (err) {
      // Log error, continue to next job
    }
    
    queueRef.current = queueRef.current.slice(1);
    setQueue(queueRef.current); // Sync to state
  }
  
  workerRunningRef.current = false;
}
```

**Why Refs?**: `queueRef` can be updated without triggering re-renders during processing. State (`queue`) is synced only when needed for UI.

**Deduplication**: `processedSignalsRef` tracks processed signal files to prevent duplicates.

### Resume Detection Algorithm

**Problem**: When re-selecting a session, Sage should:
- Skip reviews for already-reviewed turns
- Review only new turns
- Avoid duplicate critiques

**Solution**: Turn count comparison:

```typescript
const metadata = await loadThreadMetadata(sessionId);
const { turns } = await extractTurns({ transcriptPath });

const currentTurnCount = turns.length;
const lastReviewedTurnCount = metadata?.lastReviewedTurnCount ?? 0;
const hasNewTurns = currentTurnCount > lastReviewedTurnCount;

if (metadata && !hasNewTurns) {
  // No new turns → resume without new critique
  return { critique: cachedCritique, isFreshCritique: false };
} else if (metadata && hasNewTurns) {
  // New turns → review incrementally
  const newTurns = turns.slice(lastReviewedTurnCount);
  return await runFollowupReview(thread, { sessionId, newTurns });
} else {
  // New thread → full review
  return await runInitialReview({ sessionId, turns }, thread);
}
```

**Why Turn Count?**: More reliable than UUID matching for resume detection (UUIDs may be reused in resumed sessions).

**Edge Case**: If turn count decreases (session truncated), treats as new session.

---

## State Management

### React State vs. Refs

**State** (triggers re-renders):
- `screen`: Current screen mode
- `sessions`: List of available sessions
- `reviews`: Completed critique cards
- `queue`: Review queue (synced from ref)
- `currentJob`: Currently processing job

**Refs** (no re-renders):
- `queueRef`: Queue state during processing
- `workerRunningRef`: Worker lock flag
- `watcherRef`: File watcher instance
- `codexThreadRef`: Codex thread (persisted across renders)
- `lastTurnSignatureRef`: Last reviewed turn UUID
- `processedSignalsRef`: Set of processed signal files

**Why This Split?**: 
- State updates trigger React re-renders (expensive)
- Refs allow mutating values without re-renders
- Queue processing updates frequently; UI only needs updates at key moments

### State Synchronization

**Queue Sync Pattern**:

```typescript
// Enqueue (updates both ref and state)
function enqueueJob(job: ReviewQueueItem) {
  queueRef.current = [...queueRef.current, job];
  setQueue(queueRef.current); // Sync to state
}

// Process (updates ref, syncs state at end)
async function processQueue() {
  while (queueRef.current.length > 0) {
    // ... process job ...
    queueRef.current = queueRef.current.slice(1);
  }
  setQueue(queueRef.current); // Sync to state
}
```

**Why?**: Ref allows fast mutations during processing; state sync ensures UI updates.

### Cache State Management

**Review Cache** (`reviewCacheRef`):

- Loaded on session selection
- Updated after each review
- Persisted to disk after each review
- Used to restore critiques on re-selection

**Thread Metadata**:

- Loaded before review
- Saved after successful review
- Updated with turn count after incremental review
- Deleted if resume fails

---

## Error Handling Patterns

### Graceful Degradation

**Session Discovery** (`listActiveSessions()`):

```typescript
try {
  entries.push(...fs.readdirSync(SESSIONS_DIR));
} catch (error: any) {
  if (error?.code === 'ENOENT') {
    return []; // Directory doesn't exist yet
  }
  throw error; // Real error
}
```

**Signal Processing** (`processSignalFile()`):

```typescript
try {
  // ... process signal ...
} catch (error) {
  const message = error instanceof Error ? error.message : 'Failed to process review signal.';
  setStatusMessages((prev) => [...prev, message]);
} finally {
  if (!enqueued) {
    processedSignalsRef.current.delete(filePath);
  }
}
```

**Pattern**: Catch errors, log to UI, continue processing.

### Timeout Handling

**Review Timeouts** (`review.ts`):

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error('Codex review timed out after 10 minutes')), 5 * 60 * 1000);
});

const reviewPromise = runInitialReview(...);
const result = await Promise.race([reviewPromise, timeoutPromise]);
```

**Timeouts**:
- Initial review: 5 minutes
- Incremental review: 5 minutes
- Chat: 2 minutes

**Why?**: Codex reviews can hang; timeouts prevent indefinite blocking.

### Atomic File Operations

**Pattern**: Write to temp file, then rename (atomic on Unix):

```typescript
async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.promises.writeFile(tempPath, contents, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}
```

**Used In**:
- `sageHook.ts`: Session metadata writes
- `reviewsCache.ts`: Cache file writes
- `threads.ts`: Thread metadata writes

**Why?**: Prevents Sage from reading partial/corrupted files.

### Validation & Normalization

**Cache Normalization** (`normalizeCache()`):

```typescript
function normalizeCache(raw: Partial<SessionReviewCache> | null, sessionId: string): SessionReviewCache | null {
  if (!raw || typeof raw !== 'object') return null;
  
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  const sanitized: StoredReview[] = [];
  
  for (const entry of reviews) {
    // Validate required fields
    if (!entry?.turnSignature || typeof entry.turnSignature !== 'string') continue;
    if (!entry?.completedAt || typeof entry.completedAt !== 'string') continue;
    if (!entry?.critique || typeof entry.critique !== 'object') continue;
    
    sanitized.push({
      turnSignature: entry.turnSignature,
      completedAt: entry.completedAt,
      critique: entry.critique,
      latestPrompt: entry.latestPrompt ?? null,
      artifactPath: entry.artifactPath,
      promptText: entry.promptText,
    });
  }
  
  // Sort by timestamp
  sanitized.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  
  return { sessionId, lastTurnSignature: ..., reviews: sanitized };
}
```

**Purpose**: Validates cache structure, prevents crashes from corrupted files.

---

## Integration Points

### Claude Code Integration

**Hook Registration** (`configureHooks.ts`):

- Writes to `.claude/settings.local.json`
- Command: `node "/absolute/path/to/sage/dist/hooks/sageHook.js"`
- Events: `SessionStart`, `Stop`, `UserPromptSubmit`
- **Auto-configured**: Runs automatically on Sage startup (no manual setup needed)

**Hook Execution** (`sageHook.ts`):

- Receives JSON payload via stdin
- Writes metadata to `.sage/runtime/sessions/`
- Writes signals to `.sage/runtime/needs-review/`

**Transcript Access**:

- Reads Claude's JSONL log files (path from hook payload)
- Location: Provided by Claude Code via `transcript_path`

### Codex SDK Integration

**Thread Lifecycle**:

```typescript
// Create thread
const thread = codex.startThread({ model: 'gpt-4.1-nano' });

// Resume thread
const thread = codex.resumeThread(threadId, { model: 'gpt-4.1-nano' });

// Run review
const result = await thread.run(prompt, { outputSchema: CRITIQUE_SCHEMA });
```

**Structured Output**:

- Uses JSON schema to enforce response format
- Codex returns structured object matching `CritiqueResponse`
- Parsed automatically by SDK

**Read-Only Enforcement**:

- Enforced via prompt instructions (repeated emphasis)
- Codex SDK may support permission settings (future enhancement)

### File System Integration

**Runtime Directories**:

Each project gets its own directory under `~/.sage/` based on its full path (e.g., `/Users/you/projects/foo` → `~/.sage/Users-you-projects-foo/`):

- `~/.sage/{project-path}/runtime/sessions/`: Session metadata
- `~/.sage/{project-path}/runtime/needs-review/`: Review signals
- `~/.sage/{project-path}/threads/`: Thread metadata
- `~/.sage/{project-path}/reviews/`: Review cache
- `.debug/`: Debug artifacts (local to project)

**All Created Automatically**: No manual setup required.

**Git Ignore**: `.debug/` should be in `.gitignore` (`.sage/` is now global, not in project)

---

## Testing Strategy

### Test Files

**`src/lib/codex.test.ts`**:

- Tests prompt builders (`buildInitialPromptPayload`, `buildFollowupPromptPayload`)
- Validates prompt structure
- Checks turn formatting

**`src/lib/jsonl.test.ts`** (likely exists):

- Tests turn extraction
- Validates sidechain filtering
- Tests warmup detection

### Test Execution

**Run Tests**:

```bash
# Individual test files use Node assert
tsx src/lib/codex.test.ts
```

**No Test Framework**: Tests use Node's built-in `assert` module.

---

## Code Patterns & Conventions

### TypeScript Conventions

**Strict Mode**: Enabled in `tsconfig.json`

**Module System**: ES modules (`"module": "Node16"`)

**Import Patterns**:

```typescript
// Always use .js extension for imports (TypeScript requirement)
import App from './ui/App.js';
```

**Type Definitions**:

- Interfaces for object shapes
- `type` aliases for unions/enums
- `as const` for literal types

### Async/Await Patterns

**Consistent Usage**: All async functions use `async/await` (no raw promises)

**Error Propagation**: Errors bubble up to UI layer (caught in `App.tsx`)

**Timeout Pattern**:

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error('Timeout')), duration);
});
const result = await Promise.race([actualPromise, timeoutPromise]);
```

### File I/O Patterns

**Streaming for Large Files**:

```typescript
const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
for await (const line of rl) {
  // Process line
}
```

**Atomic Writes**:

```typescript
const tempPath = `${filePath}.tmp`;
await fs.writeFile(tempPath, content);
await fs.rename(tempPath, filePath);
```

### React Patterns

**Functional Components**: All components use function syntax

**Hooks Usage**:
- `useState`: Component state
- `useEffect`: Side effects (file watching, cleanup)
- `useRef`: Values that don't trigger re-renders
- `useInput`: Keyboard input handling (Ink)

**Effect Cleanup**:

```typescript
useEffect(() => {
  const watcher = chokidar.watch(...);
  return () => {
    watcher.close();
  };
}, []);
```

### Error Message Patterns

**User-Facing**:

```typescript
const message = err instanceof Error ? err.message : 'Default message';
setError(message);
```

**Logging**:

```typescript
console.warn(`[Sage] Failed to ...: ${error?.message ?? error}`);
```

**Hook Errors**:

```typescript
await appendError(`Hook error: ${error instanceof Error ? error.message : String(error)}`);
```

---

## Future Considerations

### Known Limitations

1. **Single-Instance Assumption**: Multiple Sage processes can race on cache/thread files
2. **Incomplete Responses**: Manual selection during Claude typing may review partial responses
3. **Resume Chains**: Doesn't follow resumed session chains back to parent
4. **No Arrow Navigation**: Can't navigate critique history with keyboard

### Potential Enhancements

1. **Multi-Instance Support**: File locking or database for shared state
2. **Streaming Reviews**: Review as Claude types (partial critiques)
3. **Rich Followups**: More interactive chat mode with history navigation
4. **Review Filtering**: Filter critiques by verdict, date, etc.
5. **Export Critiques**: Save critiques to markdown/files
6. **Thread Sharing**: Share Codex threads across sessions (if same codebase)

### Architecture Evolution

**Current**: Centralized state in `App.tsx`

**Future**: Consider:
- State management library (Zustand, Redux)
- Separate queue worker process
- WebSocket for real-time updates
- Plugin system for custom review types

---

## Conclusion

Sage is a well-architected code reviewer that integrates seamlessly into the Claude Code workflow. Key strengths:

- **Read-only design**: Never modifies files
- **Persistent state**: Threads and reviews survive restarts
- **Graceful error handling**: Continues operating despite failures
- **Clean separation**: UI, business logic, and integrations are separated
- **Extensible**: Easy to add new features (chat mode, caching, etc.)

The codebase demonstrates:
- Strong TypeScript usage
- React best practices
- Efficient file I/O (streaming, atomic writes)
- Robust error handling
- Clear code organization

Happy reading! 🎩

---

*This guide was generated for comprehensive codebase understanding. For specific implementation questions, refer to the inline code comments and type definitions.*
