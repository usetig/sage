# Claude Code JSONL Format: Comprehensive Research & Documentation

## Executive Summary

This document provides a deep dive into Claude Code's native JSONL conversation log format based on:
- Actual log file analysis from `~/.claude/projects/`
- Existing documentation in the Sage repository
- Current Sage codebase examination (SpecStory markdown parsing)
- Real-world examples from 160+ session files

**Key Finding:** Sage can potentially eliminate its dependency on SpecStory by parsing JSONL logs directly, gaining:
- Real-time access without external CLI tool
- Optional access to sidechain/agent data (stored in separate `agent-*.jsonl` files as of 2.0.24+)
- Simpler architecture (no markdown parsing)
- Direct tool call visibility

**Important:** As of Claude Code 2.0.24+, agent/sidechain work is stored in separate files named `agent-<agentId>.jsonl`. **This document focuses on the modern format only.** Legacy sessions (pre-2.0.24) are not supported.

---

## 1. JSONL Storage & File Structure

### 1.1 Location & File Types

**As of Claude Code 2.0.24+**, conversation logs are split across two file types:

```
~/.claude/projects/<project-slug>/
├── <session-id>.jsonl           # Main conversation (isSidechain: false)
└── agent-<agent-id>.jsonl       # Agent/sidechain work (isSidechain: true)
```

- **`<project-slug>`**: Encoded path (e.g., `-Users-henryquillin-Desktop-Repos-sage`)
- **`<session-id>`**: UUID filename (e.g., `ba93ece4-80ee-4f87-9b23-214d9e786827.jsonl`)
- **`<agent-id>`**: Short hash (e.g., `agent-6cce90d0.jsonl`)
- Files are **append-only JSON Lines** (one JSON object per line)

**Version Support:**
- **2.0.24+** (confirmed 2.0.28): Sidechains stored in separate `agent-*.jsonl` files ← **Supported**
- **2.0.13 and earlier**: All events in single file ← **Not supported by Sage**

### 1.2 Main Session Files

**Purpose:** Records the primary user↔Claude conversation visible in the UI

**Characteristics:**
- All events have `isSidechain: false` (or omitted in older versions)
- Contains user prompts, Claude responses, summaries, file snapshots
- File sizes: 0 bytes (empty warmup) to 2+ MB for long conversations
- Empty files (0 bytes) exist for sessions created but never used

### 1.3 Agent Files (2.0.24+)

**Purpose:** Records delegated agent work (Task tool, Explore agent, etc.)

**Characteristics:**
- Named `agent-<agentId>.jsonl` where agentId is a short hash
- All events have `isSidechain: true` and `agentId` field
- NOT shown in Claude Code UI (internal work)
- Can be quite large (500KB+) for complex agent tasks
- Multiple agent files can exist per main session (one per Task invocation)

**Example:**
```
main session: ba93ece4-80ee-4f87-9b23-214d9e786827.jsonl (335KB, isSidechain: false)
    ├── agent-ffdca2dd.jsonl (318KB, agentId: "ffdca2dd")
    └── agent-059b26c9.jsonl (500KB, agentId: "059b26c9")
```

### 1.4 File Characteristics (General)

- **New sessions on resume**: `claude --resume` creates a NEW file with NEW UUID and **clones the entire prior transcript into that new file** before appending fresh turns. The original file is untouched, so expect duplicated `uuid`/timestamp pairs between the parent and resumed transcripts—parsers must dedupe or sort by timestamp when merging.
- **Agent files are independent**: Each Task/Explore invocation gets its own agent file
- **Discovery strategy**: Glob for `*.jsonl` but exclude `agent-*.jsonl` when listing sessions
- **Version requirement**: Sage requires Claude Code 2.0.24+ (separate agent files)

### 1.5 Compaction Artifacts

Manual (`/compact`) or automatic compaction does **not** rewrite the JSONL file. Instead, Claude appends a small cluster of bookkeeping events to the end of the existing transcript:

- A `user` entry with `isCompactSummary: true` that contains the generated conversation summary. Treat it as metadata; it should not trigger a fresh review.
- One or more `user` entries flagged with `isMeta: true` that record the local command (`<command-name>/compact</command-name>`) and its stdout (`<local-command-stdout>…</local-command-stdout>`). These are emitted so Claude can reference the shell output if needed.
- The usual `SessionStart`/`SessionEnd` hooks may fire with matcher `compact`, so use those to manage any active-session registry.

When streaming new turns, skip `isCompactSummary` and `isMeta` records—they are operational noise and do not represent real user prompts.

---

## 2. Complete Event Type Catalog

### 2.1 Event Types Overview

| Event Type | Purpose | Has UUID | Has Message | Has Timestamp |
|-----------|---------|----------|-------------|---------------|
| `user` | Developer prompt | ✓ | ✓ | ✓ |
| `assistant` | Claude's response | ✓ | ✓ | ✓ |
| `summary` | Session metadata/title | ✗ | ✗ | ✗ |
| `file-history-snapshot` | File tracking state | ✗ | ✗ | ✗ |
| `tool` | Tool invocation (rare) | varies | varies | varies |
| `tool_result` | Tool response (rare) | varies | varies | varies |
| `system` | Lifecycle messages | varies | varies | varies |
| `notification` | Warnings/notices | varies | varies | varies |

