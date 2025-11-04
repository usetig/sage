# Sage Agents Guide

This document gives any coding agent the context it needs to contribute safely and effectively to the **Sage** project. It covers the problem Sage solves, the current implementation, tooling constraints, and the operational guardrails you must respect when extending the system.

---

## 1. Project Intent

- **Problem Statement:** Developers rely on Claude Code as their primary assistant, but they often want an automated second opinion. Manually copying conversations into another LLM breaks flow and loses repo context. Sage steps in as a **passive reviewer**: it mirrors a Claude session, reads the same repo, and produces critique cards without user intervention.
- **End Goal (v0):** Let the user run `sage`, pick a Claude session, and receive a Codex-powered critique of that session’s latest turn. Reviews must be read-only, grounded in the repo, and require zero extra commands in the developer workflow.
- **Future direction:** Continuous hooks (streaming reviews as new turns arrive), richer follow-up conversations with Sage, and smarter resume handling across session forks.

---

## 2. Current Capabilities

| Area | Status |
| --- | --- |
| **Session Discovery** | Lists sessions from hook-emitted metadata in `.sage/runtime/sessions/`. Automatically filters warmup-only stubs. |
| **UI** | Ink TUI (`src/ui/App.tsx`) with structured critique cards, queue display, and real-time status. Shows project name in header. |
| **Export** | Claude hooks write per-session metadata and review signals into `.sage/runtime/` (no external CLI required). |
| **Review Engine** | `src/lib/codex.ts` uses Codex SDK with JSON schema for structured output. `src/lib/jsonl.ts` parses Claude JSONL logs (primary turns only). Returns typed `CritiqueResponse` objects (verdict, why, alternatives, questions, and optional message_for_agent for non-approved verdicts). |
| **Continuous Mode** | After initial review, Sage watches `.sage/runtime/needs-review/` for hook signals and enqueues reviews (FIFO). |
| **UI Components** | `src/ui/CritiqueCard.tsx` renders structured critiques with symbols (✓ ⚠ ✗) and color-coded verdicts. Reviews stack vertically for scrollback. |
| **Debug Mode** | Prompts/context are always archived under `.debug/`. Set `SAGE_DEBUG=1` to bypass Codex calls and emit mock critiques. |

---

## 3. Architecture Overview

```
┌─ Initial Setup ─────────────────────────────────────────┐
│ Hook installer (src/scripts/configureHooks.ts)          │
│    └ registers SessionStart/End/Stop/UserPromptSubmit   │
│                                                          │
│ Hook shim (src/hooks/sageHook.ts)                       │
│    └ writes .sage/runtime/sessions/*.json               │
│                                                          │
│ Session picker (src/ui/App.tsx)                         │
│    └ user selects session                               │
│                                                          │
│ Initial review (src/lib/review.ts + jsonl.ts)           │
│    └ loads transcript JSONL + runs Codex review         │
└──────────────────────────────────────────────────────────┘

┌─ Continuous Mode (after initial review) ────────────────┐
│ User prompts Claude → Stop hook fires                    │
│    ↓                                                     │
│ Hook shim writes .sage/runtime/needs-review/{sessionId} │
│    ↓                                                     │
│ App.tsx watcher notices new signal                      │
│    ↓                                                     │
│ extractTurns(jsonl) for new assistant response          │
│    ↓                                                     │
│ Enqueue review job (FIFO queue in App.tsx)              │
│    ↓                                                     │
│ Incremental review (src/lib/review.ts)                  │
│    └ reuses existing Codex thread                       │
│    ↓                                                     │
│ Codex SDK (src/lib/codex.ts)                            │
│    └ structured JSON output via schema                  │
│    ↓                                                     │
│ CritiqueCard component (src/ui/CritiqueCard.tsx)        │
│    └ renders structured critique with symbols           │
└──────────────────────────────────────────────────────────┘
```

**Key modules and responsibilities:**

