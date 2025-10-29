# Claude Code JSONL Logs — Format & Operational Notes

This document consolidates the current understanding of how Claude Code emits JSONL transcripts, how resumes and warmups behave, and which fields hooks expose when you need to link events back to on-disk logs.

## Storage Layout
- Every session is written to `~/.claude/projects/<project-slug>/<session-id>.jsonl` (session ID is a UUID and matches the filename).
- Logs are append-only JSON Lines. Each line is an independent JSON object describing an event or metadata update.
- Retention is handled by Claude Code; older sessions may be purged unless you archive the directory yourself.
- Active sessions often emit an initial `type:"file-history-snapshot"` record that captures the working tree state before the first prompt; treat it as metadata rather than part of the conversation.

## Core Event Types
Observed `type` values include:
- `user` — developer prompt with `message.role:"user"` and a `content` array (`[{ type: "text", text: "..." }, …]`).
- `assistant` — Claude’s reply with `message.role:"assistant"`, `content` chunks, and detailed `usage` data (token counts plus cache hits/misses) and `requestId`.
- `tool` / `tool_result` — records tool invocations and their responses during sidechain activity.
- `summary` — UI metadata such as human-readable `title`, `branch`, and sometimes prompt counts; the resume picker relies on these.
- `system` / `notification` — lifecycle messages, warnings, or system-level notes.
- `file-history-snapshot` — baseline entry emitted before the first real turn, showing the snapshot `messageId` and tracked backups (usually empty).

Fields are not guaranteed across releases; treat the schema as “best effort” and code defensively when parsing.

## Message Structure
Common top-level keys:
- `type` — event discriminator.
- `timestamp` — ISO 8601 string; safe to sort chronologically.
- `sessionId` — UUID tied to the transcript filename.
- `uuid` / `parentUuid` — unique identifiers per entry and their parent turn linkage.
- `isSidechain` — boolean indicating whether the turn belongs to a delegated agent run (true for agent logs, false for main transcript).
- `userType` — typically `"external"` for developer turns; helps differentiate internal system events.
- `cwd` — absolute working directory for the command/turn.
- `version` and `gitBranch` — Claude Code build and active Git branch at the time of the event.
- `thinkingMetadata` — present on user prompts; includes `level`, `disabled`, and trigger hints.
- `message` — present on conversational events. Contains `role`, `content[]`, possibly `usage` and tool call metadata.
- `summary` — present on `type:"summary"` lines (`{ title, branch, … }`).
- `requestId` — echoes the Claude API request identifier on assistant/sidechain responses.

Content arrays mirror Anthropic’s Messages API:
- Text chunks: `{ "type": "text", "text": "..." }`
- Tool uses: `{ "type": "tool_use", "id": "...", "name": "...", "input": { … } }`
- Tool results: `{ "type": "tool_result", "tool_use_id": "...", "content": [ … ] }`
- Primary transcripts embed tool results inside a `type:"user"` object whose `content` contains a `tool_result` record—Claude replies after that entry rather than storing tool outputs separately.

## Session Lifecycle
- Fresh runs and `claude --resume` both create **new** JSONL files. Resumed sessions load prior context, clone the earlier transcript into the new file (preserving original `sessionId` values for copied entries), and then append new turns under the new UUID.
- The Resume picker groups sessions by project + branch + latest summary title, so multiple physical files often appear as one “conversation”.
- No official cross-file conversation ID exists; chain sessions heuristically (same project directory, matching titles, close timestamps, etc.).

## Warmup Behavior
- Claude sometimes writes an automatic first turn with user content `"Warmup"` to prime prompt caching.
- IDE bugs can surface these warmup files as duplicate “Warmup” conversations. Filter them by checking whether the first user message equals `"Warmup"` when building session lists.
- Prompt caching can be disabled via `DISABLE_PROMPT_CACHING=1`, but that trades away latency benefits.
- Warmup runs look identical in structure to full sessions, including tool eligibility notices, so you must explicitly ignore the `"Warmup"` user content or the absence of meaningful follow-up turns.

## Hook Inputs & Log Correlation
Hook payloads surface transcript metadata so scripts can connect events back to disk:
- `session_id` and `transcript_path` identify the active JSONL file.
- `cwd` captures the workspace directory Claude Code was operating in.
- `permission_mode` reveals whether Claude is in the default, plan, accept-edits, or bypass mode.
- Event-specific fields depend on the hook (`tool_input`, `tool_response`, `prompt`, `message`, `stop_hook_active`, etc.).

The `Stop` hook is particularly useful for automation: Sage writes a lightweight "needs review" signal file using the provided `session_id` and `transcript_path` whenever Claude finishes a turn, letting the TUI queue critiques without re-exporting the transcript.

## Practical Parsing Tips
- Treat every line as standalone JSON; never assume schemas are stable. Use `jq` (or similar) to filter `type` and `sessionId`.
- For chronological stitching, merge multiple files with `jq -s 'flatten | sort_by(.timestamp // 0)' … | jq -c ".[]"`.
- Maintain your own index (e.g., append `{ session_id, transcript_path, cwd, ts }` via a SessionStart hook) if you need an authoritative session catalog.
- When displaying session titles, prefer the latest `summary.title`; fall back to the first non-warmup user prompt if summaries are missing.
- Zero-byte transcripts (e.g., aborted sessions) exist; guard your parsers against empty files.
- Sidechain agent logs live alongside primary transcripts using filenames `agent-<id>.jsonl`. They share the parent `sessionId`, include `agentId`, and set `isSidechain:true`, making it easy to correlate Explore/Task runs with their parent conversation.
- Expect duplicated `uuid` values across original and resumed files—dedupe or process events in chronological order before emitting critiques or analytics.

## Known Quirks
- Summaries may lag when resuming; the resume UI reuses the previous title until a new summary is emitted.
- Some releases emit additional contextual fields (`requestId`, `version`, permission data). Ignore unknown properties rather than failing.
- Sidechain tool calls are often hidden from legacy SpecStory exports but remain fully recorded in the JSONL; filters like `tool`/`tool_result` are useful for deeper auditing.
- Cache accounting fields (`cache_creation_input_tokens`, `cache_read_input_tokens`, etc.) fluctuate per response and can be useful if you need to detect prompt caching activity.

Keep this document updated as Anthropic evolves the log schema or introduces a canonical conversation identifier.