**Note:** `tool` and `tool_result` events are uncommon in mainline logs because tool calls are typically embedded within `assistant` message content blocks during streaming.

---

## 3. Detailed Event Schemas

### 3.1 `user` Event

**Purpose:** Records a developer's prompt to Claude

```typescript
{
  type: "user",
  uuid: string,                    // Unique event ID
  parentUuid: string | null,       // Previous event in chain (null for first)
  isSidechain: boolean,            // false = main conversation, true = agent work
  timestamp: string,               // ISO 8601: "2025-10-29T14:49:14.220Z"
  sessionId: string,               // UUID matching filename
  version: string,                 // Claude Code version: "2.0.28"
  cwd: string,                     // Working directory
  gitBranch: string,               // Current git branch
  userType: "external",            // Always "external" for developer prompts
  agentId?: string,                // Present only if isSidechain=true (e.g., "664316d7")
  
  message: {
    role: "user",
    content: string | Array<{      // STRING for simple text, ARRAY for multimodal
      type: "text" | "tool_result",
      text?: string,               // Present for type="text"
      tool_use_id?: string,        // Present for type="tool_result"
      content?: string | any[],    // Present for type="tool_result"
    }>
  },
  
  thinkingMetadata?: {             // Extended thinking controls
    level: "none" | "low" | "medium" | "high",
    disabled: boolean,
    triggers: string[]
  },
  
  toolUseResult?: {                // Present when this user message is responding to agent tool use
    status: "completed" | "error",
    prompt: string,                // Original agent request
    agentId: string,
    content: Array<{type: "text", text: string}>,
    totalDurationMs: number,
    totalTokens: number,
    totalToolUseCount: number,
    usage: {
      input_tokens: number,
      cache_creation_input_tokens: number,
      cache_read_input_tokens: number,
      cache_creation: {
        ephemeral_5m_input_tokens: number,
        ephemeral_1h_input_tokens: number
      },
      output_tokens: number,
      service_tier: "standard"
    }
  }
}
```

**Key Observations:**
- `message.content` can be **string** (simple prompt) or **array** (multimodal/tool results)
- `parentUuid` creates linked list structure through conversation
- `isSidechain=true` events are **agent/tool work** - NOT shown in UI
- `toolUseResult` appears when user message is actually an agent's tool execution result

### 3.2 `assistant` Event

**Purpose:** Records Claude's response

```typescript
{
  type: "assistant",
  uuid: string,
  parentUuid: string,              // Always links back to previous event
  isSidechain: boolean,
  timestamp: string,
  sessionId: string,
  version: string,
  cwd: string,
  gitBranch: string,
  userType: "external",
  requestId: string,               // API request ID: "req_011CUbg6Xud4XihVjLEEqbSr"
  agentId?: string,                // Present if isSidechain=true
  
  message: {
    model: string,                 // "claude-sonnet-4-5-20250929"
    id: string,                    // Message ID: "msg_01PJJFzcFnwXLP2FRXm2sUUV"
    type: "message",
    role: "assistant",
    
    content: Array<{
      type: "text" | "tool_use",
      
      // For type="text":
      text?: string,
      
      // For type="tool_use":
      id?: string,                 // "toolu_019DpQj5TNPCcH5RSb8Gw1eD"
      name?: string,               // Tool name: "Read", "Bash", "Grep", etc.
      input?: {                    // Tool-specific parameters
        file_path?: string,
        command?: string,
        pattern?: string,
        // ... varies by tool
      }
    }>,
    
    stop_reason: null | string,    // Usually null during streaming
    stop_sequence: null | string,
    
    usage: {                       // Token accounting
      input_tokens: number,
      cache_creation_input_tokens: number,
      cache_read_input_tokens: number,
      cache_creation: {
        ephemeral_5m_input_tokens: number,
        ephemeral_1h_input_tokens: number
      },
      output_tokens: number,
      service_tier: "standard"
    }
  }
}
```

**Key Observations:**
- `content` is **always array** (unlike user events)
- Tool calls appear as `type="tool_use"` content blocks
- Tool results come back as subsequent `user` events with `type="tool_result"` content
- Prompt caching details exposed in `usage.cache_*` fields

### 3.3 `summary` Event

**Purpose:** UI metadata for session display (title, description)

```typescript
{
  type: "summary",
  summary: string,                 // "CLI Tool for Code Summarization and Management"
  leafUuid: string                 // UUID of the last message in this segment
}
```

**Key Observations:**
- NO `timestamp`, `sessionId`, or `uuid` fields
- Multiple summaries can exist per file (conversation segments)
- Used by Resume picker to show human-readable titles
- `leafUuid` links summary to conversation point

### 3.4 `file-history-snapshot` Event

**Purpose:** Tracks file backup state for edited files

```typescript
{
  type: "file-history-snapshot",
  messageId: string,               // UUID of associated message
  snapshot: {
    messageId: string,             // Same as parent
    trackedFileBackups: {          // Map of file paths to backup locations
      [filePath: string]: string
    },
    timestamp: string              // ISO 8601
  },
  isSnapshotUpdate: boolean        // false for new snapshots, true for updates
}
```

**Key Observations:**
- Appears at start of sessions and after file modifications
- Usually empty `trackedFileBackups: {}` for read-only sessions
- NO top-level `sessionId` or `uuid`

