import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent, ThreadItem, ThreadOptions } from '@openai/codex-sdk';
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
  const model = "gpt-5-codex"; // process.env.SAGE_CODEX_MODEL?.trim();
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

export type StreamEventTag =
  | 'assistant'
  | 'reasoning'
  | 'command'
  | 'file'
  | 'todo'
  | 'status'
  | 'error';

export interface StreamEvent {
  id: string;
  timestamp: number;
  tag: StreamEventTag;
  message: string;
}

export interface RunReviewOptions {
  thread?: Thread;
  promptPayload?: PromptPayload;
  onEvent?: (event: StreamEvent) => void;
}

export interface RunInitialReviewResult {
  thread: Thread;
  critique: CritiqueResponse;
  promptPayload: PromptPayload;
  streamEvents: StreamEvent[];
}

export interface RunFollowupReviewResult {
  critique: CritiqueResponse;
  promptPayload: PromptPayload;
  streamEvents: StreamEvent[];
}

export async function runInitialReview(
  context: InitialReviewContext,
  options?: RunReviewOptions,
): Promise<RunInitialReviewResult> {
  const reviewThread = options?.thread ?? singleton.startThread(getConfiguredThreadOptions());
  const payload = options?.promptPayload ?? buildInitialPromptPayload(context);
  const { critique, events } = await executeStreamedTurn(reviewThread, payload.prompt, options?.onEvent);

  return {
    thread: reviewThread,
    critique,
    promptPayload: payload,
    streamEvents: events,
  };
}

