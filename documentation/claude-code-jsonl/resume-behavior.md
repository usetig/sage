# Claude Code JSONL & `--resume` Behavior — A Practical Guide

> **Goal:** Explain why resuming a chat creates a new `.jsonl` file with a new session ID, yet the picker still shows a *single* conversation; and provide robust ways to work with, list, and stitch these logs in scripts.

---

## TL;DR

* **Each `.jsonl` file = one *session*** (identified by the file name, a UUID).
* `claude --resume` typically **starts a new session** (new file, new UUID) and continues from the prior context.
* The **Resume Session UI** *groups/labels* sessions by project/branch and the latest **`summary`** title in the logs, so you often still see *one* entry even after a resume.
* There’s no documented, stable **cross-file conversation ID**. If you need to chain sessions, you must **derive** it (e.g., same project path + matching summary + close timestamps).

---

## 1) Where the logs live & what they look like

* Location (default): `~/.claude/projects/<project-slug>/<session-id>.jsonl`
* Format: **JSONL** (JSON Lines). Each line is a single event, e.g.:

  ```json
  { "type": "user", "timestamp": "2025-10-24T22:12:41Z", "sessionId": "<uuid>", "message": { "role": "user", "content": [ { "type": "text", "text": "Explain X" } ] } }
  { "type": "assistant", "timestamp": "2025-10-24T22:12:42Z", "sessionId": "<uuid>", "message": { "role": "assistant", "content": [ { "type": "text", "text": "Answer..." } ], "usage": { /* tokens, etc. */ } } }
  { "type": "summary", "timestamp": "2025-10-24T22:13:05Z", "sessionId": "<uuid>", "title": "quickly get context on this repo", "branch": "main" }
  ```
* Common `type` values you may see: `user`, `assistant`, `tool`, `tool_result`, `summary`, `system`, `notification` (exact fields can vary by version).
* **Sidechain transcripts:** Starting with Claude Code 2.0.24+ (confirmed in 2.0.28), delegated agents (Explore/Task/etc.) keep their own JSONL alongside the main session using the naming pattern `agent-<agentId>.jsonl`. Earlier builds (e.g., 2.0.13) embed those events directly in the session file. When crawling the directory, expect a mix depending on when the log was recorded.

> **Retention note:** Local cleanup may prune old transcripts after N days. If you need longer history, back up or increase retention in settings.

---

## 2) Why `--resume` makes a new file & new session ID

When you run `claude --resume` and pick a prior conversation, Claude loads that session’s context but **creates a *new* active session** for the subsequent turn(s). That means it writes new events to a **new `<new-uuid>.jsonl`** file.

Before appending fresh turns, Claude seeds that new file with the **entire prior transcript**. You’ll see the earlier user/assistant messages copied over—often retaining their original `sessionId`—followed by the new turns that use the new session UUID. The original file is left untouched, so now you have overlapping history across two files; any tooling should dedupe by `uuid` or timestamp when merging chains.

This can feel counterintuitive if you expect a single, continuous file. Think of it like Git commits across branches: the *history* is related, but each active editing session is its own append-only log (with the resume branch starting from a cloned baseline).

---

## 3) Why the picker still shows only *one* conversation

The **Resume Session** picker is a UI convenience that:

* Scans transcripts **within the same project/branch**.
* Uses the latest available **`summary`** lines as the human-facing title.
* De-duplicates appearance so you don’t see every resumed child session as a separate row.

As a result, even if `c343...fc4e.jsonl` (original) and `06b7...e6c1.jsonl` (resumed) both exist, the picker may still show **one row** labelled something like:

> *quickly get context on this repo*  · *N messages* · *main*

Because both sessions share the same **project/branch** and the **title** comes from (or is consistent with) the `summary` entries.

> **Quirk:** A fresh `--resume` may not emit a new `summary` line immediately. Until a new summary appears, the UI often reuses the last known title, reinforcing the impression of a single thread.

---

## 4) There is (currently) no official cross-file conversation ID

There isn’t a documented, stable identifier that says “these sessions belong to the same conversation” across files. If your scripts need this, you must **infer** linkage using heuristics:

**Heuristics that work well in practice**