---

## 4. Conversation Threading & Structure

### 4.1 Parent-Child Linking

Events form a **linked list** via `parentUuid`:

```
null → [user] → [assistant] → [assistant] → [user] → [assistant]
       uuid1      uuid2         uuid3         uuid4     uuid5
              ↑parent=uuid1  ↑parent=uuid2  ↑parent=uuid3
```

**Pattern:**
- First event: `parentUuid: null`
- Each subsequent event: `parentUuid: <previous-event-uuid>`
- Tool calls create branching: assistant with tool_use → user with tool_result → assistant with response

### 4.2 Sidechain Detection & Separation

**In Claude Code 2.0.24+**, sidechain events are stored in **separate files**, not inline with main events.

**Main Session File** (`ba93ece4-80ee-4f87-9b23-214d9e786827.jsonl`):
```typescript
// All events have isSidechain: false
{
  type: "user",
  isSidechain: false,  // ← User sees this
  message: { content: "Write tests for auth.ts" }
}
```

**Agent File** (`agent-5f7b2000.jsonl`):
```typescript
// All events have isSidechain: true + agentId
{
  type: "user",
  isSidechain: true,   // ← Filtered in UI
  agentId: "5f7b2000", // ← Links to this agent file
  message: { content: "I need to understand how Sage handles thread resumption..." }
}
```

**Detection Strategy:**
- **File-based filtering**: Skip files named `agent-*.jsonl` when listing sessions
- **No inline filtering needed**: Main session files are pre-filtered by Claude Code
- **Optional agent access**: If you need agent work, read corresponding `agent-<id>.jsonl` files

#### Comparison: SpecStory vs Direct JSONL

**SpecStory Markdown (all versions):**
```typescript
function isSidechainHeader(lowerCasedHeader: string): boolean {
  return lowerCasedHeader.includes('(sidechain)');
}
```
SpecStory marks sidechains in headers regardless of whether they came from inline or separate files.

**Direct JSONL (2.0.24+):**
```typescript
// Simple file-based filtering
const mainSessions = files.filter(f =>
  f.endsWith('.jsonl') && !f.startsWith('agent-')
);

// No inline filtering needed - files are pre-separated
async function getMainConversation(sessionId: string) {
  const sessionPath = `${projectDir}/${sessionId}.jsonl`;
  const events = await readJsonlFile(sessionPath);
  return events; // Already filtered by Claude Code
}
```

### 4.3 Turn Reconstruction

A "turn" consists of:
1. **User message** (`type="user"`, `isSidechain=false`)
2. Zero or more **tool exchanges** (assistant tool_use → user tool_result, repeated)
3. **Final assistant response** (`type="assistant"`, `isSidechain=false`)

**Example Flow:**
```
1. User: "Read src/app.ts and explain it"
2. Assistant: [tool_use: Read src/app.ts]
3. User: [tool_result: file contents...]
4. Assistant: [text: "This file is the main entry point..."]
```

Events 2-3 can repeat multiple times (multi-tool calls).

---

## 5. Warmup Sessions Explained

### 5.1 What Are Warmups?

Claude Code creates **automatic initialization sessions** with:
- First user message: `content: "Warmup"`
- Purpose: Prime prompt caching for faster responses
- Created at session start or after resume

### 5.2 Detection Methods

**Method 1: Check first user message**
```typescript
const isWarmup = (events: Event[]) => {
  const firstUser = events.find(e => e.type === 'user' && !e.isSidechain);
  if (!firstUser) return true; // No user content = warmup-only
  
  const content = typeof firstUser.message.content === 'string' 
    ? firstUser.message.content 
    : firstUser.message.content[0]?.text || '';
  
  return content.trim().toLowerCase() === 'warmup';
};
```

**Method 2: Check for real user turns**
```typescript
const hasRealContent = events.some(e => 
  e.type === 'user' && 
  !e.isSidechain && 
  e.message.content !== 'Warmup'
);
```

### 5.3 Warmup vs Real Sessions

| Characteristic | Warmup Session | Real Session |
|----------------|----------------|--------------|
| File size | ~1.5-2KB | Varies (KB to MB) |
| Line count | 2-3 lines | 4+ lines |
| First user content | "Warmup" | Actual prompt |
| Has summaries | No | Usually yes |

**Current Sage Approach (SpecStory markdown):**
```typescript
// src/lib/specstory.ts:200-202
const mainUserMatch = content.match(/_\*\*User\*\*_\s*\n+([\s\S]*?)(?=\n-{3,}|_\*\*Agent|\Z)/);
const initialPrompt = mainUserMatch ? cleanupPreview(mainUserMatch[1]) : undefined;
const isWarmup = !initialPrompt;
```

---

## 6. Session Resumption & Chaining

### 6.1 Resume Behavior

**Critical Understanding:**
- `claude --resume <session-id>` loads prior context BUT writes to **NEW file with NEW UUID**
- Original file: `c3432222-f797-4573-9163-99fe68d9fc4e.jsonl`
- Resumed file: `06b7d565-88ec-4f13-9b43-e513ed80e6c1.jsonl` ← NEW!

**No Native Chain ID:** There is NO field linking these files together.

### 6.2 Heuristic Linking (How Resume Picker Works)

