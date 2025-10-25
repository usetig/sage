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
| **Session Discovery** | Reads Claude JSONL logs under `~/.claude/projects/**`. Ignores prompt-caching “Warmup” stubs. |
| **UI** | Ink TUI (`src/ui/App.tsx`) lists non-warmup sessions from the current repo, handles selection, refresh, and progress logging. |
| **Export** | On launch Sage runs `specstory sync claude --output-dir .sage/history` (with `--no-version-check --silent`) to refresh markdown exports. |
| **Review Engine** | `src/lib/codex.ts` spins up an OpenAI Codex thread, sends the transcript, and expects a structured critique (verdict, why, alternatives, questions). |
| **Repo Context** | Codex prompt instructs the model to study the repo (package.json, tsconfig, key sources) before judging the session. |
| **Progress Reporting** | During review, Sage now prints the markdown path and latest user prompt before asking Codex for a critique. |

---

## 3. Architecture Overview

```
SpecStory sync (src/lib/specstory.ts)
                   │   └ writes markdown exports to .sage/history/
                   ▼
            Session listing (src/lib/specstory.ts)
                   │   └ parses markdown headers, skips warmups
                   ▼
               Ink TUI (src/ui/App.tsx)
                   │   └ user picks a session and sees progress logs
                   ▼
         Transcript parsing (src/lib/markdown.ts)
                   │   └ extracts latest turn for debugging + prompt context
                   ▼
      Codex review orchestrator (src/lib/review.ts)
                   │   └ logs markdown path & prompt, calls runOneShotReview
                   ▼
         Codex SDK (src/lib/codex.ts)
                   │   └ builds critique prompt, returns verdict
                   ▼
              Ink TUI renders critique card
```

**Key modules and responsibilities:**

- `src/lib/specstory.ts` — Wraps SpecStory sync (`specstory sync claude --output-dir .sage/history`) and parses the generated markdown into session metadata, skipping warmups.
- `src/ui/App.tsx` — Handles lifecycle: loading sessions, filtering warmups, rendering the picker, running reviews, and showing progress + results.
- `src/lib/markdown.ts` — Utility to extract the latest user + assistant turn from the exported markdown.
- `src/lib/review.ts` — Orchestrates the review flow: read SpecStory markdown, log debug info, call Codex, and return the critique.
- `src/lib/codex.ts` — Thin Codex SDK wrapper that constructs the prompt (with repo-summary instructions) and extracts the final response text.

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
3. Sage shows an Ink TUI:
   - Arrow keys to change selection.
   - `Enter` to review a session.
   - `R` to refresh session list (re-run SpecStory sync and rebuild the list).
   - `B` to go back from the results view.
4. During review Sage prints:
   - `Reading SpecStory markdown…`
   - `Latest user prompt: …`
   - `Markdown export: …`
   - `Requesting Codex critique…`
5. The resulting critique card lists the verdict, rationale, alternatives, and questions.

---

## 7. Guidelines for Coding Agents

**Do this:**

- Keep Sage **read-only**. Don’t add write or execute permissions to Codex threads.
- Maintain prompt clarity: any new Codex prompts must emphasize repo inspection, correctness, and admitting uncertainty.
- Respect the warmup filter—don’t reintroduce warmup-only sessions into the picker unless you add an explicit toggle.
- When touching session parsing, account for resume forks and unusual content; tolerant parsers prevent crashing on new Claude schema changes.
- Update docs (`what-is-sage.md`, `agents.md`, troubleshooting notes) whenever behavior or CLI flags change.

**Avoid this:**

- Don’t rely on undocumented SpecStory flags. Stick to `specstory sync claude --output-dir …`.
- Don’t mutate `process.cwd()` or assume Codex will operate in a specific directory unless you pass the right context (future enhancement).
- Avoid duplicating exports. If you need additional metadata from Claude logs, extend the parser rather than shelling out multiple times.
- Don’t silently swallow errors from SpecStory or Codex; surface meaningful messages in the UI.

---

## 8. Known Limitations & TODOs

- **Resume chains:** Sage doesn’t yet hop from a resumed session ID back to the parent export. Warmup-only exports during resumes still require manual selection of the original session.
- **Continuous reviews:** Only one-shot manual reviews are supported. Hooks for streaming/automatic critiques are planned.
- **Read-only enforcement:** Codex threads currently rely on context instructions; explicit permission settings (if supported by the SDK) would enhance safety.
- **Comprehensive logging:** Minimal debug output goes to the console; consider writing a log file for diagnosing SpecStory or Codex failures.

---

## 9. Quick Reference

| Task | Command / File |
| --- | --- |
| Start Sage TUI | `npm start` or `tsx src/index.tsx` |
| TypeScript build check | `npm run build` |
| Session filtering logic | `src/lib/claudeSessions.ts` |
| SpecStory wrapper | `src/lib/specstory.ts` |
| Codex prompt builder | `src/lib/codex.ts` |
| Manual SpecStory export | `specstory sync claude --output-dir .sage/history` |

---

Keep this guide up to date as the architecture evolves—future contributors (human or agent) should be able to read it and immediately understand the system’s intent, boundaries, and extension points. Happy reviewing! 🎩