- `src/hooks/sageHook.ts` — Receives Claude Code hook payloads (SessionStart/End/Stop/UserPromptSubmit). Writes per-session metadata to `.sage/runtime/sessions/` and queues review signals in `.sage/runtime/needs-review/`.
- `src/scripts/configureHooks.ts` — CLI helper (`npm run configure-hooks`) that installs the Sage hook command into `.claude/settings.local.json`.
- `src/lib/jsonl.ts` — Streams Claude JSONL transcripts, filters warmups/compactions, and extracts user⇄assistant turns.
- `src/lib/review.ts` — Review orchestration layer. Handles initial and incremental critiques, stores thread metadata, and manages debug artifacts.
- `src/lib/codex.ts` — Codex SDK wrapper with JSON schema for structured output. Builds initial and follow-up prompts, manages thread lifecycle.
- `src/ui/App.tsx` — Main TUI orchestrator. Manages session picker, signal watcher (chokidar), FIFO queue, continuous review state, and clarification threads.
- `src/ui/CritiqueCard.tsx` — Structured critique renderer with symbol-coded verdicts and color-coded sections.

---

## 4. External Dependencies & Environment Assumptions

1. **Claude Code 2.0.24+** — Required so delegated agent work is written to `agent-*.jsonl` files (modern log format Sage expects).
2. **OpenAI Codex SDK** (`@openai/codex-sdk`) handles review generation. It talks to the local Codex agent; no API key is set in this repo.
3. **Ink / React** render the TUI. Components rely on Node 18+.
4. **Claude JSONL logging** retains fields like `type`, `sessionId`, `message.{role,content}`, `summary`, and optional prompt caching warmups.

---

## 5. Warmup & Resume Behavior

- Claude injects `Warmup` user turns to prime prompt caching. These appear as sidechain user entries with no follow-up. Sage treats any session whose **only** main user prompt is “Warmup” (case-insensitive) as a warmup stub (`isWarmup === true`) and hides it from the picker.
- Resuming a session (`claude --resume`) clones the prior transcript into a **new JSONL** with a new `sessionId`, then appends fresh turns. Turn signatures (assistant UUIDs) are reused, so Sage relies on cached `lastTurnSignature` values to skip already-reviewed history.

---

## 6. Running Sage (developer workflow)

1. Ensure Claude Code and the Codex agent are running locally.
2. From the repo root, run `npm start` (or `tsx src/index.tsx`).
3. Sage shows an Ink TUI with session picker:
   - Arrow keys to navigate sessions.
   - `Enter` to select a session for review.
   - `R` to refresh session list (re-read `.sage/runtime/sessions/` metadata).
4. After selection, Sage performs initial review and enters continuous mode:
   - Status line shows `⏵ Running initial review...` during setup
   - Confirms Claude hooks are writing metadata to `.sage/runtime/`
   - Starts watching `.sage/runtime/needs-review/` for new signals
5. As you continue with Claude Code, Sage automatically reviews new turns:
   - New turns are queued (FIFO) and displayed with prompt previews
   - Status shows `⏵ Reviewing "..."` with queue count
   - Completed critiques stack vertically (scroll terminal to see history)
6. Each critique card displays:
   - Symbol-coded verdict: ✓ Approved | ⚠ Concerns | ✗ Critical Issues
   - WHY section (color-coded: green/yellow/red)
   - ALTERNATIVES section (if applicable)
   - QUESTIONS section (if applicable)
   - MESSAGE FOR CLAUDE CODE AGENT section (only for Concerns/Critical Issues verdicts, when Sage has specific guidance for Claude)
7. Keyboard controls in continuous mode:
   - `M` to rescan signal files (useful if a hook ran while Sage was closed)
   - `B` to exit and return to session picker
   - `Ctrl+O` to toggle the Codex activity stream overlay

---

## 7. Guidelines for Coding Agents

**Do this:**