The UI groups sessions using:
1. **Same project directory** (`~/.claude/projects/<slug>/`)
2. **Same git branch** (from `summary` events or `gitBranch` field)
3. **Similar/matching title** (from `summary.summary` field)
4. **Close timestamps** (file modification time)

```typescript
// Pseudo-code for conversation chain key
const chainKey = sha1(
  projectSlug + 
  gitBranch + 
  normalizedTitle.toLowerCase().trim()
);
```

### 6.3 Implications for Sage

**Current:** Sage uses SpecStory which handles resume chaining automatically:
```
specstory sync claude -s c3432222...
  ↓
Outputs: 20251024_093012_quicklygetcontextonthisrepo.md
  ↓
Contains FULL conversation history (original + all resumes merged)
```

**Direct JSONL:** Sage would need to:
1. Detect warmup-only sessions (likely resumed children)
2. Match resumed sessions to parents via heuristics
3. Either:
   - **Option A:** Skip warmup-only sessions (let user select parent)
   - **Option B:** Build chain key and auto-merge related sessions
   - **Option C:** Show ALL sessions, mark resumed ones

**Recommendation:** Start with **Option A** (skip warmups), add **Option B** later if needed.

---

## 7. Complete JSONL Schema (TypeScript Definitions)

```typescript
// Base event properties
interface BaseEvent {
  type: string;
  timestamp?: string;  // ISO 8601
  sessionId?: string;  // UUID
  uuid?: string;       // Event UUID
  parentUuid?: string | null;
  isSidechain?: boolean;
  version?: string;    // Claude Code version
  cwd?: string;
  gitBranch?: string;
  userType?: "external";
  agentId?: string;    // Present if isSidechain=true
}

// Message content types
type MessageContent = 
  | string  // Simple text
  | Array<
      | { type: "text"; text: string }
      | { 
          type: "tool_use"; 
          id: string; 
          name: string; 
          input: Record<string, any> 
        }
      | { 
          type: "tool_result"; 
          tool_use_id: string; 
          content: string | any[] 
        }
    >;

// User event
interface UserEvent extends BaseEvent {
  type: "user";
  message: {
    role: "user";
    content: MessageContent;
  };
  thinkingMetadata?: {
    level: "none" | "low" | "medium" | "high";
    disabled: boolean;
    triggers: string[];
  };
  toolUseResult?: {
    status: "completed" | "error";
    prompt: string;
    agentId: string;
    content: Array<{ type: "text"; text: string }>;
    totalDurationMs: number;
    totalTokens: number;
    totalToolUseCount: number;
    usage: UsageInfo;
  };
}

// Assistant event
interface AssistantEvent extends BaseEvent {
  type: "assistant";
  requestId: string;
  message: {
    model: string;
    id: string;  // Message ID
    type: "message";
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { 
          type: "tool_use"; 
          id: string; 
          name: string; 
          input: Record<string, any> 
        }
    >;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: UsageInfo;
  };
}

// Usage/token info
interface UsageInfo {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  output_tokens: number;
  service_tier: string;
}

// Summary event
interface SummaryEvent {
  type: "summary";
  summary: string;  // Human-readable title
  leafUuid: string; // Last event UUID in this segment
}

// File history snapshot
interface FileHistorySnapshotEvent {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, string>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

// Union type
type ClaudeEvent = 
  | UserEvent 
  | AssistantEvent 
  | SummaryEvent 
  | FileHistorySnapshotEvent
  | BaseEvent;  // Catch-all for unknown types
```

---

## 8. Parsing Conversation Turns from JSONL

### 8.1 Core Algorithm

```typescript
interface Turn {
  user: string;
  agent?: string;
}

function extractTurns(events: ClaudeEvent[]): Turn[] {
  const turns: Turn[] = [];
  let currentUser: string | null = null;
  let currentAgent: string[] = [];

  for (const event of events) {
    // Skip sidechains
    if (event.isSidechain) continue;

    if (event.type === 'user') {
      // Commit previous turn if exists
      if (currentUser) {
        turns.push({
          user: currentUser,
          agent: currentAgent.length ? currentAgent.join('\n') : undefined
        });
      }

      // Start new turn
      currentUser = extractUserContent(event.message.content);
      currentAgent = [];
    }

    if (event.type === 'assistant') {
      // Accumulate assistant responses
      const text = extractAssistantText(event.message.content);
      if (text) currentAgent.push(text);
    }
  }

  // Commit final turn
  if (currentUser) {
    turns.push({
      user: currentUser,
      agent: currentAgent.length ? currentAgent.join('\n') : undefined
    });
  }

  return turns;
}

function extractUserContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  
  // Extract text blocks, skip tool_result blocks
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function extractAssistantText(content: Array<{type: string; text?: string}>): string {
  // Extract only text blocks, ignore tool_use blocks
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}
```

### 8.2 Handling Tool Calls

**Current SpecStory Approach:** Tool calls are INVISIBLE (filtered to sidechains)

**Direct JSONL Approach:** Tool calls ARE visible:

