import {
  runFollowupReview,
  runInitialReview,
  buildInitialPromptPayload,
  buildFollowupPromptPayload,
  type CritiqueResponse,
  type StreamEvent,
} from './codex.js';
import { extractTurns, type TurnSummary } from './jsonl.js';
import { writeDebugReviewArtifact } from './debug.js';
import { getOrCreateOpencodeSession, loadThreadMetadata, saveThreadMetadata, updateThreadTurnCount } from './threads.js';
import { DEFAULT_MODEL } from './models.js';

export interface ReviewResult {
  critique: CritiqueResponse;
  transcriptPath: string;
  completedAt: string;
  turnSignature?: string;
  latestPrompt?: string;
  debugInfo?: {
    artifactPath: string;
    promptText: string;
  };
  isFreshCritique: boolean;
  streamEvents: StreamEvent[];
  isPartial?: boolean;
}

export type InitialReviewResult = ReviewResult & {
  opencodeSessionId: string | null;
  turns: TurnSummary[];
};

export async function performInitialReview(
  session: { sessionId: string; transcriptPath: string; lastReviewedUuid: string | null },
  onProgress?: (message: string, isDebug?: boolean) => void,
  onStreamEvent?: (event: StreamEvent) => void,
  model?: string,
): Promise<InitialReviewResult> {
  const { sessionId, transcriptPath, lastReviewedUuid } = session;

  onProgress?.('reading conversation history...', false);
  const { turns, latestTurnUuid } = await extractTurns({ transcriptPath });
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestPromptPreview = latestTurn?.user ? previewText(latestTurn.user) : '(none captured)';

  if (!turns.length) {
    onProgress?.('Waiting for Claude to provide its first full response before reviewing.', false);
    return {
      critique: {
        verdict: 'Approved',
        why: 'Initial review deferred — Sage will start once Claude finishes its first response.',
        alternatives: '',
        message_for_agent: '',
      },
      transcriptPath,
      completedAt: new Date().toISOString(),
      latestPrompt: undefined,
      opencodeSessionId: null,
      turns,
      debugInfo: undefined,
      turnSignature: lastReviewedUuid ?? undefined,
      isFreshCritique: false,
      streamEvents: [],
    };
  }

  if (latestTurn && latestTurn.agent && latestTurn.assistantUuid === undefined) {
    onProgress?.('Claude is still responding — initial review will wait for completion.', false);
    return {
      critique: {
        verdict: 'Approved',
        why: 'Initial review deferred until Claude finishes responding.',
        alternatives: '',
        message_for_agent: '',
      },
      transcriptPath,
      completedAt: new Date().toISOString(),
      latestPrompt: latestTurn.user,
      opencodeSessionId: null,
      turns,
      debugInfo: undefined,
      turnSignature: latestTurnUuid ?? undefined,
      isFreshCritique: false,
      streamEvents: [],
    };
  }

  const promptPayload = buildInitialPromptPayload({
    sessionId,
    turns,
    latestTurnSummary: latestTurn ?? undefined,
  });

  const artifactPath = await writeDebugReviewArtifact({
    instructions: promptPayload.promptText,
    context: promptPayload.contextText,
    promptLabel: latestTurn?.user ?? sessionId,
    sessionId,
    reviewType: 'initial',
  });

  const metadata = await loadThreadMetadata(sessionId);
  const opencodeSession = await getOrCreateOpencodeSession(sessionId, onProgress, model);

  const modelToUse = model || metadata?.model || DEFAULT_MODEL;

  const currentTurnCount = turns.length;
  const lastReviewedTurnCount = metadata?.lastReviewedTurnCount ?? 0;
  const hasNewTurns = currentTurnCount > lastReviewedTurnCount;

  let critique: CritiqueResponse;
  let isFreshCritique = true;
  let streamEvents: StreamEvent[] = [];

  if (metadata && !hasNewTurns) {
    onProgress?.('Resuming Sage session...', false);
    critique = {
      verdict: 'Approved',
      why: 'Session previously reviewed. Entering continuous mode with existing context.',
      alternatives: '',
      message_for_agent: '',
    };
    isFreshCritique = false;
  } else if (metadata && hasNewTurns) {
    onProgress?.('examining new dialogue...', false);
    const newTurns = turns.slice(lastReviewedTurnCount);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('OpenCode review timed out after 5 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runFollowupReview(
      { sessionId, newTurns },
      { onEvent: onStreamEvent, model: modelToUse, opencodeSessionId: opencodeSession.id },
    );
    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    streamEvents = result.streamEvents;
    isFreshCritique = true;

    await updateThreadTurnCount(sessionId, currentTurnCount);
  } else {
    onProgress?.('analyzing codebase context...', false);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('OpenCode review timed out after 5 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runInitialReview(
      {
        sessionId,
        turns,
        latestTurnSummary: latestTurn ?? undefined,
      },
      {
        onEvent: onStreamEvent,
        model: modelToUse,
        opencodeSessionId: opencodeSession.id,
      },
    );

    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    streamEvents = result.streamEvents;
    isFreshCritique = true;

    await saveThreadMetadata(sessionId, opencodeSession.id, modelToUse, currentTurnCount);
  }

  const completedAt = new Date().toISOString();

  onProgress?.(`reviewed latest turn: ${latestPromptPreview}`, true);

  return {
    critique,
    transcriptPath,
    completedAt,
    latestPrompt: latestTurn?.user,
    opencodeSessionId: opencodeSession.id,
    turns,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
    turnSignature: latestTurnUuid ?? lastReviewedUuid ?? undefined,
    isFreshCritique,
    streamEvents,
  };
}