- Keep Sage **read-only**. Don't add write or execute permissions to Codex threads.
- Maintain prompt clarity: any new Codex prompts must emphasize repo inspection, correctness, and admitting uncertainty.
- Use **structured output schemas** for Codex responses. All fields must be in the `required` array (OpenAI constraint). Instruct Codex to return empty strings for optional sections.
- Respect the warmup filter—don't reintroduce warmup-only sessions into the picker unless you add an explicit toggle.
- Preserve sidechain filtering in `extractTurns()`—only primary Claude/developer turns should enqueue reviews or reach Codex.
- When touching session parsing, account for resume forks and unusual content; tolerant parsers prevent crashing on new Claude schema changes.
- Update docs (`what-is-sage.md`, `agents.md`, troubleshooting notes) whenever behavior or CLI flags change.

**Avoid this:**

- Don’t mutate `process.cwd()` or assume Codex will operate in a specific directory unless you pass the right context (future enhancement).
- Avoid duplicating Claude JSONL parsing—extend `src/lib/jsonl.ts` if you need additional metadata.
- Don’t silently swallow errors from Codex or hooks; surface meaningful messages in the UI.

---

## 8. Known Limitations & TODOs

- **Resume chains:** Sage relies on cached assistant UUIDs to skip duplicated turns when Claude creates a new transcript on resume. More robust cross-file stitching is still future work.
- **Thread persistence:** ✅ Sage now saves Codex thread metadata to `.sage/threads/` and automatically resumes threads when re-selecting sessions. The `isFreshCritique` flag prevents duplicate critiques when resuming unchanged threads. This enables context preservation across Sage restarts and faster incremental reviews. See `documentation/thread-persistence.md` for details.
- **Incomplete responses on manual selection:** If you select a session while Claude is still typing, the initial review may process a partial response and potentially fail or produce inaccurate critique. Continuous mode is unaffected since the Stop hook only fires after Claude completes. Workaround: Wait for Claude to finish before selecting the session in Sage, or let continuous mode catch the complete response once it arrives.
- **Critique history navigation:** Reviews stack vertically for scrollback but no arrow-key navigation within the UI. Users scroll their terminal to see previous reviews.
- **Read-only enforcement:** Codex threads currently rely on context instructions; explicit permission settings (if supported by the SDK) would enhance safety.
- **Comprehensive logging:** Minimal debug output goes to the console; consider writing a log file for diagnosing hook or Codex failures.

---

## 9. Quick Reference

| Task | Command / File |
| --- | --- |
| Start Sage TUI | `npm start` or `tsx src/index.tsx` |
| TypeScript build check | `npm run build` |
| Session discovery & listing | `src/lib/jsonl.ts` |
| Hook auto-installation | `src/scripts/configureHooks.ts` |
| Codex prompt builder & schemas | `src/lib/codex.ts` |
| Review orchestration | `src/lib/review.ts` |
| Critique card component | `src/ui/CritiqueCard.tsx` |
| Hook shim | `src/hooks/sageHook.ts` |

---

## 10. Debug Mode & Artifacts

- **Artifacts (Always Created):** Sage now writes prompt instructions plus the raw conversation/context to `.debug/review-<prompt>.txt` for **every review**, regardless of debug mode. Filenames are sanitized and deduplicated. The directory is ignored by git. Each review card displays the artifact path underneath "Review #x • ..." so you can always inspect what was sent to Codex.
- **Debug Mode Purpose:** Quickly validate end-to-end plumbing without waiting on the Codex agent. Useful when the SDK is unavailable, when working offline, or when testing the review flow.
- **Activation:** Export `SAGE_DEBUG` with any truthy value (`1`, `true`, `yes`, `on`) before launching Sage. Leave it unset to run normally.
- **Behavior in Debug Mode:** Initial and incremental reviews skip Codex API calls entirely, returning mock critiques stamped "Debug mode active". The status pane shows `Debug mode active — Codex agent bypassed`. Artifacts are still created as usual.
- **UI Display:** Artifact paths are shown under "Review #x • ..." in all modes (both normal and debug). In debug mode, critique cards also include the prompt text inline for quick reference.
- **Cleanup:** Remove the `.debug/` folder or individual files when you no longer need them. They are ignored by version control but can accumulate quickly during rapid iteration.

---

Keep this guide up to date as the architecture evolves—future contributors (human or agent) should be able to read it and immediately understand the system’s intent, boundaries, and extension points. Happy reviewing! 🎩