```typescript
function extractTurnsWithTools(events: ClaudeEvent[]): Turn[] {
  // Option 1: Hide tools completely (matches SpecStory)
  // → Use algorithm above

  // Option 2: Show tool calls inline
  const turns: Turn[] = [];
  let currentTurn: { user: string; agent: string[]; tools: ToolCall[] } | null = null;

  for (const event of events) {
    if (event.isSidechain) continue;

    if (event.type === 'user') {
      if (currentTurn) turns.push(formatTurn(currentTurn));
      currentTurn = { 
        user: extractUserContent(event.message.content), 
        agent: [], 
        tools: [] 
      };
    }

    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          currentTurn?.agent.push(block.text);
        }
        if (block.type === 'tool_use') {
          currentTurn?.tools.push({
            name: block.name,
            input: block.input
          });
        }
      }
    }
  }

  if (currentTurn) turns.push(formatTurn(currentTurn));
  return turns;
}
```

**Recommendation for Sage:** Start with **Option 1** (hide tools) to match current behavior, then optionally expose tools in debug mode.

---

## 9. Comparison: SpecStory Markdown vs Direct JSONL

### 9.1 SpecStory Markdown Approach (Current)

**Workflow:**
```
1. Claude Code writes JSONL → ~/.claude/projects/<slug>/<session>.jsonl
2. Stop hook triggers → specstory sync claude -s <session>
3. SpecStory reads JSONL, generates markdown → .sage/history/<filename>.md
4. Sage watches markdown → parses on change → feeds to Codex
```

**Markdown Format:**
```markdown
<!-- Claude Code Session ba93ece4-80ee-4f87-9b23-214d9e786827 (2025-10-29) -->

# CLI Tool for Code Summarization and Management

_**User**_

Get context on this repo

---

_**Agent**_

I'll explore the repository to understand its structure and purpose.

[Read: README.md]
[Read: package.json]
...

---

_**User (sidechain)**_  ← MARKED for filtering

Warmup

---
```

**Pros:**
- Human-readable format
- SpecStory handles resume chaining automatically
- Proven to work (Sage shipped with this)

**Cons:**
- External dependency (SpecStory CLI must be installed)
- Adds latency (JSONL → process → markdown → parse)
- Lossy conversion (tool calls details, token counts, timing info lost)
- Sidechain filtering happens in SpecStory (opaque)
- Markdown parsing is fragile (regex-based, sensitive to format changes)

### 9.2 Direct JSONL Approach (Proposed)

**Workflow:**
```
1. Claude Code writes JSONL → ~/.claude/projects/<slug>/<session>.jsonl
2. Sage watches JSONL directly → parses on change → feeds to Codex
```

**Pros:**
- **No external dependencies** - elimintes SpecStory CLI requirement
- **Faster** - no intermediate conversion step
- **Complete data** - access to tokens, timing, tool details, request IDs
- **Simpler parsing** - JSON.parse() per line vs complex regex
- **More reliable** - structured format, not markdown heuristics
- **Sidechain control** - explicitly check `isSidechain` field
- **Access to metadata** - session ID, timestamps, versions, git branch

**Cons:**
- Need to implement warmup detection
- Need to handle resume chaining (or skip warmup-only sessions)
- More complex session discovery (multiple dirs, multiple projects)
- Need to filter empty files (0 bytes)

### 9.3 Side-by-Side Feature Comparison

| Feature | SpecStory Markdown | Direct JSONL |
|---------|-------------------|--------------|
| **Dependency** | Requires SpecStory CLI | Native (just fs.readFile) |
| **Latency** | High (spawn process) | Low (direct file read) |
| **Data Fidelity** | Low (lossy conversion) | High (source of truth) |
| **Tool Call Visibility** | Hidden | Available |
| **Token Counts** | Not available | Available |
| **Timing Info** | Not available | Available (timestamps) |
| **Resume Handling** | Automatic (merged) | Manual (detect warmups) |
| **Parsing Complexity** | High (regex) | Low (JSON.parse) |
| **Format Stability** | Medium (markdown changes) | Medium (schema evolves) |
| **Session Discovery** | Easy (one file per session) | Easy (skip `agent-*.jsonl`) |
| **Warmup Detection** | Done by SpecStory | Need to implement |
| **Sidechain Filtering** | Done by SpecStory | File-based (skip `agent-*.jsonl`) |
| **Agent File Handling** | Merged automatically | Optional (read if needed) |
| **Version Compatibility** | Handles all versions | Requires 2.0.24+ |

---

## 10. Migration Path: SpecStory → Direct JSONL

### 10.1 Minimal Viable Change (MVP)

**Goal:** Replace SpecStory with JSONL parsing while maintaining identical behavior

**Changes Required:**

1. **New module: `src/lib/jsonl.ts`**
```typescript
export interface JsonlSessionSummary {
  sessionId: string;
  title: string;
  timestamp: string;
  jsonlPath: string;
  isWarmup: boolean;
  initialPrompt?: string;
}

export async function listJsonlSessions(): Promise<JsonlSessionSummary[]> {
  // 1. Find all .jsonl files in project dir
  // 2. Filter out empty files
  // 3. Parse first few events to detect warmups
  // 4. Extract title from summary events or first user prompt
  // 5. Return sorted by timestamp
}

export async function readSessionEvents(sessionId: string): Promise<ClaudeEvent[]> {
  // 1. Find .jsonl file by session ID
  // 2. Read line by line, parse JSON
  // 3. Return array of events
}

export function extractTurns(events: ClaudeEvent[]): Turn[] {
  // Implementation from section 8.1
}
```

