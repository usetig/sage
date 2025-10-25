import { promises as fs } from 'fs';
import type { Thread } from '@openai/codex-sdk';
import { extractLatestTurn, extractTurns, type TurnSummary } from './markdown.js';
import { runFollowupReview, runInitialReview } from './codex.js';

export interface ReviewResult {
  critique: string;
  markdownPath: string;
  latestPrompt?: string;
}

export type InitialReviewResult = ReviewResult & {
  thread: Thread;
  turns: TurnSummary[];
};

export async function performInitialReview(
  session: { sessionId: string; markdownPath: string },
  onProgress?: (message: string) => void,
): Promise<InitialReviewResult> {
  const { sessionId, markdownPath } = session;

  onProgress?.('Reading SpecStory markdown…');
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const turns = extractTurns(markdown);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestPromptPreview = latestTurn?.user
    ? previewText(latestTurn.user)
    : '(none captured)';

  onProgress?.(`Latest user prompt: ${latestPromptPreview}`);
  onProgress?.(`Markdown export: ${markdownPath}`);

  onProgress?.('Requesting Codex critique…');
  const { thread, critique } = await runInitialReview({
    sessionId,
    markdown,
    latestTurnSummary: latestTurn ?? undefined,
  });

  onProgress?.('Review complete.');

  return {
    critique,
    markdownPath,
    latestPrompt: latestTurn?.user,
    thread,
    turns,
  };
}

export interface IncrementalReviewRequest {
  sessionId: string;
  markdownPath: string;
  thread: Thread;
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

  const firstPromptPreview = previewText(turns[0].user);
  onProgress?.(`Reviewing new turn(s) starting with: ${firstPromptPreview}`);
  onProgress?.('Requesting Codex critique…');
  const critique = await runFollowupReview(thread, { sessionId, newTurns: turns });
  onProgress?.('Review complete.');

  return {
    critique,
    markdownPath,
    latestPrompt: turns[turns.length - 1]?.user,
  };
}

function previewText(text: string, maxLength = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
