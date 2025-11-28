import type { Thread } from '@openai/codex-sdk';
import {
  runFollowupReview,
  runInitialReview,
  buildInitialPromptPayload,
  buildFollowupPromptPayload,
  type CritiqueResponse,
  type StreamEvent,
  codexInstance,
} from './codex.js';
import { extractTurns, type TurnSummary } from './jsonl.js';
import { writeDebugReviewArtifact } from './debug.js';
import { getOrCreateThread, loadThreadMetadata, saveThreadMetadata, updateThreadTurnCount } from './threads.js';

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
  thread: Thread | null;
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
        questions: '',
        message_for_agent: '',
      },
      transcriptPath,
      completedAt: new Date().toISOString(),
      latestPrompt: undefined,
      thread: null,
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
        questions: '',
        message_for_agent: '',
      },
      transcriptPath,
      completedAt: new Date().toISOString(),
      latestPrompt: latestTurn.user,
      thread: null,
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
  const thread = await getOrCreateThread(codexInstance, sessionId, onProgress, model);

  const isResumedThread = metadata !== null;
  const currentTurnCount = turns.length;
  const lastReviewedTurnCount = metadata?.lastReviewedTurnCount ?? 0;
  const hasNewTurns = currentTurnCount > lastReviewedTurnCount;

  let critique: CritiqueResponse;
  let isFreshCritique = true;
  let streamEvents: StreamEvent[] = [];

  if (isResumedThread && !hasNewTurns) {
    onProgress?.('Resuming Sage thread...', false);
    critique = {
      verdict: 'Approved',
      why: 'Session previously reviewed. Entering continuous mode with existing context.',
      alternatives: '',
      questions: '',
      message_for_agent: '',
    };
    isFreshCritique = false;
    streamEvents = [];
  } else if (isResumedThread && hasNewTurns) {
    onProgress?.('examining new dialogue...', false);
    const newTurns = turns.slice(lastReviewedTurnCount);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Codex review timed out after 5 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runFollowupReview(
      thread,
      { sessionId, newTurns },
      { onEvent: onStreamEvent },
    );
    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    streamEvents = result.streamEvents;
    isFreshCritique = true;

    await updateThreadTurnCount(sessionId, currentTurnCount);
  } else {
    onProgress?.('analyzing codebase context...', false);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Codex review timed out after 5 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runInitialReview(
      {
        sessionId,
        turns,
        latestTurnSummary: latestTurn ?? undefined,
      },
      {
        thread,
        promptPayload,
        onEvent: onStreamEvent,
        model,
      },
    );

    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    streamEvents = result.streamEvents;
    isFreshCritique = true;

    const threadId = thread.id;
    if (threadId) {
      await saveThreadMetadata(sessionId, threadId, currentTurnCount);
    } else {
      onProgress?.('Warning: thread ID not available for persistence');
    }
  }

  const completedAt = new Date().toISOString();

  return {
    critique,
    transcriptPath,
    completedAt,
    latestPrompt: latestTurn?.user,
    thread,
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
  thread: Thread | null;
  turns: TurnSummary[];
  latestTurnSignature: string | null;
  isPartial?: boolean;
}

export async function performIncrementalReview(
  request: IncrementalReviewRequest,
  onProgress?: (message: string, isDebug?: boolean) => void,
  onStreamEvent?: (event: StreamEvent) => void,
): Promise<ReviewResult> {
  const { sessionId, transcriptPath, thread, turns, latestTurnSignature, isPartial } = request;
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

  if (!thread) {
    throw new Error('No active Codex thread to continue the review.');
  }

  onProgress?.('Sage is thinking...', false);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Codex review timed out after 5 minutes')), 5 * 60 * 1000);
  });

  const { critique, streamEvents } = await Promise.race([
    runFollowupReview(
      thread,
      { sessionId, newTurns: turns, isPartial },
      { promptPayload, onEvent: onStreamEvent },
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
  thread: Thread | null,
  userQuestion: string,
  sessionId: string,
): Promise<{ response: string }> {
  if (!thread) {
    throw new Error('No active Codex thread for chat.');
  }

  const prompt = `You are now chatting directly with the developer. Respond conversationally - you don't need to follow the structured output schema from your reviews.

${userQuestion}`;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Chat timed out after 2 minutes')), 2 * 60 * 1000);
  });

  const chatPromise = thread.run(prompt);
  const turn = await Promise.race([chatPromise, timeoutPromise]);

  return { response: turn.finalResponse as string };
}
