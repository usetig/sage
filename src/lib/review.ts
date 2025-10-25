import { promises as fs } from 'fs';
import { extractLatestTurn } from './markdown.js';
import { runOneShotReview } from './codex.js';

export interface ReviewResult {
  critique: string;
  markdownPath: string;
  latestPrompt?: string;
}

export async function performInitialReview(
  session: { sessionId: string; markdownPath: string },
  onProgress?: (message: string) => void,
): Promise<ReviewResult> {
  const { sessionId, markdownPath } = session;

  onProgress?.('Reading SpecStory markdown…');
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const latestTurn = extractLatestTurn(markdown);
  const latestPromptPreview = latestTurn?.user
    ? previewText(latestTurn.user)
    : '(none captured)';

  onProgress?.(`Latest user prompt: ${latestPromptPreview}`);
  onProgress?.(`Markdown export: ${markdownPath}`);

  onProgress?.('Requesting Codex critique…');
  const critique = await runOneShotReview({
    sessionId,
    markdown,
    latestTurnSummary: latestTurn ?? undefined,
  });

  onProgress?.('Review complete.');

  return {
    critique,
    markdownPath,
    latestPrompt: latestTurn?.user,
  };
}

function previewText(text: string, maxLength = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
