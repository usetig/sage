import { Codex } from '@openai/codex-sdk';

export interface ReviewContext {
  sessionId: string;
  markdown: string;
  latestTurnSummary?: {
    user: string;
    agent?: string;
  };
}

const singleton = new Codex();

export async function runOneShotReview(context: ReviewContext): Promise<string> {
  const thread = singleton.startThread();
  const prompt = buildPrompt(context);
  const result = await thread.run(prompt);
  return extractText(result).trim();
}

function buildPrompt({ sessionId, markdown, latestTurnSummary }: ReviewContext): string {
  const latestTurnSection = latestTurnSummary
    ? `Latest Claude turn:\nUser prompt:\n${latestTurnSummary.user}\n\nClaude response:\n${latestTurnSummary.agent ?? '(Claude has not responded yet)'}\n`
    : 'Latest Claude turn could not be determined from the export.\n';

  return [
    'You are Sage, a meticulous AI code reviewer that evaluates Claude Code sessions.',
    'Your goal is to deliver a critique card with these sections: Verdict, Why, Alternatives (optional), Questions (optional).',
    'Focus on correctness issues, missing steps, risky assumptions, and suggest practical next actions for the developer.',
    'Before critiquing, gather context on the repository yourself: list the root directory, inspect key config files (package.json, README.md, tsconfig.json, etc.), and skim any implementation files referenced in the conversation.',
    'Summarize what you learn about the project structure in your critique so the developer sees you grounded the review in their codebase.',
    'Be concise but specific. Point to files/functions when relevant. Admit uncertainty when needed.',
    '',
    `Session ID: ${sessionId}`,
    latestTurnSection,
    'Full conversation transcript follows between <conversation> tags. Use it to ground your critique.',
    '<conversation>',
    markdown.trim(),
    '</conversation>',
  ].join('\n');
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result;

  if (result && typeof result === 'object') {
    if ('finalResponse' in result && typeof (result as { finalResponse?: unknown }).finalResponse === 'string') {
      return (result as { finalResponse: string }).finalResponse;
    }

    const candidate = (result as { text?: unknown }).text;
    if (typeof candidate === 'string') return candidate;

    if (Array.isArray((result as { items?: unknown }).items)) {
      const items = (result as { items: Array<{ text?: string }> }).items;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const text = items[i]?.text;
        if (typeof text === 'string' && text.trim()) return text;
      }
    }

    if (Array.isArray((result as { messages?: unknown }).messages)) {
      const messages = (result as { messages: Array<{ role: string; content: string }> }).messages;
      const last = messages[messages.length - 1];
      if (last && typeof last.content === 'string') return last.content;
    }
  }

  return String(result ?? '');
}
