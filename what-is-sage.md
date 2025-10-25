# Sage (Reviewer Agent) — Brief Spec using **OpenAI Codex SDK**

## Problem this solves

Coding agents (Claude Code) can sound confident while being wrong or incomplete. Today, you manually copy the Claude conversation into another assistant (e.g., Cursor/GPT) to cross-check the plan—breaking flow and losing repo context. **Sage** automates that second-opinion pass *in place*, grounded in your codebase, with no extra user commands.

---

## User story (primary flow)

**As a developer using Claude Code**

- I run `sage` in my terminal and choose the Claude session I’m working in.
- While I continue interacting with **Claude Code**, **Sage** silently reads the same conversation + relevant files and **thinks deeply** about the agent’s reasoning and proposed changes.
- **Sage** posts concise critique cards (verdict, why, alternatives, questions) in its terminal. I don’t have to trigger it.
- If I send new prompts to Claude before Sage finishes, **Sage queues** new turns and reviews them in order.
- (Future) I can ask Sage follow-ups in its terminal to dig deeper or request a more comprehensive review.

**Acceptance criteria**

- Zero extra commands during normal dev loop.
- Reviews are grounded in the current repo (read-only) and the live Claude conversation.
- If Sage is busy, new turns are queued; nothing is dropped.
- Sage never writes files or runs shell by default.

---

## v0 CLI status

- `sage` launches a TUI that lists Claude Code sessions discovered under `~/.claude/projects/**`. Use the arrow keys to pick one for review.
- On launch, Sage runs `specstory sync claude --output-dir .sage/history --no-version-check --silent` to refresh markdown exports; the picker reads directly from `.sage/history` and reuses those files when reviewing.
- Sage automatically writes a Claude `Stop` hook to `.claude/settings.local.json` so every Claude response re-runs the SpecStory sync without manual setup.
- Warmup-only sessions (where Claude injects the initial “Warmup” prompt for prompt caching) are hidden from the picker so Sage reviews the first meaningful user request.
- Requirements: SpecStory CLI installed on the PATH, valid Codex credentials, and prior Claude activity in the repository.
- Continuous hooks and incremental reviews remain TODO; the current build handles one-shot critiques per selection.

---

## Roles

- **Primary agent:** **Claude Code** (the tool the user actively chats with).
- **Reviewer agent:** **Sage** (runs via **OpenAI Codex SDK** in **read-only** mode).

---

## What you want (mapped to v0)

- `sage` starts a local **Sage session** (TUI).
- Prompt to **choose a Claude Code conversation** to watch.
- After selection, Sage **reads the conversation** and **any relevant code**.
    - **Implementation:** read the local Claude conversation **JSON** (session log) to reconstruct prompts/responses and file references.
- As you prompt Claude, Sage **automatically reviews** new prompts, responses, and proposed code changes—**no extra commands**.
    - **Implementation:** either **Claude Code hooks** or **file-watch** on the session JSON to ingest new turns.
- **Sage is a fully fledged agent** (via Codex SDK, **read-only**): it can read code files and make **tool calls** (e.g., web search) while thinking.
- **Queueing:** if a new primary prompt/response arrives while Sage is still reviewing, it’s **enqueued** and processed FIFO.
- **(Future)** a chat inside the Sage terminal for follow-ups / deeper audits.

---

### Sequence (happy path)

1. User runs `sage` → picks a **Claude session**.
2. **Deep Start Read** (one-time) builds a quick repo map; prints an Architecture Brief.
3. User prompts Claude → hook/file-watch emits **TurnEvent** → enqueued.
4. Orchestrator pops event → instructs **Codex (read-only)** to read needed files and think hard → returns critique.
5. TUI displays the **Critique Card**.
6. If new turns arrive mid-review, they queue and execute next.

---

### Notes

- This spec assumes **Claude Code is the primary agent**; **Sage only consumes** its events and repo, never modifies files.
