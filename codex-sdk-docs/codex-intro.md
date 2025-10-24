

Here’s the quick take on the **Codex TypeScript SDK** and how to use it.

### What it is

The Codex TypeScript SDK lets you **programmatically control a local Codex agent** from Node.js—same agent behind Codex CLI/IDE/Web—so you can embed it in apps, CI/CD, or internal tools. It’s designed for **server-side** use and requires **Node 18+**. ([OpenAI Developers][1])

### Why you’d use it

* Automate engineering workflows (PR review helpers, CI fixes, code maintenance) without opening an interactive TUI. ([OpenAI][2])
* Build your own agent that talks to Codex (e.g., trigger tasks from Slack, bots, or web apps). ([OpenAI Developers][1])

### Install

```bash
npm install @openai/codex-sdk
```

(Official package name from the docs.) ([OpenAI Developers][1])

### Minimal usage

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();

const result1 = await thread.run("Make a plan to diagnose and fix the CI failures");
console.log(result1);

// continue same session
const result2 = await thread.run("Implement the plan");
console.log(result2);

// or resume by thread ID later
const thread2 = codex.resumeThread(threadId);
const result3 = await thread2.run("Pick up where you left off");
console.log(result3);
```

This “thread → run → resume” flow is the core pattern. ([OpenAI Developers][1])

### How it works under the hood

The SDK is a **comprehensive way to control Codex** from code; it’s intended for server-side use and complements other options (CLI or GitHub Action). In practice, you’ll start threads and issue runs, and Codex handles the local agent lifecycle for you. ([OpenAI Developers][1])

### Alternatives & when to pick them

* **Codex CLI (programmatic):** call `codex exec "…"` for one-off tasks without writing much code. Good for scripting and CI. ([OpenAI Developers][1])
* **GitHub Action:** run Codex in workflows with fine-grained permissions (great for CI autofix pipelines). ([OpenAI Developers][1])
* **Agents SDK + MCP:** expose Codex as an **MCP server** and orchestrate multi-agent workflows (hand-offs, traces). Best when building larger agent systems. ([OpenAI Developers][3])

### Where it fits in the Codex family

Codex is one agent that runs in your terminal, IDE, cloud, and integrations; the SDK is the programmatic path for embedding it into your own systems and GitHub automations. ([OpenAI][2])

If you’d like, I can sketch a tiny starter service (Express job that accepts a prompt and returns Codex output), or show how to wire it into a GitHub Action for CI repair.

[1]: https://developers.openai.com/codex/sdk/ "Codex SDK"
[2]: https://openai.com/codex/ "Codex | OpenAI"
[3]: https://developers.openai.com/codex/guides/agents-sdk/ "Use Codex with the Agents SDK"
