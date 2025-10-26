import { promises as fs } from 'fs';
import type { Thread } from '@openai/codex-sdk';
import { extractTurns, type TurnSummary } from './markdown.js';
import {
  runFollowupReview,
  runInitialReview,
  buildInitialPromptPayload,
  buildFollowupPromptPayload,
  type CritiqueResponse,
} from './codex.js';
import { isDebugMode, writeDebugReviewArtifact } from './debug.js';

export interface ReviewResult {
  critique: CritiqueResponse;
  markdownPath: string;
  latestPrompt?: string;
  debugInfo?: {
    artifactPath: string;
    promptText: string;
  };
}

export type InitialReviewResult = ReviewResult & {
  thread: Thread | null;
  turns: TurnSummary[];
};

export async function performInitialReview(
  session: { sessionId: string; markdownPath: string },
  onProgress?: (message: string) => void,
): Promise<InitialReviewResult> {
  const { sessionId, markdownPath } = session;
  const debug = isDebugMode();

  onProgress?.('Reading SpecStory markdown…');
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const turns = extractTurns(markdown);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestPromptPreview = latestTurn?.user
    ? previewText(latestTurn.user)
    : '(none captured)';

  onProgress?.(`Latest user prompt: ${latestPromptPreview}`);
  onProgress?.(`Markdown export: ${markdownPath}`);

  const promptPayload = buildInitialPromptPayload({
    sessionId,
    turns,
    latestTurnSummary: latestTurn ?? undefined,
  });

  // Always create debug artifact regardless of debug mode
  const artifactPath = await writeDebugReviewArtifact({
    fullPrompt: promptPayload.prompt,
    instructions: promptPayload.promptText,
    context: promptPayload.contextText,
    promptLabel: latestTurn?.user ?? sessionId,
  });

  if (debug) {
    onProgress?.('[Debug] Skipping Codex critique.');
    const debugWhy = [
      'Debug mode active — Codex call skipped.',
      `Session ID: ${sessionId}`,
      `SpecStory markdown: ${markdownPath}`,
      `Context file: ${artifactPath}`,
      '',
      'Prompt text:',
      promptPayload.promptText,
    ].join('\n');

    return {
      critique: {
        verdict: 'Approved',
        why: debugWhy,
        alternatives: '',
        questions: '',
      },
      markdownPath,
      latestPrompt: latestTurn?.user,
      thread: null,
      turns,
      debugInfo: {
        artifactPath,
        promptText: promptPayload.promptText,
      },
    };
  }

  onProgress?.('Requesting Codex critique…');
  const { thread, critique } = await runInitialReview({
    sessionId,
    turns,
    latestTurnSummary: latestTurn ?? undefined,
  });

  onProgress?.('Review complete.');

  return {
    critique,
    markdownPath,
    latestPrompt: latestTurn?.user,
    thread,
    turns,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
  };
}

export interface IncrementalReviewRequest {
  sessionId: string;
  markdownPath: string;
  thread: Thread | null;
  turns: TurnSummary[];
}

export async function performIncrementalReview(
  request: IncrementalReviewRequest,
  onProgress?: (message: string) => void,
): Promise<ReviewResult> {
  const { sessionId, markdownPath, thread, turns } = request;
  if (!turns.length) {
    throw new Error('No new turns provided for incremental review.');
  }
  const debug = isDebugMode();

  const firstPromptPreview = previewText(turns[0].user);
  onProgress?.(`Reviewing new turn(s) starting with: ${firstPromptPreview}`);
  const promptPayload = buildFollowupPromptPayload({ sessionId, newTurns: turns });

  // Always create debug artifact regardless of debug mode
  const artifactPath = await writeDebugReviewArtifact({
    fullPrompt: promptPayload.prompt,
    instructions: promptPayload.promptText,
    context: promptPayload.contextText,
    promptLabel: turns[0]?.user ?? sessionId,
  });

  if (debug) {
    onProgress?.('[Debug] Skipping Codex critique.');
    return {
      critique: {
        verdict: 'Approved',
        why: [
          'Debug mode active — Codex call skipped.',
          `Session ID: ${sessionId}`,
          `SpecStory markdown: ${markdownPath}`,
          `Context file: ${artifactPath}`,
          '',
          'Prompt text:',
          promptPayload.promptText,
        ].join('\n'),
        alternatives: '',
        questions: '',
      },
      markdownPath,
      latestPrompt: turns[turns.length - 1]?.user,
      debugInfo: {
        artifactPath,
        promptText: promptPayload.promptText,
      },
    };
  }

  if (!thread) {
    throw new Error('No active Codex thread to continue the review.');
  }

  onProgress?.('Requesting Codex critique…');
  const { critique } = await runFollowupReview(thread, { sessionId, newTurns: turns });
  onProgress?.('Review complete.');

  return {
    critique,
    markdownPath,
    latestPrompt: turns[turns.length - 1]?.user,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
  };
}

function previewText(text: string, maxLength = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
