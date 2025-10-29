import { promises as fs } from 'fs';
import type { Thread } from '@openai/codex-sdk';
import { extractTurns, type TurnSummary } from './markdown.js';
import {
  runFollowupReview,
  runInitialReview,
  buildInitialPromptPayload,
  buildFollowupPromptPayload,
  type CritiqueResponse,
  codexInstance,
} from './codex.js';
import { isDebugMode, writeDebugReviewArtifact } from './debug.js';
import { getOrCreateThread, loadThreadMetadata, saveThreadMetadata, updateThreadTurnCount } from './threads.js';

export interface ReviewResult {
  critique: CritiqueResponse;
  markdownPath: string;
  completedAt: string;
  turnSignature?: string;
  latestPrompt?: string;
  debugInfo?: {
    artifactPath: string;
    promptText: string;
  };
  isFreshCritique: boolean;
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

  onProgress?.('reading conversation history...');
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const turns = extractTurns(markdown);
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestPromptPreview = latestTurn?.user
    ? previewText(latestTurn.user)
    : '(none captured)';

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
      completedAt: new Date().toISOString(),
      latestPrompt: latestTurn?.user,
      thread: null,
      turns,
      debugInfo: {
        artifactPath,
        promptText: promptPayload.promptText,
      },
      isFreshCritique: true,
    };
  }

  // Get or resume existing thread for this session
  const metadata = await loadThreadMetadata(sessionId);
  const thread = await getOrCreateThread(codexInstance, sessionId, onProgress);
  
  // Check if this is a resumed thread and if conversation has changed
  const isResumedThread = metadata !== null;
  const currentTurnCount = turns.length;
  const lastReviewedTurnCount = metadata?.lastReviewedTurnCount ?? 0;
  const hasNewTurns = currentTurnCount > lastReviewedTurnCount;
  
  let critique: CritiqueResponse;
  let isFreshCritique = true;
  
  if (isResumedThread && !hasNewTurns) {
    // Thread exists and conversation unchanged - skip review
    onProgress?.('Resuming Sage thread...');
    critique = {
      verdict: 'Approved',
      why: 'Session previously reviewed. Entering continuous mode with existing context.',
      alternatives: '',
      questions: '',
      message_for_agent: '',
    };
    isFreshCritique = false;
  } else if (isResumedThread && hasNewTurns) {
    // Thread exists but conversation has new turns - incremental review
    onProgress?.('examining new dialogue...');
    const newTurns = turns.slice(lastReviewedTurnCount);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Codex review timed out after 10 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runFollowupReview(thread, { sessionId, newTurns });
    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    isFreshCritique = true;

    // Update turn count
    await updateThreadTurnCount(sessionId, currentTurnCount);
  } else {
    // New thread - do initial review
    onProgress?.('analyzing codebase context...');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Codex review timed out after 10 minutes')), 5 * 60 * 1000);
    });

    const reviewPromise = runInitialReview({
      sessionId,
      turns,
      latestTurnSummary: latestTurn ?? undefined,
    }, thread);

    const result = await Promise.race([reviewPromise, timeoutPromise]);
    critique = result.critique;
    isFreshCritique = true;

    // Save thread with turn count (thread ID should be available after first run)
    const threadId = thread.id;
    if (threadId) {
      await saveThreadMetadata(sessionId, threadId, currentTurnCount);
    } else {
      // Thread ID still not available - this shouldn't happen but handle gracefully
      onProgress?.('Warning: thread ID not available for persistence');
    }
  }
  
  const persistedThread = thread;
  const completedAt = new Date().toISOString();

  return {
    critique,
    markdownPath,
    completedAt,
    latestPrompt: latestTurn?.user,
    thread: persistedThread,
    turns,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
    isFreshCritique,
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

  onProgress?.('reviewing changes...');
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
      completedAt: new Date().toISOString(),
      latestPrompt: turns[turns.length - 1]?.user,
      debugInfo: {
        artifactPath,
        promptText: promptPayload.promptText,
      },
      isFreshCritique: true,
    };
  }

  if (!thread) {
    throw new Error('No active Codex thread to continue the review.');
  }

  onProgress?.('Sage is thinking...');

  // Add timeout to prevent infinite hangs
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Codex review timed out after 10 minutes')), 5 * 60 * 1000);
  });

  const reviewPromise = runFollowupReview(thread, { sessionId, newTurns: turns });

  const { critique } = await Promise.race([reviewPromise, timeoutPromise]);

  return {
    critique,
    markdownPath,
    completedAt: new Date().toISOString(),
    latestPrompt: turns[turns.length - 1]?.user,
    debugInfo: {
      artifactPath,
      promptText: promptPayload.promptText,
    },
    isFreshCritique: true,
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
    'IMPORTANT: Be concise. Reference files you already read in the initial review.',
    'Do NOT re-read files unless absolutely necessary to answer the question.',
    '',
    'If they ask you to suggest fixes or write code, politely remind them:',
    '"That\'s outside my scope as a reviewer. I can only explain my critique.',
    'For implementation help, ask your main coding agent (Claude, etc.)."',
    '',
    '# Response Format',
    'Respond conversationally but stay focused on EXPLAINING, not IMPLEMENTING.',
  ].join('\n');

  // Add timeout for clarifications (2 minutes - shorter than reviews)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Clarification timed out after 2 minutes')), 2 * 60 * 1000);
  });

  const clarificationPromise = thread.run(prompt);
  const turn = await Promise.race([clarificationPromise, timeoutPromise]);
  
  return { response: turn.finalResponse as string };
}