export interface IncrementalReviewRequest {
  sessionId: string;
  transcriptPath: string;
  opencodeSessionId: string | null;
  turns: TurnSummary[];
  latestTurnSignature: string | null;
  isPartial?: boolean;
  model?: string;
}

export async function performIncrementalReview(
  request: IncrementalReviewRequest,
  onProgress?: (message: string, isDebug?: boolean) => void,
  onStreamEvent?: (event: StreamEvent) => void,
): Promise<ReviewResult> {
  const { sessionId, transcriptPath, opencodeSessionId, turns, latestTurnSignature, isPartial, model } = request;
  if (!turns.length) {
    throw new Error('No new turns provided for incremental review.');
  }

  const promptPayload = buildFollowupPromptPayload({ sessionId, newTurns: turns, isPartial });

  const artifactPath = await writeDebugReviewArtifact({
    instructions: promptPayload.promptText,
    context: promptPayload.contextText,
    promptLabel: turns[turns.length - 1]?.user ?? sessionId,
    sessionId,
    reviewType: 'incremental',
  });

  if (!opencodeSessionId) {
    throw new Error('No active OpenCode session to continue the review.');
  }

  onProgress?.('Sage is thinking...', false);

  const modelToUse = model || DEFAULT_MODEL;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('OpenCode review timed out after 5 minutes')), 5 * 60 * 1000);
  });

  const { critique, streamEvents } = await Promise.race([
    runFollowupReview(
      { sessionId, newTurns: turns, isPartial },
      { onEvent: onStreamEvent, model: modelToUse, opencodeSessionId },
    ),
    timeoutPromise,
  ]);

  return {
    critique,
    transcriptPath,
    completedAt: new Date().toISOString(),
    latestPrompt: turns[turns.length - 1]?.user,
    turnSignature: latestTurnSignature ?? undefined,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
    isFreshCritique: true,
    streamEvents,
    isPartial,
  };
}

function previewText(text: string, maxLength = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

export async function chatWithSage(
  opencodeSessionId: string | null,
  userQuestion: string,
  model: string,
): Promise<{ response: string }> {
  if (!opencodeSessionId) {
    throw new Error('No active OpenCode session for chat.');
  }

  const prompt = `You are now chatting directly with the developer. Respond conversationally; do not use the structured critique schema.\n\n${userQuestion}`;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Chat timed out after 2 minutes')), 2 * 60 * 1000);
  });

  // Use a direct prompt so chat is free-form and not tied to the critique schema
  const { sendPrompt } = await import('./opencode.js');
  const directCall = sendPrompt({ sessionId: opencodeSessionId, prompt, model });
  const result = await Promise.race([directCall, timeoutPromise]);
  return { response: result.text };
}