1. **Directory:** Same `~/.claude/projects/<project-slug>/` path.
2. **Branch:** Same `branch` field in `summary` lines (if present), e.g., `main`.
3. **Title:** Same or very similar `summary.title` (normalized text).
4. **Temporal proximity:** The new session starts within a short window after the one you resumed from.
5. **Back-references (optional):** Some versions occasionally include fields that reproduce earlier IDs or context markers—treat these as hints, not guarantees.

You can combine these into a **derived chain key** (e.g., `sha1(project-path + normalized-title)`), then group sessions by that key.

---

## 5) Scripting recipes (macOS & Linux)

> These snippets are designed to be copy‑paste ready. They avoid hardcoding GNU/BSD quirks where possible.

### 5.1 List all sessions (newest first) with timestamp, session ID, project, path

```bash
#!/usr/bin/env bash
set -eo pipefail
PROJ_DIR="$HOME/.claude/projects"

# macOS (BSD) vs Linux (GNU) stat compatibility
mtime() { if stat -f %m "$1" >/dev/null 2>&1; then stat -f %m "$1"; else stat -c %Y "$1"; fi }

find "$PROJ_DIR" -type f -name '*.jsonl' -print0 \
| while IFS= read -r -d '' f; do
  sid="$(basename "$f" .jsonl)"
  project="$(basename "$(dirname "$f")")"
  ts="$(mtime "$f")"
  human_ts="$(date -r "$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$ts" '+%Y-%m-%d %H:%M:%S')"
  printf "%s\t%s\t%s\t%s\n" "$human_ts" "$sid" "$project" "$f"
done | sort -r | column -t -s $'\t'
```

### 5.2 Add a “title” column from the first user prompt (best‑effort)

```bash
#!/usr/bin/env bash
set -eo pipefail
PROJ_DIR="$HOME/.claude/projects"

find "$PROJ_DIR" -type f -name '*.jsonl' -print0 \
| while IFS= read -r -d '' f; do
  sid="$(basename "$f" .jsonl)"
  project="$(basename "$(dirname "$f")")"
  # Try first user message as a human-readable hint
  title="$(jq -r 'select(.type=="user") | (.message.content[0].text // .content // empty)' "$f" 2>/dev/null | head -n1 | tr '\t' ' ' | cut -c1-100)"
  ts=$( (stat -f %m "$f" 2>/dev/null || stat -c %Y "$f") )
  human_ts="$(date -r "$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$ts" '+%Y-%m-%d %H:%M:%S')"
  printf "%s\t%s\t%s\t%s\t%s\n" "$human_ts" "$sid" "$project" "$f" "$title"
done | sort -r | column -t -s $'\t'
```

### 5.3 Extract the latest `summary.title` for each session

```bash
#!/usr/bin/env bash
set -eo pipefail
PROJ_DIR="$HOME/.claude/projects"

for f in "$PROJ_DIR"/*/*.jsonl; do
  sid="$(basename "$f" .jsonl)"
  project="$(basename "$(dirname "$f")")"
  title=$(jq -r 'select(.type=="summary") | .title' "$f" 2>/dev/null | tail -n1)
  echo -e "$project\t$sid\t${title:-"(no summary yet)"}"
done | column -t -s $'\t'
```

### 5.4 Group sessions into conversation “chains” (derived key)

```bash
#!/usr/bin/env bash
set -eo pipefail
PROJ_DIR="$HOME/.claude/projects"

# Requires: jq and shasum (macOS) or sha1sum (Linux)
sha() { command -v shasum >/dev/null && shasum | awk '{print $1}' || sha1sum | awk '{print $1}'; }

while IFS= read -r -d '' f; do
  project="$(basename "$(dirname "$f")")"
  title=$(jq -r 'select(.type=="summary") | .title' "$f" 2>/dev/null | tail -n1)
  branch=$(jq -r 'select(.type=="summary") | .branch' "$f" 2>/dev/null | tail -n1)
  key=$(printf "%s\n" "$project|${branch:-main}|${title:-untitled}" | sed 's/\s\+/ /g' | tr '[:upper:]' '[:lower:]' | sha)
  sid="$(basename "$f" .jsonl)"
  echo -e "$key\t$project\t${branch:-main}\t${title:-untitled}\t$sid\t$f"
done < <(find "$PROJ_DIR" -type f -name '*.jsonl' -print0) \
| sort -k1,1 -k6,6 \
| column -t -s $'\t'
```

