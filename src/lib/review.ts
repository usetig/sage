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
        message_for_agent: '',
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
  
  // Add timeout to prevent infinite hangs
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Codex review timed out after 5 minutes')), 5 * 60 * 1000);
  });
  
  const reviewPromise = runInitialReview({
    sessionId,
    turns,
    latestTurnSummary: latestTurn ?? undefined,
  });
  
  const { thread, critique } = await Promise.race([reviewPromise, timeoutPromise]);

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
        message_for_agent: '',
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
  
  // Add timeout to prevent infinite hangs
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Codex review timed out after 5 minutes')), 5 * 60 * 1000);
  });
  
  const reviewPromise = runFollowupReview(thread, { sessionId, newTurns: turns });
  
  const { critique } = await Promise.race([reviewPromise, timeoutPromise]);
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

export async function clarifyReview(
  thread: Thread | null,
  userQuestion: string,
  sessionId: string,
): Promise<{ response: string }> {
  const debug = isDebugMode();

  if (debug) {
    // Return mock clarification in debug mode
    return {
      response: [
        'Debug mode active — Codex clarification skipped.',
        `Session ID: ${sessionId}`,
        '',
        'Your question:',
        userQuestion,
        '',
        'In a real run, Sage would explain its reasoning here.',
      ].join('\n'),
    };
  }

  if (!thread) {
    throw new Error('No active Codex thread for clarification.');
  }

  const prompt = [
    '# Developer Question About Your Critique',
    userQuestion,
    '',
    '# CRITICAL CONSTRAINTS',
    'Your role is EXPLANATION ONLY. You must:',
    '- Explain your reasoning and what you meant',
    '- Point to specific code locations or patterns',
    '- Clarify why you reached your verdict',
    '- Help the developer understand your review',
    '',
    'You must NEVER:',
    '- Suggest implementations or fixes',
    '- Write code or propose alternatives',
    '- Act as a collaborator or implementer',
    '- Step outside your "reviewer explaining their review" role',
    '',
    '# Instructions',
    'The developer is asking you to clarify your critique. Help them understand:',
    '- What specific code/pattern you were referring to',
    '- Why you flagged it (correctness, consistency, risk, etc.)',
    '- What about the codebase context informed your view',
    '',
    'If they ask you to suggest fixes or write code, politely remind them:',
    '"That\'s outside my scope as a reviewer. I can only explain my critique.',
    'For implementation help, ask your main coding agent (Claude, etc.)."',
    '',
    '# Response Format',
    'Respond conversationally but stay focused on EXPLAINING, not IMPLEMENTING.',
  ].join('\n');

  const turn = await thread.run(prompt);
  return { response: turn.finalResponse as string };
}

