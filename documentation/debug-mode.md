# Sage Debug Mode

Debug mode lets you exercise Sage’s SpecStory plumbing, watcher, and UI without talking to the Codex agent. Instead of waiting on Codex responses, Sage returns deterministic mock critiques and stores the full prompt/context so you can inspect exactly what would have been sent.

## When to use it

- Developing Sage while the Codex agent is offline or misconfigured.
- Tracing the prompts Sage generates for a conversation without triggering a real review.
- Capturing regression fixtures for end-to-end tests or demos.

## Enabling debug mode

Export `SAGE_DEBUG` with any truthy value before starting the CLI:

```bash
SAGE_DEBUG=1 npm start
# or
SAGE_DEBUG=true tsx src/index.tsx
```

Unset the variable (or set it to `0`/`false`) to resume normal Codex-backed reviews.

## What changes in debug mode

1. **Codex calls are skipped**
   - `performInitialReview` and `performIncrementalReview` short-circuit before invoking the Codex SDK.
   - Reviews return an "Approved" verdict with a WHY section that clearly states debug mode is active.

2. **Prompt/context artifacts (Always Created)**
   - **Note:** As of recent updates, artifacts are created for **every review** regardless of whether debug mode is enabled. This allows you to always inspect what was sent to Codex.
   - Every review writes a file under `.debug/` named `review-<prompt>.txt`.
   - Filenames are derived from the user prompt (sanitized and deduplicated). If multiple reviews share a prompt, numeric suffixes are appended.
   - File contents begin with the exact prompt string Sage sends to Codex (including wrapper markers such as `<conversation>` or `<new_turns>`), followed by the separated instruction and context segments for quick scanning. Sub-agent `(sidechain)` turns are filtered out before writing so only the primary conversation appears.
   - The artifact path is displayed in the UI under "Review #x • ..." for all reviews.

3. **UI feedback changes**
   - Status messages read `Debug mode active — Codex agent bypassed` and list the session ID, the SpecStory markdown path, and the artifact location.
   - Critique cards echo the same messaging and include the prompt instructions for quick reference.

4. **Thread handling**
   - Because no Codex conversation is created, the stored thread reference is `null`. The queue worker tolerates this and continues to process jobs, maintaining deterministic output.

## Inspecting artifacts

The `.debug/` directory is created at the repository root the first time a debug review runs. Each artifact looks like this:

```
Full prompt payload (as sent to Codex):
You are Sage, a meticulous AI code reviewer…
<conversation>
<!-- Claude Code Session ... -->
...

Prompt instructions segment:
You are Sage, a meticulous AI code reviewer…

Context segment:
<!-- Claude Code Session ... -->
...
```

Open the file to see the precise payload Sage sent (or would have sent) to Codex. These artifacts are ignored by git (`.debug/` is listed in `.gitignore`). Remove the directory when it's no longer needed.

## Notes and caveats

- **Artifacts are always created:** As of recent updates, debug artifacts are written for every review, not just in debug mode. This lets you inspect Codex prompts even during normal operation.
- Debug mode does **not** simulate Codex reasoning; it only confirms the scaffolding around prompt generation and queue handling.
- Continuous mode still watches SpecStory exports and enqueues reviews. You can confirm watcher behavior without hitting external services.
- Because critiques in debug mode always return "Approved", downstream tooling should treat debug runs as non-authoritative.

Use debug mode to iterate faster when Codex isn't available, then disable it to validate Sage's real review pipeline. Use the artifact files in either mode to inspect the exact prompts and context being sent to Codex.