2. **Update `src/lib/review.ts`**
```typescript
// OLD:
import { extractTurns } from './markdown.js';
const markdownContent = await fs.readFile(session.markdownPath, 'utf8');
const turns = extractTurns(markdownContent);

// NEW:
import { readSessionEvents, extractTurns } from './jsonl.js';
const events = await readSessionEvents(session.sessionId);
const turns = extractTurns(events);
```

3. **Update `src/ui/App.tsx`**
```typescript
// OLD:
import { listSpecstorySessions, syncSpecstoryHistory } from '../lib/specstory.js';
const sessions = await listSpecstorySessions();

// NEW:
import { listJsonlSessions } from '../lib/jsonl.js';
const sessions = await listJsonlSessions();
```

4. **Remove dependencies**
- Delete `src/lib/specstory.ts`
- Delete `src/lib/markdown.ts`
- Remove SpecStory hook installation from `src/lib/hooks.ts`
- Update `package.json` (no SpecStory binary needed)

### 10.2 Incremental Migration (Safer)

**Phase 1:** Add JSONL support alongside SpecStory
- Keep existing code working
- Add `src/lib/jsonl.ts` with full implementation
- Add CLI flag: `--use-jsonl` to opt into new path
- Test thoroughly

**Phase 2:** Make JSONL default
- Flip default to JSONL
- Keep SpecStory as fallback (`--use-specstory`)

**Phase 3:** Remove SpecStory
- Delete old code after 1-2 releases of stability

### 10.3 Testing Strategy

**Unit Tests:**
```typescript
describe('JSONL Parser', () => {
  it('detects warmup sessions', () => {
    const events = parseJsonl(warmupFixture);
    expect(isWarmupSession(events)).toBe(true);
  });

  it('extracts turns correctly', () => {
    const events = parseJsonl(conversationFixture);
    const turns = extractTurns(events);
    expect(turns).toHaveLength(3);
    expect(turns[0].user).toContain('Read README');
  });

  it('filters sidechain events', () => {
    const events = parseJsonl(sidechainFixture);
    const turns = extractTurns(events);
    expect(turns.some(t => t.user.includes('(agent)'))).toBe(false);
  });
});
```

**Integration Tests:**
- Compare SpecStory and JSONL output on same session
- Verify Codex prompts are identical
- Verify review results are identical

---

## 11. Detecting Warmup Sessions (Implementation Guide)

### 11.1 Fast Warmup Detection (File-Level)

```typescript
async function isWarmupSession(jsonlPath: string): Promise<boolean> {
  // Quick checks before parsing
  const stats = await fs.stat(jsonlPath);
  
  // Empty files are warmup-only (session created but never used)
  if (stats.size === 0) return true;
  
  // Very small files (< 3KB) are likely warmup-only
  if (stats.size < 3000) {
    // Need to parse to confirm
    const events = await readJsonlFile(jsonlPath);
    return isWarmupEvents(events);
  }
  
  // Larger files definitely have content
  return false;
}
```

### 11.2 Event-Level Detection

```typescript
function isWarmupEvents(events: ClaudeEvent[]): boolean {
  // Find first non-sidechain user event
  const firstUser = events.find(e => 
    e.type === 'user' && 
    e.isSidechain === false
  );
  
  if (!firstUser) return true; // No user content = warmup
  
  // Check if first prompt is "Warmup"
  const content = extractUserContent(firstUser.message.content);
  return content.trim().toLowerCase() === 'warmup';
}
```

### 11.3 Alternative: Count Real Turns

```typescript
function hasRealContent(events: ClaudeEvent[]): boolean {
  let realTurns = 0;
  
  for (const event of events) {
    if (event.type === 'user' && event.isSidechain === false) {
      const content = extractUserContent(event.message.content);
      if (content.trim().toLowerCase() !== 'warmup') {
        realTurns++;
      }
    }
  }
  
  return realTurns > 0;
}
```

---

## 12. Session Discovery Implementation

### 12.1 Finding All Sessions

```typescript
import { promises as fs } from 'fs';
import path from 'path';

async function discoverAllSessions(
  baseDir: string = '~/.claude/projects'
): Promise<string[]> {
  const expandedPath = baseDir.replace('~', process.env.HOME || '');
  const projectDirs = await fs.readdir(expandedPath, { withFileTypes: true });

  const jsonlFiles: string[] = [];

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;

    const projectPath = path.join(expandedPath, dir.name);
    const files = await fs.readdir(projectPath);

    for (const file of files) {
      // CRITICAL: Skip agent files (2.0.24+) to avoid duplicates
      // Agent files contain sidechain work, not main sessions
      if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
        jsonlFiles.push(path.join(projectPath, file));
      }
    }
  }

  return jsonlFiles;
}

// Optional: Discover agent files for a session
async function discoverAgentFiles(
  projectDir: string,
  sessionId?: string
): Promise<string[]> {
  const files = await fs.readdir(projectDir);

  return files
    .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map(f => path.join(projectDir, f));
}
```

### 12.2 Filtering for Current Project

```typescript
function filterCurrentProject(
  allSessions: string[],
  currentCwd: string
): string[] {
  // Determine project slug from cwd
  const projectSlug = currentCwd
    .replace(/^\//, '')
    .replace(/\//g, '-');
  
  return allSessions.filter(path => 
    path.includes(`/${projectSlug}/`)
  );
}
```

