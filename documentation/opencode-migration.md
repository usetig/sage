# Sage: Migration from Codex to OpenCode

This doc summarizes the refactor that replaced the Codex SDK with the OpenCode SDK in Sage, added model/provider flexibility, and introduced a few guardrails. Use it to understand what changed, why, and where to look in the codebase.

## Goals
- Enable Sage reviews to run on non-OpenAI models via OpenCode.
- Keep the existing review flow (initial + incremental critiques, artifacts, warmup handling) while swapping the backend.
- Add basic resilience around OpenCode connectivity and model selection.

## What changed (high level)
- **Client swap:** All Codex SDK usage was removed and replaced with OpenCode calls.
- **Thread/session mapping:** Sage now stores an OpenCode session ID per Claude session (no Codex threads anymore).
- **Model selection:** Models are represented as `provider/model` strings; settings/UI can show server-provided models with a fallback list.
- **Error handling:** OpenCode responses are checked for errors; critique parsing is more defensive.

## Files and responsibilities
- `src/lib/opencode.ts`
  - New thin wrapper around `@opencode-ai/sdk`.
  - Provides `getOpencodeClient`, `ensureSession`, `sendPrompt`, `listProviders`, and `splitModel`.
  - Surfaces connection/auth errors explicitly instead of silently failing.
- `src/lib/codex.ts`
  - Rewritten to build the same critique prompts but send them via OpenCode `session.prompt`.
  - Parses the model response as JSON; attempts to salvage JSON if wrapped in prose.
  - Defines the critique schema types and streaming event placeholders (currently minimal: status/assistant/error).
- `src/lib/review.ts`
  - Orchestrates initial and incremental reviews using OpenCode sessions instead of Codex threads.
  - Persists OpenCode session IDs and chosen model; handles warmup/partial turn logic as before.
  - Chat now sends a direct prompt through OpenCode (free-form, no critique schema).
- `src/lib/threads.ts`
  - Persists `{ sessionId, opencodeSessionId, model, lastReviewedTurnCount }` to `~/.sage/.../threads/`.
  - Legacy Codex metadata is ignored (treated as missing) to avoid crashes.
- `src/lib/settings.ts`
  - Allows `selectedModel` to be null and defaults to `openai/gpt-4o-mini` if unset.
- `src/lib/models.ts`
  - Defines `ModelOption`, `DEFAULT_MODEL`, and a fallback model list.
  - Adds `buildModelOptionsFromProviders` to convert OpenCode provider listings into picker options.
- `src/ui/App.tsx`
  - Removes Codex install/auth checks; instead, pings OpenCode on startup and optionally loads provider models for the settings screen.
  - Stores the active OpenCode session ID (shown in debug header) and passes it through review calls.
  - Queue/stream overlay/warmup handling remain the same; streaming events are currently limited.
- `src/ui/SettingsScreen.tsx`
  - Accepts dynamic model options; falls back to the static list when server discovery fails.
- `src/ui/StreamOverlay.tsx`
  - Simplified tags to `assistant/status/error` pending fuller OpenCode streaming.

## Flow changes
1) **Startup**
   - `getOpencodeClient` attempts to connect to `OPENCODE_URL` (default `http://localhost:4096`). If unavailable, Sage shows an error.
   - `listProviders` is called opportunistically to populate models; failures fall back to the static list.
2) **Initial review**
   - `getOrCreateOpencodeSession` ensures an OpenCode session per Claude session (resumes if metadata exists).
   - `runInitialReview` builds the structured prompt and sends it via `sendPrompt` with the selected `provider/model`.
   - Critique JSON is parsed (with salvage) and rendered; artifacts are written as before.
3) **Incremental review**
   - Uses the same OpenCode session; if metadata existed but no new turns, it short-circuits with a no-op message.
4) **Chat**
   - Sends a free-form prompt through the same OpenCode session (schema is bypassed intentionally).

## Error handling improvements
- OpenCode responses check `response.error` before attempting to parse parts.
- Connection errors surface a clear "start opencode" message.
- Critique parsing tries to extract JSON from wrapped prose to reduce hard failures.

## What stayed the same
- Claude hook integration, warmup filtering, partial turn handling, artifacts under `~/.sage/{project}/debug/`, and the FIFO review queue/UI layout.

## Known gaps / follow-ups
- **Streaming parity:** OpenCode SSE events aren’t yet mapped into the richer stream tags (reasoning/command/file/todo) that Codex provided. UI currently shows status/assistant/error only.
- **Model accuracy:** The fallback model IDs are placeholders; prefer server-discovered models via `config.providers()` to avoid invalid IDs.
- **Chat isolation:** Chat shares the review session; if provider models retain long context, consider a dedicated chat session.

## Quick setup reminder
- Run `opencode serve` (or set `OPENCODE_URL` to a running instance) before `npm start`.
- Set provider API keys in OpenCode (e.g., via `opencode auth login`); Sage will list available models when the server reports them.