This prints a **chain key** plus the sessions that belong to that chain by shared project/branch/title.

### 5.5 Merge a conversation chain into one JSONL (for analysis/archive)

```bash
# Example: merge two known sessions into one stream, ordered by timestamp
jq -s 'flatten | sort_by(.timestamp // 0)' \
  ~/.claude/projects/<proj>/c3432222-f797-4573-9163-99fe68d9fc4e.jsonl \
  ~/.claude/projects/<proj>/06b7d565-88ec-4f13-9b43-e513ed80e6c1.jsonl \
| jq -c '.[]' > merged.jsonl
```

### 5.6 Resume headlessly by ID (from a script)

```bash
sid="<session-id>"
claude -p --resume "$sid" "Run the next step non-interactively"
```

---

## 6) Practical workflow suggestions

* **Index on session start:** Add a lightweight hook that appends `{session_id, transcript_path, cwd, ts}` to `~/.claude/sessions.jsonl`. That becomes your authoritative, append-only index.
* **Back up regularly:** Mirror `~/.claude/projects` to a private repo/bucket if these logs matter.
* **Normalize titles:** Titles may change (summaries update). Keep the latest title per chain for display, but preserve historical titles for auditability.
* **Be summary-agnostic:** If a session lacks `summary` lines, fall back to first `user` message as a title.

---

## 7) Gotchas & quirks to watch for

* **New session on resume:** Expect a new file/UUID; don’t assume appends to the original.
* **Delayed summaries:** You might not see an immediate `summary` in a fresh resumed file; the UI may still show the older title.
* **Inconsistent markers:** Some event types can carry fields that look like prior identifiers—use them as hints only.
* **Retention/cleanup:** Local cleanup can remove older sessions, breaking naive chains—archive proactively if needed.
* **Cross-machine ambiguity:** If you move logs between machines, project slugs/paths can differ; include the absolute `transcript_path` in your chain key when aggregating across hosts.
* **Agent transcripts vs. inline logs:** Scripts written before 2.0.24 should either glob for `agent-*.jsonl` or fall back gracefully—newer runs emit them per agent, while historical directories may not contain any.
* **Resume duplication:** Since resumed files include a copy of prior turns, expect duplicate `uuid` values between the old and new transcripts; dedupe before replaying events or computing diffs.

---

## 8) FAQ

**Q: Why don’t I see two entries in the Resume picker after resuming?**
A: The picker groups by project/branch and uses the most recent title from `summary` lines; resumed sessions usually appear as the same conversation.

**Q: Is there an official way to list sessions non‑interactively?**
A: Not as a single CLI command; enumerate `~/.claude/projects/**.jsonl` and parse as shown above, or log session starts via a hook.

**Q: Can I stitch logs so they look like a single conversation?**
A: Yes—either merge them with `jq` (see §5.5) or build a reader that streams multiple session files in chronological order.

**Q: How do I choose the right session for headless `--resume`?**
A: Use the listing scripts in §5.1/§5.2 to sort by time and display a hint (title/first prompt); then pass the chosen ID to `claude -p --resume`.

---

## 9) Minimal schema reference (observed fields)

> Field presence may vary; treat this as a *practical* rather than canonical schema.

* `type`: `user` | `assistant` | `tool` | `tool_result` | `summary` | `system` | `notification`
* `timestamp`: ISO 8601 or epoch-like strings
* `sessionId`: UUID string; matches the filename for that session’s events
* `message`: `{ role, content[], usage? }`

  * `content[]`: `[{ type: "text"|"tool_use"|..., text?: string, ...}]`
  * `usage`: token counts, etc. (assistant messages)
* `summary`: `{ title, branch?, other display fields }` (present when `type == "summary"`)
* Other context fields may include `cwd`, `version`, `requestId`, etc.

---

## 10) Next steps

* If you share two example `.jsonl` files, we can run a quick parser to:

  1. Show their latest `summary.title`/`branch`,
  2. Confirm their `sessionId`s, and
  3. Demonstrate a merged, chronologically ordered stream for your archives.

*This guide is based on observed behavior across multiple installations of Claude Code and is intended to be robust to minor schema variations.*
