# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Sage is an AI code reviewer that provides automatic second opinions on Claude Code sessions. It monitors Claude conversations in real-time using SpecStory exports and delivers structured critiques via the Codex SDK, without breaking developer workflow.

**Core principle:** Sage is read-only by design. It reviews code but never modifies files.

## Development Commands

### Essential Commands
- `npm start` - Run Sage TUI (uses tsx to execute TypeScript directly)
- `npm run dev` - Development mode with auto-restart on file changes
- `npm run build` - Compile TypeScript to `dist/` directory

### Testing
There are no formal test scripts configured. Individual test files exist:
- `src/lib/codex.test.ts`
- `src/lib/markdown.test.ts`

Run them directly with tsx if needed: `tsx src/lib/markdown.test.ts`

### Debug Mode
Set `SAGE_DEBUG=1` to bypass Codex API calls and return mock critiques:
```bash
SAGE_DEBUG=1 npm start
```

Debug artifacts are always written to `.debug/review-*.txt` regardless of debug mode.

## Architecture

### Data Flow
```
SpecStory export → .sage/history/*.md → File watcher (chokidar) → 
Review queue (FIFO) → Codex SDK → Structured critique → Terminal UI
```

### Key Directories
- `.sage/history/` - SpecStory markdown exports (auto-synced via Claude Stop hooks)
- `.sage/threads/` - Codex thread metadata (enables thread resumption across restarts)
- `.sage/sessions/` - Legacy session exports (kept for backward compatibility)
- `.debug/` - Review prompts and context artifacts (always created, git-ignored)
- `.claude/settings.local.json` - Auto-configured Stop hook for automatic syncing

### Module Responsibilities

**Entry & UI (`src/ui/`, `src/index.tsx`)**
- `App.tsx` - Main TUI orchestrator: session picker, file watcher, FIFO queue, continuous review state, clarification mode
- `CritiqueCard.tsx` - Renders structured critiques with symbol-coded verdicts (✓ ⚠ ✗)
- `ClarificationCard.tsx` - Handles follow-up Q&A with Codex about specific reviews

**SpecStory Integration (`src/lib/specstory.ts`)**
- Wraps `specstory sync claude` command to export sessions to `.sage/history/`
- Parses markdown metadata and filters warmup-only sessions (`isWarmup === true`)
- Sessions with only "Warmup" user prompts are hidden from picker

**Session Parsing (`src/lib/markdown.ts`)**
- Extracts turns from SpecStory markdown
- **Critical:** Filters out `(sidechain)` turns - only primary Claude ↔ developer dialogue is reviewed
- Computes turn signatures for incremental processing

**Review Orchestration (`src/lib/review.ts`)**
- `performInitialReview()` - Full context review when session is first selected
- `performIncrementalReview()` - Reviews only new turns after initial review
- Manages thread lifecycle and turn count tracking

**Codex Integration (`src/lib/codex.ts`)**
- Wraps Codex SDK with JSON schema for structured output (`CritiqueResponse`)
- Builds initial and follow-up prompts emphasizing read-only inspection
- Uses `gpt-4.1-mini` model by default
- **Output schema:** All fields (`verdict`, `why`, `alternatives`, `questions`, `message_for_agent`) are required by OpenAI constraint; empty fields use empty strings

**Thread Management (`src/lib/threads.ts`)**
- Persists Codex thread IDs to `.sage/threads/{sessionId}.json`
- Enables thread resumption across Sage restarts
- Tracks `lastReviewedTurnCount` to support incremental reviews
- Automatically resumes existing threads when re-selecting a session

**Hook Configuration (`src/lib/hooks.ts`)**
- Auto-installs Claude Code `Stop` hook on first run
- Hook command: `specstory sync claude --output-dir "$CLAUDE_PROJECT_DIR/.sage/history" --no-version-check --silent`
- Appends to existing hooks array in `.claude/settings.local.json`

**Debug Utilities (`src/lib/debug.ts`)**
- Checks `SAGE_DEBUG` environment variable
- Writes full prompt + context to `.debug/review-*.txt` for every review (debug mode or not)

**Review Cache (`src/lib/reviewsCache.ts`)**
- Stores completed reviews to `.sage/reviews/{sessionId}.json`
- Enables fast session resumption without re-running reviews
- Persists critique data, turn signatures, and timestamps

### Type System (`src/types.ts`)
```typescript
interface Critique {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives?: string;
  questions?: string;
  raw: string;
}
```

Note: `CritiqueResponse` in `codex.ts` extends this with `message_for_agent` for Claude-directed feedback.

## Critical Constraints

