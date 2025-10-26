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
| **Session Discovery** | Lists sessions from SpecStory markdown exports in `.sage/history/`. Automatically filters warmup-only stubs. |
| **UI** | Ink TUI (`src/ui/App.tsx`) with structured critique cards, queue display, and real-time status. Shows project name in header. |
| **Export** | On launch Sage runs `specstory sync claude --output-dir .sage/history` (with `--no-version-check --silent`) to refresh markdown exports. |
| **Review Engine** | `src/lib/codex.ts` uses Codex SDK with JSON schema for structured output. Returns typed `CritiqueResponse` objects (verdict, why, alternatives, questions). |
| **Continuous Mode** | After initial review, file watcher detects new turns via Claude Code `Stop` hooks. Auto-syncs SpecStory and enqueues reviews (FIFO). |
| **UI Components** | `src/ui/CritiqueCard.tsx` renders structured critiques with symbols (✓ ⚠ ✗) and color-coded verdicts. Reviews stack vertically for scrollback. |
| **Debug Mode** | Set `SAGE_DEBUG=1` to bypass Codex calls, emit mock critiques, and archive prompts/context under `.debug/`. |

---

## 3. Architecture Overview

```
┌─ Initial Setup ─────────────────────────────────────────┐
│ SpecStory sync (src/lib/specstory.ts)                   │
│    └ writes markdown exports to .sage/history/          │
│                                                          │
│ Session listing (src/lib/specstory.ts)                  │
│    └ parses markdown, filters warmups                   │
│                                                          │
│ Session picker (src/ui/App.tsx)                         │
│    └ user selects session                               │
│                                                          │
│ Initial review (src/lib/review.ts)                      │
│    └ full context review via Codex SDK                  │
│                                                          │
│ Hook installation (src/lib/hooks.ts)                    │
│    └ auto-configures Claude Stop hook                   │
└──────────────────────────────────────────────────────────┘

┌─ Continuous Mode (after initial review) ────────────────┐
│ User prompts Claude → Claude finishes                    │
│    ↓                                                     │
│ Stop hook fires → specstory sync -s {sessionId}         │
│    ↓                                                     │
│ .sage/history/*.md updated                              │
│    ↓                                                     │
│ Chokidar file watcher detects change                    │
│    ↓                                                     │
│ Extract new turns (src/lib/markdown.ts)                 │
│    └ scan backwards to last signature                   │
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

- `src/lib/specstory.ts` — Wraps SpecStory sync and session discovery. Exports sessions to `.sage/history/` and parses markdown metadata, filtering warmup-only stubs.
- `src/lib/hooks.ts` — Auto-configures Claude Code `Stop` hook to trigger `specstory sync` on each turn completion.
- `src/ui/App.tsx` — Main TUI orchestrator. Manages session picker, file watcher (chokidar), FIFO queue, and continuous review state. Renders status and critique feed.
- `src/ui/CritiqueCard.tsx` — Structured critique renderer with symbol-coded verdicts and color-coded sections.
- `src/lib/markdown.ts` — Parses SpecStory markdown to extract all turns and compute turn signatures for incremental processing.
- `src/lib/review.ts` — Review orchestration layer. Handles initial review (full context) and incremental reviews (new turns only).
- `src/lib/codex.ts` — Codex SDK wrapper with JSON schema for structured output. Builds initial and follow-up prompts, manages thread lifecycle.

---

## 4. External Dependencies & Environment Assumptions

1. **SpecStory CLI** (`specstory`) must be on PATH. Sage calls `specstory sync claude --output-dir .sage/history --no-version-check --silent`. Make sure users install ≥0.12.0 (older versions used `-u`).
2. **OpenAI Codex SDK** (`@openai/codex-sdk`) handles review generation. It talks to the local Codex agent; no API key is set in this repo.
3. **Ink / React** render the TUI. Components rely on Node 18+.
4. **Claude log format** is assumed to stay JSONL with `type`, `sessionId`, `message.{role,content}`, `summary`, and optional prompt caching warmups.

---

## 5. Warmup & Resume Behavior

- Claude injects `Warmup` user turns to prime prompt caching. These appear as sidechain user entries with no follow-up. Sage treats any session whose **only** main user prompt is “Warmup” (case-insensitive) as a warmup stub (`isWarmup === true`) and hides it from the picker.
- Resuming a session (`claude --resume`) creates a **new JSONL** with a new `sessionId`, but SpecStory exports the entire conversation under the **original** session ID. For now, Sage expects users to select the parent session when reviewing a resumed conversation. (Future work: automatically detect and chase the resume parent if an export is warmup-only.)

---

## 6. Running Sage (developer workflow)

1. Ensure SpecStory and the Codex agent are running locally.
2. From the repo root, run `npm start` (or `tsx src/index.tsx`).
3. Sage shows an Ink TUI with session picker:
   - Arrow keys to navigate sessions.
   - `Enter` to select a session for review.
   - `R` to refresh session list (re-run SpecStory sync).
4. After selection, Sage performs initial review and enters continuous mode:
   - Status line shows `⏵ Running initial review...` during setup
   - Automatically installs Claude Code `Stop` hook if not present
   - Starts watching the session's markdown file for new turns
5. As you continue with Claude Code, Sage automatically reviews new turns:
   - New turns are queued (FIFO) and displayed with prompt previews
   - Status shows `⏵ Reviewing "..."` with queue count
   - Completed critiques stack vertically (scroll terminal to see history)
6. Each critique card displays:
   - Symbol-coded verdict: ✓ Approved | ⚠ Concerns | ✗ Critical Issues
   - WHY section (color-coded: green/yellow/red)
   - ALTERNATIVES section (if applicable)
   - QUESTIONS section (if applicable)
7. Keyboard controls in continuous mode:
   - `M` to manually trigger SpecStory sync (useful when hook doesn't fire or for testing)
   - `B` to exit and return to session picker

---

## 7. Guidelines for Coding Agents

**Do this:**

- Keep Sage **read-only**. Don't add write or execute permissions to Codex threads.
- Maintain prompt clarity: any new Codex prompts must emphasize repo inspection, correctness, and admitting uncertainty.
- Use **structured output schemas** for Codex responses. All fields must be in the `required` array (OpenAI constraint). Instruct Codex to return empty strings for optional sections.
- Respect the warmup filter—don't reintroduce warmup-only sessions into the picker unless you add an explicit toggle.
- When touching session parsing, account for resume forks and unusual content; tolerant parsers prevent crashing on new Claude schema changes.
- Update docs (`what-is-sage.md`, `agents.md`, troubleshooting notes) whenever behavior or CLI flags change.

**Avoid this:**

- Don’t rely on undocumented SpecStory flags. Stick to `specstory sync claude --output-dir …`.
- Don’t mutate `process.cwd()` or assume Codex will operate in a specific directory unless you pass the right context (future enhancement).
- Avoid duplicating exports. If you need additional metadata from Claude logs, extend the parser rather than shelling out multiple times.
- Don’t silently swallow errors from SpecStory or Codex; surface meaningful messages in the UI.

---

## 8. Known Limitations & TODOs

- **Resume chains:** Sage doesn't yet hop from a resumed session ID back to the parent export. Warmup-only exports during resumes still require manual selection of the original session.
- **Critique history navigation:** Reviews stack vertically for scrollback but no arrow-key navigation within the UI. Users scroll their terminal to see previous reviews.
- **Read-only enforcement:** Codex threads currently rely on context instructions; explicit permission settings (if supported by the SDK) would enhance safety.
- **Comprehensive logging:** Minimal debug output goes to the console; consider writing a log file for diagnosing SpecStory or Codex failures.

---

## 9. Quick Reference

| Task | Command / File |
| --- | --- |
| Start Sage TUI | `npm start` or `tsx src/index.tsx` |
| TypeScript build check | `npm run build` |
| Session discovery & listing | `src/lib/specstory.ts` |
| Hook auto-installation | `src/lib/hooks.ts` |
| Codex prompt builder & schemas | `src/lib/codex.ts` |
| Review orchestration | `src/lib/review.ts` |
| Critique card component | `src/ui/CritiqueCard.tsx` |
| Manual SpecStory export | `specstory sync claude --output-dir .sage/history` |

---

## 10. Debug Mode

- **Purpose:** Quickly validate end-to-end plumbing without waiting on the Codex agent. Useful when the SDK is unavailable, when working offline, or when you just need to inspect the exact prompt/context Sage would send.
- **Activation:** Export `SAGE_DEBUG` with any truthy value (`1`, `true`, `yes`, `on`) before launching Sage. Leave it unset to run normally.
- **Behavior:** Initial and incremental reviews skip Codex entirely, returning mock critiques stamped “Debug mode active”. Each critique surfaces the session ID, SpecStory markdown file, and the filesystem path to a captured prompt/context artifact.
- **Artifacts:** Sage writes prompt instructions plus the raw conversation/context to `.debug/review-<prompt>.txt`. Filenames are sanitized and deduplicated. The directory is ignored by git.
- **UI Indicators:** The status pane shows `Debug mode active — Codex agent bypassed`. Critique cards echo the same message and include the prompt text so you can confirm the exact instructions without opening the artifact.
- **Cleanup:** Remove the `.debug/` folder or individual files when you no longer need them. They are ignored by version control but can accumulate quickly during rapid iteration.

---

Keep this guide up to date as the architecture evolves—future contributors (human or agent) should be able to read it and immediately understand the system’s intent, boundaries, and extension points. Happy reviewing! 🎩
