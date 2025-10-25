import { promises as fs } from 'fs';
import path from 'path';
import { exportSessionMarkdown } from './specstory.js';
import { extractLatestTurn } from './markdown.js';
import { runOneShotReview } from './codex.js';

export interface ReviewResult {
  critique: string;
  markdownPath: string;
  latestPrompt?: string;
}

export async function performInitialReview(
  sessionId: string,
  onProgress?: (message: string) => void,
): Promise<ReviewResult> {
  onProgress?.('Exporting SpecStory markdown…');
  const markdownPath = await exportSessionMarkdown(sessionId);

  onProgress?.('Reading exported conversation…');
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

export function getSessionOutputDir(sessionId: string): string {
  return path.join(process.cwd(), '.sage', 'sessions', sessionId);
}

function previewText(text: string, maxLength = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