### 12.3 Building Session List

```typescript
async function buildSessionList(
  jsonlPaths: string[]
): Promise<JsonlSessionSummary[]> {
  const sessions: JsonlSessionSummary[] = [];
  
  for (const filePath of jsonlPaths) {
    const stats = await fs.stat(filePath);
    
    // Skip empty files
    if (stats.size === 0) continue;
    
    // Parse events
    const events = await readJsonlFile(filePath);
    
    // Skip warmup-only sessions
    if (isWarmupEvents(events)) continue;
    
    // Extract metadata
    const sessionId = path.basename(filePath, '.jsonl');
    const summary = extractSessionSummary(events);
    const firstUserPrompt = extractFirstUserPrompt(events);
    
    sessions.push({
      sessionId,
      title: summary?.title || firstUserPrompt || sessionId.slice(0, 8),
      timestamp: stats.mtime.toISOString(),
      jsonlPath: filePath,
      isWarmup: false,
      initialPrompt: firstUserPrompt
    });
  }
  
  // Sort by timestamp descending (newest first)
  return sessions.sort((a, b) => 
    new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf()
  );
}
```

---

## 13. Working with Agent Files (Optional)

### 13.1 When to Read Agent Files

Agent files contain the detailed work of Task tool invocations (Explore, Plan, etc.). For most review purposes, **you don't need them**—the main conversation already shows the user prompt and Claude's final response.

**Use cases for reading agent files:**
- Debug mode: Show "what Claude was thinking" during Task calls
- Token usage tracking: Calculate full cost including agent work
- Detailed analysis: Understand how Claude explored the codebase

### 13.2 Discovering Agent Files

```typescript
// Optional: Discover agent files for a session
async function discoverAgentFiles(
  projectDir: string
): Promise<string[]> {
  const files = await fs.readdir(projectDir);

  return files
    .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map(f => path.join(projectDir, f));
}
```

### 13.3 Reading Agent Work

```typescript
async function extractAgentWork(
  projectDir: string
): Promise<Map<string, ClaudeEvent[]>> {
  const agentFiles = await discoverAgentFiles(projectDir);
  const agentWork = new Map<string, ClaudeEvent[]>();

  for (const filePath of agentFiles) {
    const agentId = path.basename(filePath, '.jsonl').replace('agent-', '');
    const events = await readJsonlFile(filePath);
    agentWork.set(agentId, events);
  }

  return agentWork;
}
```

### 13.4 Recommendation for Sage

**Phase 1 (MVP):**
- Only parse main conversation (skip agent work entirely)
- Simple file filtering: `!file.startsWith('agent-')`

**Phase 2 (Enhanced):**
- Add flag to optionally include agent work in debug mode
- Show agent file count in session picker ("3 agent tasks")
- Allow viewing agent transcripts separately

**Phase 3 (Advanced):**
- Reconstruct full timeline by merging main + agent events by timestamp
- Show "what Claude was thinking" during Task calls
- Expose agent token usage for cost tracking

---

## 14. Key Recommendations

### 14.1 For Sage Migration

1. **Start with MVP** - Replace SpecStory parsing but keep identical behavior
2. **Keep warmup filtering** - Skip warmup-only sessions like SpecStory does
3. **Don't worry about resume chaining initially** - Let users select parent session (current behavior)
4. **Add tool call visibility later** - Start with same filtering as SpecStory
5. **Test extensively** - Compare JSONL and SpecStory outputs side-by-side

### 14.2 Advantages to Emphasize

- **Zero dependencies** - no external CLI required
- **Faster reviews** - eliminate conversion step
- **More reliable** - structured data vs markdown parsing
- **Future-proof** - direct access to source format

### 14.3 Future Enhancements

Once JSONL parsing is stable:
- **Show tool calls** in debug mode (helps understand what Claude did)
- **Expose token counts** (track costs, optimize prompts)
- **Resume chain detection** (automatically link resumed sessions)
- **Multi-project support** (review sessions across projects)
- **Timing analysis** (detect slow responses)

---

## 15. Appendix: Real-World Examples

### 15.1 Warmup Session (1.5KB, 2 lines)

```json
{"parentUuid":null,"isSidechain":true,"userType":"external","cwd":"/Users/henryquillin/Desktop/Repos/sage","sessionId":"0145b08f-fd45-4207-a8eb-2cbd01daca30","version":"2.0.26","gitBranch":"main","type":"user","message":{"role":"user","content":"Warmup"},"uuid":"1678846a-0e71-4776-b07b-526b874a12d9","timestamp":"2025-10-28T18:06:11.015Z"}
{"parentUuid":"1678846a-0e71-4776-b07b-526b874a12d9","isSidechain":true,"userType":"external","cwd":"/Users/henryquillin/Desktop/Repos/sage","sessionId":"0145b08f-fd45-4207-a8eb-2cbd01daca30","version":"2.0.26","gitBranch":"main","message":{"model":"claude-haiku-4-5-20251001","id":"msg_016KnwwJYPybk4ownPxuL3Ly","type":"message","role":"assistant","content":[{"type":"text","text":"I'm Claude Code, Anthropic's CLI file search specialist..."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":515,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":157,"service_tier":"standard"}},"requestId":"req_011CUa3Jh2a7sdKpNexDTiyP","type":"assistant","uuid":"5a068ce6-7e86-4ba4-9c20-97748546e257","timestamp":"2025-10-28T18:06:13.231Z"}
```

