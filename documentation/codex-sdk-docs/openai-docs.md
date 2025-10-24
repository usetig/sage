e.js v18.

Installation

To get started, install the Codex SDK using npm:

npm install @openai/codex-sdk
Usage

Start a thread with Codex and run it with your prompt.

import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run(
  "Make a plan to diagnose and fix the CI failures"
);

console.log(result);
Call run() again to continue on the same thread, or resume a past thread by providing a threadID.

// running the same thread
const result = await thread.run("Implement the plan");

console.log(result);

// resuming past thread

const thread2 = codex.resumeThread(threadId);
const result2 = await thread.run("Pick up where you left off");

console.log(result2);
For more details, check out the TypeScript repo.

Using Codex CLI programmatically

Aside from the library, you can also use the Codex CLI in a programmatic way using the exec command.

This way you can give Codex instructions on what to do and let Codex handle the rest without ending up in an interactive session.

For example, you could have Codex programatically find any left-over TODOs and create plans for them for future work.

codex exec "find any remaining TODOs and create for each TODO a detailed implementation plan markdown file in the .plans/ directory."
GitHub Action

With the Codex Exec GitHub Action, you can run Codex with codex exec in your GitHub Actions workflows with tight control over privileges available to Codex.

Learn how to use it with this guide on autofixing CI failures and check out the repo here.