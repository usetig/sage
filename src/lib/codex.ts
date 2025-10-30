import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import type { TurnSummary } from './jsonl.js';

export interface CritiqueResponse {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives: string;
  questions: string;
  message_for_agent: string;
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
    message_for_agent: { type: 'string' },
  },
  required: ['verdict', 'why', 'alternatives', 'questions', 'message_for_agent'],
  additionalProperties: false,
} as const;

export interface InitialReviewContext {
  sessionId: string;
  turns: TurnSummary[];
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

// Export the singleton for use in thread management
export const codexInstance = singleton;

const DEFAULT_THREAD_OPTIONS: ThreadOptions = (() => {
  const model = "gpt-4.1-nano"; // process.env.SAGE_CODEX_MODEL?.trim();
  if (model) {
    return { model };
  }
  return {};
})();

export function getConfiguredThreadOptions(): ThreadOptions {
  return { ...DEFAULT_THREAD_OPTIONS };
}

export interface PromptPayload {
  prompt: string;
  promptText: string;
  contextText: string;
}

export async function runInitialReview(
  context: InitialReviewContext,
  thread?: Thread,
): Promise<{ thread: Thread; critique: CritiqueResponse; promptPayload: PromptPayload }> {
  const reviewThread = thread ?? singleton.startThread(getConfiguredThreadOptions());
  const payload = buildInitialPromptPayload(context);
  const result = await reviewThread.run(payload.prompt, { outputSchema: CRITIQUE_SCHEMA });

  // When outputSchema is used, finalResponse contains the structured object
  const critique = typeof result.finalResponse === 'object'
    ? result.finalResponse as CritiqueResponse
    : JSON.parse(result.finalResponse as string) as CritiqueResponse;

  return {
    thread: reviewThread,
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
  { sessionId, turns, latestTurnSummary }: InitialReviewContext,
): PromptPayload {
  const latestTurnSection = latestTurnSummary
    ? `Latest Claude turn:\nUser prompt:\n${latestTurnSummary.user}\n\nClaude response:\n${latestTurnSummary.agent ?? '(Claude has not responded yet)'}\n`
    : 'Latest Claude turn could not be determined from the export.\n';

  const promptText = [
    '# Role',
    'You are Sage, an AI code reviewer that evaluates Claude Code sessions to provide a second opinion on Claude\'s suggestions.',
    '',
    '# Audience',
    'You are speaking directly to the DEVELOPER (the human user).',
    '- Use "you/your" to refer to the developer',
    '- Use "Claude" or "it" (third person) to refer to the AI assistant being reviewed',
    '- When using pronouns for Claude, use "it" not "he/she" (e.g., "After it verified..." not "After he verified...")',
    '- Example: "Claude suggested X, but your codebase uses Y..." (NOT "You suggested...")',
    '- When critiquing Claude’s suggestions or actions, spell out "Claude" (or "Claude\'s")—never say "you" for something Claude did.',
    '',
    '# CRITICAL CONSTRAINTS',
    'Your role is OBSERVATION AND ANALYSIS ONLY. You must: NEVER modify, write, or delete any files',
    'You are a reviewer, not an implementer. If you attempt any write operations, the review will be rejected.',
    '',
    '# Task',
    'This is your first review of this session. Follow these steps:',
    '1. Explore the codebase - Read relevant files to understand the architecture, patterns, and context',
    '2. Review the conversation - Focus on the most recent turns if the conversation is long',
    '3. Critique the latest Claude turn - Evaluate only the most recent response for issues',
    '4. Verify alignment - Check if Claude addressed what the user actually asked for',
    '',
    '# Conversation Transcript Details',
    'The conversation transcript below shows only the PRIMARY user-Claude exchanges.',
    '- Internal sub-agent work (marked as "sidechain" in Claude\'s logs) has been filtered out',
    '- When Claude delegates to specialized agents (Explore, Task, etc.), their tool calls and responses are not shown',
    '- Claude\'s final responses incorporate findings from any sub-agents, so you\'re seeing the consolidated output',
    '- If Claude claims to have read a file, explored code, or performed research, assume this work occurred in filtered sidechain turns even if you don\'t see the tool calls',
    '- Do NOT flag "Claude claimed to read X but didn\'t" - those reads likely happened in sidechains',
    '- ONLY flag actual logic errors, incorrect suggestions, or missing implementation steps in Claude\'s visible responses',
    '- Focus your review on what Claude communicated to the developer, not on verifying that tool calls are visible',
    '',
    '# Output Format',
    'Deliver a structured critique card with these sections:',
    '- Verdict: "Approved" | "Concerns" | "Critical Issues"',
    '- Why: Your main reasoning (required)',
    '- Alternatives: Suggested alternative approaches (empty string if not applicable)',
    '- Questions: Clarification questions for the developer (empty string if not applicable)',
    '- message_for_agent: Direct communication with Claude Code agent (empty string if not applicable)',
    '',
    '# message_for_agent Guidelines',
    'Use this field ONLY when verdict is "Concerns" or "Critical Issues" AND you have specific, actionable guidance for Claude.',
    '- Write directly to Claude (e.g., "Please verify X" not "Claude should verify X")',
    '- Be concise and specific - focus on what Claude should do differently or check',
    '- Return empty string if verdict is "Approved" OR you have nothing specific to tell Claude',
    '- This is NOT a summary - it\'s instructions/corrections for the agent',
    '- Example: "Please verify the API endpoint exists in the codebase before suggesting it to the developer."',
    '',
    '# Guidelines',
    '- Focus on: correctness issues, missing steps, risky assumptions, hallucinations, request-response misalignment',
    '- Suggest practical next actions directly to the developer (e.g., "You may want to..." not "The user should...")',
    '- Be concise but specific - cite files/functions when relevant',
    '- Admit uncertainty when needed',
    '- If you must contrast Claude and the developer, make the subject explicit (e.g., "Claude\'s draft uses X, but your app uses Y").',
    '',
    `Session ID: ${sessionId}`,
    latestTurnSection,
    'Full conversation transcript follows between <conversation> tags. Use it to ground your critique.',
  ].join('\n');

  const conversationText = turns.length ? formatTurnsForPrompt(turns) : 'No conversation turns were parsed from the export.';
  const contextText = conversationText.trim();

  return {
    prompt: [promptText, '<conversation>', contextText, '</conversation>'].join('\n'),
    promptText,
    contextText,
  };
}

export function buildFollowupPromptPayload(
  { sessionId, newTurns }: FollowupReviewContext,
): PromptPayload {
  const formattedTurns = formatTurnsForPrompt(newTurns);

  const promptText = [
    '# Audience Reminder',
    'You are speaking directly to the DEVELOPER (the human user).',
    '- Use "you/your" to refer to the developer',
    '- Use "Claude" or "it" (third person) to refer to the AI assistant being reviewed',
    '- When using pronouns for Claude, use "it" not "he/she" (e.g., "After it verified..." not "After he verified...")',
    '- Example: "Claude suggested X, but your codebase uses Y..." (NOT "You suggested...")',
    '- When critiquing Claude’s new suggestions or actions, explicitly attribute them to "Claude" (or "Claude\'s"), never to "you".',
    '',
    '# New Turn(s) to Review',
    'Evaluate the newly provided turn(s) and determine whether they:',
    '- Introduce new risks or issues',
    '- Resolve prior concerns',
    '- Address what the user asked for',
    '- Require follow-up guidance',
    '',
    '# CRITICAL CONSTRAINTS',
    'Your role is OBSERVATION AND ANALYSIS ONLY. You must: NEVER modify, write, or delete any files',
    'You are a reviewer, not an implementer. If you attempt any write operations, the review will be rejected.',
    '',
    '# Context Awareness',
    'You have already explored this codebase in your initial review.',
    '- Reference prior context when needed',
    '- Read additional files only if these specific turn(s) require it',
    '- Do not repeat repository exploration already performed',
    '',
    '# Conversation Transcript Details',
    'The conversation turns below show only PRIMARY user-Claude exchanges.',
    '- Internal sub-agent work (marked as "sidechain" in Claude\'s logs) has been filtered out',
    '- When Claude delegates to specialized agents (Explore, Task, etc.), their tool calls and responses are not shown',
    '- Claude\'s final responses incorporate findings from any sub-agents, so you\'re seeing the consolidated output',
    '- If Claude claims to have read a file, explored code, or performed research, assume this work occurred in filtered sidechain turns even if you don\'t see the tool calls',
    '- Do NOT flag "Claude claimed to read X but didn\'t" - those reads likely happened in sidechains',
    '- ONLY flag actual logic errors, incorrect suggestions, or missing implementation steps in Claude\'s visible responses',
    '- Focus your review on what Claude communicated to the developer, not on verifying that tool calls are visible',
    '',
    '# Output Format',
    'Deliver a structured critique card with these sections:',
    '- Verdict: "Approved" | "Concerns" | "Critical Issues"',
    '- Why: Your main reasoning (required)',
    '- Alternatives: Suggested alternative approaches (empty string if not applicable)',
    '- Questions: Clarification questions for the developer (empty string if not applicable)',
    '- message_for_agent: Direct communication with Claude Code agent (empty string if not applicable)',
    '',
    '# message_for_agent Guidelines',
    'Use this field ONLY when verdict is "Concerns" or "Critical Issues" AND you have specific, actionable guidance for Claude.',
    '- Write directly to Claude (e.g., "Please verify X" not "Claude should verify X")',
    '- Be concise and specific - focus on what Claude should do differently or check',
    '- Return empty string if verdict is "Approved" OR you have nothing specific to tell Claude',
    '- This is NOT a summary - it\'s instructions/corrections for the agent',
    '- Example: "Please verify the API endpoint exists in the codebase before suggesting it to the developer."',
    '',
    '# Guidelines',
    '- Focus on: correctness issues, missing steps, risky assumptions, hallucinations, request-response misalignment',
    '- Suggest practical next actions directly to the developer (e.g., "You may want to..." not "The user should...")',
    '- Be concise but specific - cite files/functions when relevant',
    '- Admit uncertainty when needed',
    '- Clearly distinguish Claude’s work from the developer’s (e.g., "Claude claims…" / "Your project…").',
    '',
    `Session ID: ${sessionId}`,
    'New Claude turn(s) follow between <new_turns> tags.',
  ].join('\n');

  const contextText = formattedTurns;

  return {
    prompt: [promptText, '<new_turns>', formattedTurns, '</new_turns>'].join('\n'),
    promptText,
    contextText: formattedTurns,
  };
}

function formatTurnsForPrompt(turns: TurnSummary[]): string {
  const BOX_WIDTH = 80;

  return turns
    .map((turn, index) => {
      const turnLabel = `Turn ${index + 1}`;
      // ┌─ Turn N ───...───┐ = 80 chars total
      // ┌ (1) + ─ (1) + space (1) + label + space (1) + fill + ┐ (1) = 80
      const topBorderFill = BOX_WIDTH - 5 - turnLabel.length;

      // │ USER PROMPT      ...      │ = 80 chars total
      // │ (1) + space (1) + text (11) + fill + │ (1) = 80, so fill = 80 - 14 = 66
      const userPromptPadding = BOX_WIDTH - 3 - 'USER PROMPT'.length;

      // │ CLAUDE RESPONSE  ...      │ = 80 chars total
      // │ (1) + space (1) + text (15) + fill + │ (1) = 80, so fill = 80 - 18 = 62
      const claudeResponsePadding = BOX_WIDTH - 3 - 'CLAUDE RESPONSE'.length;

      const pieces = [
        `┌─ ${turnLabel} ${'─'.repeat(Math.max(0, topBorderFill))}┐`,
        '│ USER PROMPT' + ' '.repeat(userPromptPadding) + '│',
        '└' + '─'.repeat(BOX_WIDTH - 2) + '┘',
        turn.user,
        '',
        '┌' + '─'.repeat(BOX_WIDTH - 2) + '┐',
        '│ CLAUDE RESPONSE' + ' '.repeat(claudeResponsePadding) + '│',
        '└' + '─'.repeat(BOX_WIDTH - 2) + '┘',
        turn.agent ?? '(Claude has not responded yet)',
      ];
      return pieces.join('\n');
    })
    .join('\n\n');
}
