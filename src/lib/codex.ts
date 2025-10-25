import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';
import type { TurnSummary } from './markdown.js';

export interface InitialReviewContext {
  sessionId: string;
  markdown: string;
  latestTurnSummary?: {
    user: string;
    agent?: string;
  };
}

export interface FollowupReviewContext {
  sessionId: string;
  newTurns: TurnSummary[];
}

const singleton = new Codex();

export async function runInitialReview(
  context: InitialReviewContext,
): Promise<{ thread: Thread; critique: string }> {
  const thread = singleton.startThread();
  const prompt = buildInitialPrompt(context);
  const result = await thread.run(prompt);
  return {
    thread,
    critique: extractText(result).trim(),
  };
}

export async function runFollowupReview(thread: Thread, context: FollowupReviewContext): Promise<string> {
  const prompt = buildFollowupPrompt(context);
  const result = await thread.run(prompt);
  return extractText(result).trim();
}

function buildInitialPrompt({ sessionId, markdown, latestTurnSummary }: InitialReviewContext): string {
  const latestTurnSection = latestTurnSummary
    ? `Latest Claude turn:\nUser prompt:\n${latestTurnSummary.user}\n\nClaude response:\n${latestTurnSummary.agent ?? '(Claude has not responded yet)'}\n`
    : 'Latest Claude turn could not be determined from the export.\n';

  return [
    'You are Sage, a meticulous AI code reviewer that evaluates Claude Code sessions.',
    'Your goal is to deliver a critique card with these sections: Verdict, Why, Alternatives (optional), Questions (optional).',
    'Focus on correctness issues, missing steps, risky assumptions, and suggest practical next actions for the developer.',
    // 'Before critiquing, gather context on the repository yourself: list the root directory, inspect key config files (package.json, README.md, tsconfig.json, etc.), and skim any implementation files referenced in the conversation.',
    // 'Summarize what you learn about the project structure in your critique so the developer sees you grounded the review in their codebase.',
    'Be concise but specific. Point to files/functions when relevant. Admit uncertainty when needed.',
    'Be super quick too. We want to be able to review new turns as they come in.',
    '',
    `Session ID: ${sessionId}`,
    latestTurnSection,
    'Full conversation transcript follows between <conversation> tags. Use it to ground your critique.',
    '<conversation>',
    markdown.trim(),
    '</conversation>',
  ].join('\n');
}

function buildFollowupPrompt({ sessionId, newTurns }: FollowupReviewContext): string {
  const formattedTurns = newTurns
    .map((turn, index) => {
      const pieces = [
        `Turn ${index + 1}`,
        'User prompt:',
        turn.user,
        '',
        'Claude response:',
        turn.agent ?? '(Claude has not responded yet)',
      ];
      return pieces.join('\n');
    })
    .join('\n\n');

  return [
    'You are Sage, continuing an in-depth review of a Claude Code session.',
    'Focus on the newly provided turn(s) and decide whether they introduce new risks, resolve prior concerns, or require follow-up guidance.',
    'Return a critique card with sections: Verdict, Why, Alternatives (optional), Questions (optional).',
    'Do not repeat repository reconnaissance performed earlier—reference prior context only when needed, and read additional files only if these turn(s) require it.',
    'Highlight concrete issues, cite files or functions when relevant, and admit uncertainty if information is missing.',
    '',
    `Session ID: ${sessionId}`,
    'New Claude turn(s) follow between <new_turns> tags.',
    '<new_turns>',
    formattedTurns,
    '</new_turns>',
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