### Read-Only Enforcement
- Sage must NEVER modify, write, or delete project files
- Codex prompts explicitly forbid write operations
- Thread options do not grant write permissions
- Violations would break the "passive reviewer" design

### Warmup Handling
- Claude injects "Warmup" user turns for prompt caching
- Sessions with ONLY warmup prompts are marked `isWarmup: true` and hidden from picker
- Resume sessions create new session IDs but export to original parent - users must select parent session

### Sidechain Filtering
- Claude delegates to sub-agents (Explore, Task, etc.) in "sidechain" turns
- `extractTurns()` in `markdown.ts` strips these before review
- **Never flag "Claude didn't show tool calls"** - they happen in filtered sidechains
- Focus critiques on Claude's final responses to developer, not internal agent work

### Structured Output Requirements
- Codex SDK with `outputSchema` requires ALL fields in `required` array (OpenAI constraint)
- Optional sections must return empty strings, not `null` or `undefined`
- Schema validation failures will throw errors

## Development Patterns

### Adding New Critique Fields
1. Update `CritiqueResponse` interface in `src/lib/codex.ts`
2. Add field to `CRITIQUE_SCHEMA` properties and `required` array
3. Update prompt instructions in `buildInitialPromptPayload()` and `buildFollowupPromptPayload()`
4. Modify `CritiqueCard.tsx` to render new field

### Extending Review Logic
- Initial reviews (`performInitialReview`) should explore codebase context
- Incremental reviews (`performIncrementalReview`) focus on new turns only
- Both use same Codex thread for conversation continuity
- Thread resumption is automatic via `getOrCreateThread()`

### File Watching
- Chokidar watches `.sage/history/{sessionId}.md`
- New turns detected by comparing turn signatures
- Queue processing is FIFO with single worker (`workerRunningRef`)
- Manual sync available via 'M' key

### UI State Management
- React hooks in `App.tsx` manage global state
- Screen state machine: `'loading' | 'error' | 'session-list' | 'running' | 'clarification'`
- Reviews array grows as new critiques complete
- Collapsed state tracked per-review index for "Why" section expansion

## External Dependencies

### Required Tools
- **Node.js 18+** - For ES modules and modern TypeScript
- **SpecStory CLI ≥0.12.0** - Must be on PATH; older versions used `-u` flag instead of `-s`
- **Codex SDK** - Requires local Codex agent running
- **Git repository** - Sage must run in git-tracked directory

### Key npm Packages
- `@openai/codex-sdk` - AI review engine
- `ink` / `react` - Terminal UI framework
- `chokidar` - File watching for continuous mode
- `tsx` - TypeScript execution without build step
- `typescript` - Type checking and compilation

## Configuration

### Environment Variables
- `SAGE_DEBUG` - Set to any truthy value (`1`, `true`, `yes`, `on`) to enable debug mode
- `SAGE_CODEX_MODEL` - Override default model (currently unused, defaults to `gpt-4.1-mini`)

### Generated Files
All generated directories are git-ignored:
- `.sage/` - Contains history/, threads/, sessions/, reviews/
- `.debug/` - Contains review-*.txt prompt artifacts
- `.claude/settings.local.json` - Auto-configured, should not be committed

## Common Pitfalls

### Thread Management
- Thread IDs may not be immediately available after `startThread()` - save metadata after first successful review
- Always check for thread resumption before creating new threads
- Turn count tracking prevents redundant reviews when re-selecting sessions

### Prompt Engineering
- Audience instructions are critical: "You are speaking to the DEVELOPER, not Claude"
- Always use "Claude" (third person) when referring to the AI being reviewed
- Explicitly attribute Claude's actions to "Claude" not "you" in critiques

### SpecStory Integration
- Use `--no-version-check --silent` flags to suppress interactive output
- Session exports go to `.sage/history/`, not `.sage/sessions/` (legacy location)
- Hook command uses `$CLAUDE_PROJECT_DIR` to work from any directory

### Schema Validation
- Empty optional fields must be `""` not `null` (Codex SDK requirement)
- All schema fields must be in `required` array (OpenAI constraint)
- Nested objects not currently supported in critique schema

## Testing Workflow

1. Make code changes
2. Run `npm run build` to check for TypeScript errors
3. Test with `SAGE_DEBUG=1 npm start` to verify flow without Codex calls
4. Test with real Codex by running `npm start` in a repo with Claude sessions
5. Check `.debug/` artifacts to inspect prompts sent to Codex

## Further Reading

- `agents.md` - Comprehensive contributor guide with architecture diagrams and operational guardrails
- `README.md` - User-facing documentation for installation and usage
- `.sage/history/*.md` - SpecStory markdown exports to understand conversation format