export async function runFollowupReview(
  thread: Thread,
  context: FollowupReviewContext,
  options?: Omit<RunReviewOptions, 'thread'>,
): Promise<RunFollowupReviewResult> {
  const payload = options?.promptPayload ?? buildFollowupPromptPayload(context);
  const { critique, events } = await executeStreamedTurn(thread, payload.prompt, options?.onEvent);

  return {
    critique,
    promptPayload: payload,
    streamEvents: events,
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

const MAX_STREAM_MESSAGE_LENGTH = 600;
let streamEventCounter = 0;

async function executeStreamedTurn(
  thread: Thread,
  prompt: string,
  onEvent?: (event: StreamEvent) => void,
): Promise<{ critique: CritiqueResponse; events: StreamEvent[] }> {
  const { events } = await thread.runStreamed(prompt, { outputSchema: CRITIQUE_SCHEMA });
  const collected: StreamEvent[] = [];
  let critique: CritiqueResponse | null = null;

  const iterator = events[Symbol.asyncIterator]() as AsyncIterator<ThreadEvent>;
  let sawTerminalEvent = false;

  // Iterate manually so we can break/close when the turn finishes.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await iterator.next();
    if (done) {
      break;
    }

    const event = value as ThreadEvent;
    const derived = convertThreadEventToStreamEvents(event);
    if (derived.length) {
      for (const entry of derived) {
        collected.push(entry);
        onEvent?.(entry);
      }
    }

    const maybeCritique = extractCritiqueFromEvent(event);
    if (maybeCritique) {
      critique = maybeCritique;
    }

    if (event.type === 'turn.failed') {
      sawTerminalEvent = true;
      await closeIterator(iterator);
      const errorMessage = event.error?.message ?? 'Codex turn failed';
      throw new Error(errorMessage);
    }

    if (event.type === 'turn.completed') {
      sawTerminalEvent = true;
      await closeIterator(iterator);
      break;
    }
  }

  if (!critique) {
    throw new Error('Codex returned no structured critique.');
  }

  if (!sawTerminalEvent) {
    collected.push(makeStreamEvent('status', 'Stream ended unexpectedly without a terminal event.', Date.now()));
  }

  return { critique, events: collected };
}

async function closeIterator(iterator: AsyncIterator<ThreadEvent>): Promise<void> {
  if (typeof iterator.return === 'function') {
    try {
      await iterator.return();
    } catch {
      // Iterator may already be closed; ignore errors.
    }
  }
}

function convertThreadEventToStreamEvents(event: ThreadEvent): StreamEvent[] {
  const timestamp = Date.now();

  switch (event.type) {
    case 'item.started':
      return describeItemEvent('started', event.item, timestamp);
    case 'item.updated':
      return describeItemEvent('updated', event.item, timestamp);
    case 'item.completed':
      return describeItemEvent('completed', event.item, timestamp);
    case 'turn.completed': {
      const usage = event.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const cachedTokens = usage.cached_input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;

      // Calculate effective tokens: new input + (cached * 0.1) + output
      const newInputTokens = inputTokens - cachedTokens;
      const effectiveTokens = Math.round(newInputTokens + (cachedTokens * 0.1) + outputTokens);

      const message = effectiveTokens > 0
        ? `Turn completed • ${effectiveTokens.toLocaleString()} tokens used`
        : 'Turn completed';

      return [makeStreamEvent('status', message, timestamp)];
    }
    case 'turn.failed': {
      const message = event.error?.message ?? 'Codex turn failed';
      return [makeStreamEvent('error', `Turn failed: ${message}`, timestamp)];
    }
    default:
      return [];
  }
}

function describeItemEvent(
  stage: 'started' | 'updated' | 'completed',
  item: ThreadItem,
  timestamp: number,
): StreamEvent[] {
  const stageLabel = stage === 'started' ? 'Started' : stage === 'updated' ? 'Updated' : 'Completed';
  const value: any = item;

  switch (item.type) {
    case 'agent_message': {
      const raw = extractItemText(value);
      if (stage !== 'completed') {
        return [makeStreamEvent('status', `${stageLabel} assistant message`, timestamp)];
      }

      const message = raw ? raw : 'Assistant emitted an empty message.';
      return [makeStreamEvent('assistant', message, timestamp)];
    }
    case 'reasoning': {
      const raw = extractItemText(value);
      if (!raw) {
        return [makeStreamEvent('reasoning', `${stageLabel} reasoning step`, timestamp)];
      }
      const prefix = stage === 'completed' ? '' : `${stageLabel} reasoning step:\n`;
      return [makeStreamEvent('reasoning', `${prefix}${raw}`, timestamp)];
    }
    case 'command_execution': {
      const command = typeof value?.command === 'string' ? value.command : 'command';
      const status = typeof value?.status === 'string' ? value.status : 'running';
      const exitCode = typeof value?.exit_code === 'number' ? ` (exit ${value.exit_code})` : '';
      const message = stage === 'completed'
        ? `Command ${command} ${status}${exitCode}`
        : `${stageLabel} command ${command}`;
      return [makeStreamEvent('command', message, timestamp)];
    }
    case 'file_change': {
      const changes = Array.isArray(value?.changes) ? value.changes : [];
      if (!changes.length) {
        return [makeStreamEvent('file', `${stageLabel} file change`, timestamp)];
      }
      return changes.map((change: any) => {
        const kind = typeof change?.kind === 'string' ? change.kind : 'updated';
        const path = typeof change?.path === 'string' ? change.path : '(unknown path)';
        return makeStreamEvent('file', `${stageLabel} file ${kind}: ${path}`, timestamp);
      });
    }
    case 'todo_list': {
      return [makeStreamEvent('todo', summarizeTodoList(stageLabel, value), timestamp)];
    }
    default: {
      const typeLabel = typeof value?.type === 'string' ? value.type : 'item';
      return [makeStreamEvent('status', `${stageLabel} ${typeLabel}`, timestamp)];
    }
  }
}

function summarizeTodoList(stageLabel: string, item: any): string {
  const items = Array.isArray(item?.items) ? item.items : [];
  if (!items.length) {
    return `${stageLabel} todo list (empty)`;
  }

  const lines = items.map((todo: any) => {
    const symbol = todo?.completed ? '✓' : '□';
    const text = typeof todo?.text === 'string' ? todo.text : '';
    return `${symbol} ${text}`.trim();
  });

  return `${stageLabel} todo list:\n${lines.join('\n')}`;
}

function extractItemText(item: any): string {
  if (typeof item?.text === 'string' && item.text.trim().length > 0) {
    return item.text.trim();
  }

  if (Array.isArray(item?.content)) {
    const parts = item.content
      .map((chunk: any) => (typeof chunk?.text === 'string' ? chunk.text : null))
      .filter((chunk: string | null): chunk is string => Boolean(chunk));
    if (parts.length) {
      return parts.join('\n').trim();
    }
  }

  if (item?.json && typeof item.json === 'object') {
    try {
      return JSON.stringify(item.json, null, 2);
    } catch {
      return '';
    }
  }

  return '';
}

function extractCritiqueFromEvent(event: ThreadEvent): CritiqueResponse | null {
  if (event.type !== 'item.completed') return null;
  if (!event.item || event.item.type !== 'agent_message') return null;

  const payload = extractStructuredPayload(event.item);
  if (!payload) return null;
  return isCritiqueResponse(payload) ? payload : null;
}

function extractStructuredPayload(item: ThreadItem): unknown {
  const value: any = item;
  if (value?.json && typeof value.json === 'object') {
    return value.json;
  }

  if (typeof value?.text === 'string') {
    const text = value.text.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  return null;
}

function isCritiqueResponse(value: any): value is CritiqueResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (
    typeof value.verdict === 'string'
    && typeof value.why === 'string'
    && typeof value.alternatives === 'string'
    && typeof value.questions === 'string'
    && typeof value.message_for_agent === 'string'
  );
}

function makeStreamEvent(tag: StreamEventTag, message: string, timestamp: number): StreamEvent {
  const normalized = truncateForDisplay(message.replace(/\r\n/g, '\n'));
  if (!normalized) {
    return {
      id: `evt-${timestamp}-${++streamEventCounter}`,
      timestamp,
      tag,
      message: '(no details)',
    };
  }

  return {
    id: `evt-${timestamp}-${++streamEventCounter}`,
    timestamp,
    tag,
    message: normalized,
  };
}

function truncateForDisplay(text: string, maxLength = MAX_STREAM_MESSAGE_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
