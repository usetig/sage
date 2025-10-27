import { promises as fs } from 'fs';
import path from 'path';
import type { Thread } from '@openai/codex-sdk';
import { Codex } from '@openai/codex-sdk';

interface ThreadMetadata {
  threadId: string;
  sessionId: string;
  timestamp: number;
  lastUsed: number;
  lastReviewedTurnCount: number; // Track how many turns were last reviewed
}

const THREADS_DIR = '.sage/threads';

/**
 * Ensures the threads directory exists
 */
async function ensureThreadsDir(): Promise<void> {
  try {
    await fs.mkdir(THREADS_DIR, { recursive: true });
  } catch (err) {
    // Ignore if already exists
  }
}

/**
 * Saves thread metadata to disk
 */
export async function saveThreadMetadata(
  sessionId: string,
  threadId: string,
  turnCount: number = 0,
): Promise<void> {
  await ensureThreadsDir();
  
  const metadata: ThreadMetadata = {
    threadId,
    sessionId,
    timestamp: Date.now(),
    lastUsed: Date.now(),
    lastReviewedTurnCount: turnCount,
  };
  
  const filePath = path.join(THREADS_DIR, `${sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Updates the turn count for an existing thread
 */
export async function updateThreadTurnCount(sessionId: string, turnCount: number): Promise<void> {
  const metadata = await loadThreadMetadata(sessionId);
  if (!metadata) return;
  
  metadata.lastReviewedTurnCount = turnCount;
  metadata.lastUsed = Date.now();
  
  const filePath = path.join(THREADS_DIR, `${sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Loads thread metadata from disk
 */
export async function loadThreadMetadata(sessionId: string): Promise<ThreadMetadata | null> {
  const filePath = path.join(THREADS_DIR, `${sessionId}.json`);
  
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const metadata = JSON.parse(content) as ThreadMetadata;
    
    // Update last used timestamp
    metadata.lastUsed = Date.now();
    await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf8');
    
    return metadata;
  } catch (err) {
    // File doesn't exist or is corrupted
    return null;
  }
}

/**
 * Deletes thread metadata from disk
 */
export async function deleteThreadMetadata(sessionId: string): Promise<void> {
  const filePath = path.join(THREADS_DIR, `${sessionId}.json`);
  
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Ignore if file doesn't exist
  }
}

/**
 * Gets or creates a Codex thread for a session
 * If a thread exists for this session, it will be resumed
 * Otherwise, a new thread will be created
 */
export async function getOrCreateThread(
  codex: Codex,
  sessionId: string,
  onProgress?: (message: string) => void,
): Promise<Thread> {
  const metadata = await loadThreadMetadata(sessionId);
  
  if (metadata) {
    onProgress?.(`Resuming previous Codex thread for this session…`);
    try {
      const thread = codex.resumeThread(metadata.threadId);
      const threadIdPreview = metadata.threadId.slice(0, 8);
      onProgress?.(`Resumed thread ${threadIdPreview}…`);
      return thread;
    } catch (err) {
      // Thread couldn't be resumed (might have been deleted on Codex side)
      onProgress?.(`Could not resume thread, creating new one…`);
      await deleteThreadMetadata(sessionId);
    }
  }
  
  // Create new thread
  onProgress?.(`Creating new Codex thread…`);
  const thread = codex.startThread();
  
  // Thread ID might not be immediately available - this is okay
  // We'll save metadata after the first successful review instead
  if (thread.id) {
    await saveThreadMetadata(sessionId, thread.id);
    onProgress?.(`Created thread ${thread.id.slice(0, 8)}…`);
  } else {
    onProgress?.(`Created thread (ID pending)…`);
  }
  
  return thread;
}


