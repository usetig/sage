import { sendPrompt, type BasicStreamEvent } from './opencode.js';
import type { TurnSummary } from './jsonl.js';

export interface CritiqueResponse {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives: string;
  message_for_agent: string;
}

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
  isPartial?: boolean;
}

export interface PromptPayload {
  prompt: string;
  promptText: string;
  contextText: string;
}

export type StreamEventTag = 'assistant' | 'reasoning' | 'command' | 'file' | 'todo' | 'status' | 'error';

export interface StreamEvent {
  id: string;
  timestamp: number;
  tag: StreamEventTag;
  message: string;
}

export interface RunReviewOptions {
  onEvent?: (event: StreamEvent) => void;
  model: string;
  opencodeSessionId: string;
}

export interface RunInitialReviewResult {
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
  options: RunReviewOptions,
): Promise<RunInitialReviewResult> {
  const payload = buildInitialPromptPayload(context);
  const { critique, events } = await executePrompt(
    payload.prompt,
    options.model,
    options.opencodeSessionId,
    options.onEvent,
  );

  return {
    critique,
    promptPayload: payload,
    streamEvents: events,
  };
}

export async function runFollowupReview(
  context: FollowupReviewContext,
  options: RunReviewOptions,
): Promise<RunFollowupReviewResult> {
  const payload = buildFollowupPromptPayload(context);
  const { critique, events } = await executePrompt(
    payload.prompt,
    options.model,
    options.opencodeSessionId,
    options.onEvent,
  );

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

  const jsonDirective = `Return ONLY valid JSON with keys: verdict (Approved|Concerns|Critical Issues), why, alternatives, message_for_agent.`;

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
    '# CRITICAL CONSTRAINTS FOR SAGE (YOU)',
    'You (Sage) are running in a read-only sandbox. You must NEVER modify, write, or delete any files.',
    'You are a reviewer, not an implementer.',
    '',
    '# Task',
    'This is your first review of this session. Follow these steps:',
    '1. Explore the codebase - Read relevant files to understand the architecture, patterns, and context',
    '2. Review the conversation - Focus on the most recent turns if the conversation is long',
    '3. Critique the latest Claude turn - Evaluate only the most recent response for issues',
    '',
    '# Output Format',
    jsonDirective,
    'Do not include markdown, code fences, or prose outside the JSON object.',
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
  { sessionId, newTurns, isPartial }: FollowupReviewContext,
): PromptPayload {
  const formattedTurns = formatTurnsForPrompt(newTurns);
  const jsonDirective = 'Return ONLY JSON: {"verdict":"Approved|Concerns|Critical Issues","why":"...","alternatives":"...","message_for_agent":"..."}';

  const promptLines = [
    '# Audience Reminder',
    'You are speaking directly to the DEVELOPER (the human user).',
    '- Use "you/your" for the developer; use "Claude" for the assistant.',
    '',
    '# New Turn(s) to Review',
    'Evaluate the newly provided turn(s) and determine whether they introduce risks, resolve prior concerns, or need follow-up guidance.',
    '',
    '# CRITICAL CONSTRAINTS FOR SAGE (YOU)',
    'You are read-only and must not write files.',
    '',
    '# Output Format',
    jsonDirective,
    'No prose outside the JSON object.',
    '',
    `Session ID: ${sessionId}`,
    isPartial ? '[Note: Claude response may be partial]' : null,
    '<conversation>',
    formattedTurns,
    '</conversation>',
  ].filter(Boolean).join('\n');

  return {
    prompt: promptLines,
    promptText: promptLines,
    contextText: formattedTurns,
  };
}

function formatTurnsForPrompt(turns: TurnSummary[]): string {
  if (!turns.length) return 'No conversation turns available.';

  return turns
    .map((turn, index) => {
      const turnLabel = `Turn ${index + 1}`;
      const pieces = [
        `${turnLabel}:`,
        'USER:',
        turn.user,
        '',
        'CLAUDE:',
        turn.agent ?? '(Claude has not responded yet)',
        turn.isPartial ? '[Captured while Claude was still responding — content may be incomplete.]' : null,
      ];
      return pieces.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

async function executePrompt(
  prompt: string,
  model: string,
  opencodeSessionId: string,
  onEvent?: (event: StreamEvent) => void,
): Promise<{ critique: CritiqueResponse; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  onEvent?.(makeStreamEvent('status', `Using model ${model}`));

  const { text, finalText } = await sendPrompt({
    sessionId: opencodeSessionId,
    prompt,
    model,
    onEvent: (basic: BasicStreamEvent) => {
      const ev = makeStreamEvent(basic.tag as StreamEventTag, basic.message, basic.timestamp);
      events.push(ev);
      onEvent?.(ev);
    },
  });
  const critique = parseCritiqueFromCandidates([text, finalText]);
  const summary = `${critique.verdict}: ${critique.why ? truncate(critique.why, 120) : 'no details'}`;
  events.push(makeStreamEvent('assistant', summary));
  return { critique, events };
}

function parseCritiqueFromCandidates(candidates: string[]): CritiqueResponse {
  const isValid = (obj: any): obj is CritiqueResponse =>
    obj && typeof obj.verdict === 'string' && typeof obj.why === 'string'
    && typeof obj.alternatives === 'string' && typeof obj.message_for_agent === 'string';

  const tryParse = (text: string): CritiqueResponse | null => {
    try {
      const parsed = JSON.parse(text.trim());
      return isValid(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  for (const raw of candidates) {
    const direct = tryParse(raw);
    if (direct && isAllowedVerdict(direct.verdict)) return direct;

    const blocks: string[] = [];
    const regex = /{[\s\S]*?}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const candidate = match[0];
      if (candidate.length <= 12000) {
        blocks.push(candidate);
      }
    }
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const parsed = tryParse(blocks[i]);
      if (parsed && isAllowedVerdict(parsed.verdict)) return parsed;
    }
  }

  const lastRaw = candidates[candidates.length - 1] ?? '';
  throw new Error(`Failed to parse critique JSON from model response. Raw response: ${lastRaw}`);
}

function isAllowedVerdict(v: string): v is CritiqueResponse['verdict'] {
  return v === 'Approved' || v === 'Concerns' || v === 'Critical Issues';
}

let eventCounter = 0;
function makeStreamEvent(tag: StreamEventTag, message: string, timestamp?: number): StreamEvent {
  eventCounter += 1;
  return { id: String(eventCounter), timestamp: timestamp ?? Date.now(), tag, message };
}

function truncate(input: string, max = 120): string {
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