**Characteristics:**
- `isSidechain: true` on BOTH events
- First user content: `"Warmup"`
- Only 2 lines total
- Haiku model (cheap/fast for warmup)

### 15.2 Real Session (143KB, 24 lines)

```json
{"type":"file-history-snapshot","messageId":"55449772-b6ef-4d86-a1b3-bb135d0f6bce","snapshot":{"messageId":"55449772-b6ef-4d86-a1b3-bb135d0f6bce","trackedFileBackups":{},"timestamp":"2025-10-29T14:49:14.227Z"},"isSnapshotUpdate":false}
{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/Users/henryquillin/Desktop/Repos/sage","sessionId":"ba93ece4-80ee-4f87-9b23-214d9e786827","version":"2.0.28","gitBranch":"main","type":"user","message":{"role":"user","content":"(switching to jsonl) \n\nGet context on this repo "},"uuid":"55449772-b6ef-4d86-a1b3-bb135d0f6bce","timestamp":"2025-10-29T14:49:14.220Z","thinkingMetadata":{"level":"none","disabled":true,"triggers":[]}}
{"type":"summary","summary":"CLI Tool for Code Summarization and Management","leafUuid":"e74a2b23-42ea-4466-9589-04702134ea23"}
...
```

**Characteristics:**
- `isSidechain: false` on main events
- Real user prompt (not "Warmup")
- Multiple summary events
- 24 lines (mix of user/assistant/summary/snapshot)
- Sonnet 4.5 model (powerful)

### 15.3 Agent File (Sidechain) - Modern Format (2.0.24+)

**File:** `agent-6cce90d0.jsonl` (separate from main session)

```json
{"parentUuid":null,"isSidechain":true,"userType":"external","cwd":"/Users/henryquillin/Desktop/Repos/sage","sessionId":"66f3a4e5-ea6a-459a-8357-d31d692ebec7","version":"2.0.28","gitBranch":"main","agentId":"6cce90d0","type":"user","message":{"role":"user","content":"I need to research how to prevent SpecStory from creating a `.specstory` directory in the user's project when running `specstory sync claude --output-dir .sage/history`.\n\nThe user provided this documentation URL: https://context7.com/specstoryai/docs/llms.txt?topic=project.json&tokens=17773\n\nPlease:\n1. Fetch and analyze the SpecStory documentation from that URL\n2. Look for any CLI flags or options for `specstory sync` command..."},"uuid":"52ea2c9e-b2f1-4e8d-bd56-04dad02b5669","timestamp":"2025-10-29T02:57:41.651Z"}
{"parentUuid":"52ea2c9e-b2f1-4e8d-bd56-04dad02b5669","isSidechain":true,"userType":"external","cwd":"/Users/henryquillin/Desktop/Repos/sage","sessionId":"66f3a4e5-ea6a-459a-8357-d31d692ebec7","version":"2.0.28","gitBranch":"main","agentId":"6cce90d0","message":{"model":"claude-sonnet-4-5-20250929","id":"msg_01TD1GKJuDa6ZrY4zkYPcA4s","type":"message","role":"assistant","content":[{"type":"text","text":"I'll help you research the SpecStory documentation to understand how to prevent the `.specstory` directory creation. Let me fetch and analyze the documentation."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":12580,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":12580,"ephemeral_1h_input_tokens":0},"output_tokens":265,"service_tier":"standard"}},"requestId":"req_011CUajqUfSzpP1oZ3WhtaF2","type":"assistant","uuid":"c6c17bcf-a649-4617-971c-60cb2936557a","timestamp":"2025-10-29T02:57:44.802Z"}
```

**Characteristics:**
- **Stored in separate file** `agent-<agentId>.jsonl` ← NEW in 2.0.24+
- `isSidechain: true` on ALL events in this file
- `agentId: "6cce90d0"` ← Matches filename `agent-6cce90d0.jsonl`
- Full conversation thread (can be hundreds of lines)
- NOT visible in Claude Code UI


---

## 16. Conclusion

Direct JSONL parsing offers significant advantages over the current SpecStory approach:

**Technical Benefits:**
- Eliminates external dependency
- Reduces latency (no conversion step)
- Provides access to complete data
- Simpler, more reliable parsing

**User Benefits:**
- Easier installation (no SpecStory CLI needed)
- Faster reviews (less overhead)
- More stable (structured format)

**Migration Path:**
- MVP is straightforward (replace markdown parser with JSONL parser)
- Can be done incrementally with feature flags
- Extensive testing ensures no regressions

**Future Potential:**
- Tool call visibility
- Token usage tracking
- Multi-project support
- Resume chain detection
- Agent work analysis

The JSONL format is Claude Code's native format and the source of truth for all conversation data. By parsing it directly, Sage can become simpler, faster, and more capable.

**Critical Note on Version Requirements:**

This document describes the Claude Code 2.0.24+ JSONL format where agent/sidechain events are stored in separate `agent-<agentId>.jsonl` files. **Sage only supports this modern format.** Sessions from Claude Code versions prior to 2.0.24 (where events were stored inline with `isSidechain: true`) are not supported.
