Short version: those “warmup” threads are **automatic sessions** Claude Code creates at the very start of a run (or after a resume) to **prime prompt-caching**. The app inserts a first user message literally named **“Warmup”** into a brand-new JSONL, and sometimes the UI mistakenly treats that as the session title—so you see a bunch of “Warmup” items even though they’re just initialization turns. ([GitHub][1])

### What they are

* In multiple reports (with JSONL excerpts), the **first line** in new session files is a user message whose `content` is `"Warmup"`. That’s written by Claude Code itself, not by you. ([GitHub][1])
* A separate community analysis notes this “Warmup” message exists to **initialize prompt caching**; their tooling saw Claude Code write it right when a session starts. ([GitHub][2])
* Anthropic’s docs/blogs explain **prompt caching** and that Claude Code **automatically enables** it; the AWS how-to even shows how to toggle it. This matches the behavior you’re seeing. ([Claude Docs][3])

### Why so many show up

* Each time you start or resume, Claude Code may open a **new session file** and run that warmup turn—some recent IDE builds also have a **bug** that replaces the visible title with “Warmup” or loads the wrong conversation, making the clutter more obvious. ([GitHub][4])
* As of Claude Code 2.0.24+ (confirmed in 2.0.28), delegated agents record their own transcripts (`agent-<id>.jsonl`). Those may also contain the initial “Warmup” exchange, so remember to exclude both the primary session file and any companion agent logs when filtering. Older builds (e.g., 2.0.13) store everything in the single session JSONL.

### Can you avoid or reduce them?

* If you’re OK losing the caching speedup, you can **disable prompt caching** before launching Claude Code:

  * bash/zsh: `export DISABLE_PROMPT_CACHING=1`
  * PowerShell: `$env:DISABLE_PROMPT_CACHING = "1"`
    Re-enable by unsetting it. (This is the only public toggle I’ve found.) ([Amazon Web Services, Inc.][5])
* Otherwise, keep caching on and **filter them out** in your scripts (e.g., ignore sessions whose *first* user message is exactly `Warmup`) or wait for IDE fixes—the “Warmup title” issues are being tracked upstream. ([GitHub][4])

### Handy filter for your listings

If you’re listing sessions with `jq`, exclude JSONLs where the **first user message** is `"Warmup"` (still keeps real chats that happen after a warmup turn):

```bash
# prints session IDs whose first user message != "Warmup"
for f in ~/.claude/projects/*/*.jsonl; do
  first_user=$(jq -r 'select(.type=="user") | .message.content // .content | if type=="array" then .[0].text else . end' "$f" | head -n1)
  if [ -n "$first_user" ] && [ "$(printf %s "$first_user" | tr '[:upper:]' '[:lower:]')" != "warmup" ]; then
    basename "$f" .jsonl
  fi
done
```

If you want, I can plug your two sample JSONLs into a tiny parser and show exactly which warmup lines they contain and how to group them away from your “real” conversations.

[1]: https://github.com/anthropics/claude-code/issues/9668 "Conversation history shows duplicate 'Warmup' titles and loads wrong conversations · Issue #9668 · anthropics/claude-code · GitHub"
[2]: https://github.com/winfunc/opcode/issues/393 "Session Display Issue: 'Warming Up' Messages and Safe Metadata Architecture · Issue #393 · winfunc/opcode · GitHub"
[3]: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching?%3Butm_campaign=airflow-in-action-apple&%3Butm_medium=web&amp=%3Fwtime%3Fwtime%3D%7Bseek_to_second_number%7D%3Fwtime%3D%7Bseek_to_second_number%7D%3Fwtime%3D%7Bseek_to_second_number%7D&amp%3Butm_campaign=modernizing-legacy-etl-workloads-with-airflow&amp%3Butm_medium=web&utm_campaign=Marketing&utm_medium=web&wtime=%7Bseek_to_second_number%7D&utm_source=chatgpt.com "Prompt caching - Claude Docs"
[4]: https://github.com/anthropics/claude-code/issues/9671 "[BUG] Claude Code VSCode extension - Sessions get titled \"Warmup\" and have first prompt replaced with \"Warmup\" · Issue #9671 · anthropics/claude-code · GitHub"
[5]: https://aws.amazon.com/blogs/machine-learning/supercharge-your-development-with-claude-code-and-amazon-bedrock-prompt-caching/ "Supercharge your development with Claude Code and Amazon Bedrock prompt caching | Artificial Intelligence"
