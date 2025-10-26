import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';
import type { TurnSummary } from './markdown.js';

export interface CritiqueResponse {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives: string;
  questions: string;
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['Approved', 'Concerns', 'Critical Issues'],
    },
    why: { type: 'string' },
    alternatives: { type: 'string' },
    questions: { type: 'string' },
  },
  required: ['verdict', 'why', 'alternatives', 'questions'],
  additionalProperties: false,
} as const;

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

export interface PromptPayload {
  prompt: string;
  promptText: string;
  contextText: string;
}

export async function runInitialReview(
  context: InitialReviewContext,
): Promise<{ thread: Thread; critique: CritiqueResponse; promptPayload: PromptPayload }> {
  const thread = singleton.startThread();
  const payload = buildInitialPromptPayload(context);
  const result = await thread.run(payload.prompt, { outputSchema: CRITIQUE_SCHEMA });

  // When outputSchema is used, finalResponse contains the structured object
  const critique = typeof result.finalResponse === 'object'
    ? result.finalResponse as CritiqueResponse
    : JSON.parse(result.finalResponse as string) as CritiqueResponse;

  return {
    thread,
    critique,
    promptPayload: payload,
  };
}

export async function runFollowupReview(
  thread: Thread,
  context: FollowupReviewContext,
): Promise<{ critique: CritiqueResponse; promptPayload: PromptPayload }> {
  const payload = buildFollowupPromptPayload(context);
  const result = await thread.run(payload.prompt, { outputSchema: CRITIQUE_SCHEMA });

  // When outputSchema is used, finalResponse contains the structured object
  const critique = typeof result.finalResponse === 'object'
    ? result.finalResponse as CritiqueResponse
    : JSON.parse(result.finalResponse as string) as CritiqueResponse;

  return {
    critique,
    promptPayload: payload,
  };
}

export function buildInitialPromptPayload(
  { sessionId, markdown, latestTurnSummary }: InitialReviewContext,
): PromptPayload {
  const latestTurnSection = latestTurnSummary
    ? `Latest Claude turn:\nUser prompt:\n${latestTurnSummary.user}\n\nClaude response:\n${latestTurnSummary.agent ?? '(Claude has not responded yet)'}\n`
    : 'Latest Claude turn could not be determined from the export.\n';

  const promptText = [
    'You are Sage, a meticulous AI code reviewer that evaluates Claude Code sessions.',
    'Your goal is to deliver a critique card with these sections: Verdict, Why, Alternatives, Questions.',
    'If Alternatives or Questions are not applicable, return empty strings for those fields.',
    'Focus on correctness issues, missing steps, risky assumptions, and suggest practical next actions for the developer.',
    'Be concise but specific. Point to files/functions when relevant. Admit uncertainty when needed.',
    'Be super quick too. We want to be able to review new turns as they come in.',
    '',
    `Session ID: ${sessionId}`,
    latestTurnSection,
    'Full conversation transcript follows between <conversation> tags. Use it to ground your critique.',
  ].join('\n');

  const contextText = markdown.trim();

  return {
    prompt: [promptText, '<conversation>', contextText, '</conversation>'].join('\n'),
    promptText,
    contextText,
  };
}

export function buildFollowupPromptPayload(
  { sessionId, newTurns }: FollowupReviewContext,
): PromptPayload {
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

  const promptText = [
    'You are Sage, continuing an in-depth review of a Claude Code session.',
    'Focus on the newly provided turn(s) and decide whether they introduce new risks, resolve prior concerns, or require follow-up guidance.',
    'Return a critique card with sections: Verdict, Why, Alternatives, Questions.',
    'If Alternatives or Questions are not applicable, return empty strings for those fields.',
    'Do not repeat repository reconnaissance performed earlier—reference prior context only when needed, and read additional files only if these turn(s) require it.',
    'Highlight concrete issues, cite files or functions when relevant, and admit uncertainty if information is missing.',
    '',
    `Session ID: ${sessionId}`,
    'New Claude turn(s) follow between <new_turns> tags.',
  ].join('\n');

  const contextText = formattedTurns;

  return {
    prompt: [promptText, '<new_turns>', formattedTurns, '</new_turns>'].join('\n'),
    promptText,
    contextText,
  };
}
