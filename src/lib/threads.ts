import { promises as fs } from 'fs';
import path from 'path';
import { ensureSession } from './opencode.js';
import { getThreadsDir } from './paths.js';

export interface ThreadMetadata {
  sessionId: string; // Claude session id (human conversation)
  opencodeSessionId: string;
  timestamp: number;
  lastUsed: number;
  lastReviewedTurnCount: number;
  model: string;
}

const THREADS_DIR = getThreadsDir();

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
  opencodeSessionId: string,
  model: string,
  turnCount: number = 0,
): Promise<void> {
  await ensureThreadsDir();
  
  const metadata: ThreadMetadata = {
    sessionId,
    opencodeSessionId,
    model,
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
    const parsed = JSON.parse(content) as Partial<ThreadMetadata> & { threadId?: string };
    if (!parsed.opencodeSessionId && parsed.threadId) {
      // Legacy codex metadata – treat as missing
      return null;
    }

    const opencodeSessionId = parsed.opencodeSessionId ?? '';
    if (!opencodeSessionId) {
      return null;
    }

    const metadata: ThreadMetadata = {
      sessionId,
      opencodeSessionId,
      timestamp: parsed.timestamp ?? Date.now(),
      lastUsed: parsed.lastUsed ?? Date.now(),
      lastReviewedTurnCount: parsed.lastReviewedTurnCount ?? 0,
      model: parsed.model ?? '',
    };
    
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
 * Gets or creates an OpenCode session for a Claude session.
 */
export async function getOrCreateOpencodeSession(
  sessionId: string,
  onProgress?: (message: string) => void,
  model?: string,
): Promise<{ id: string }> {
  const metadata = await loadThreadMetadata(sessionId);

  if (metadata && metadata.opencodeSessionId) {
    onProgress?.('loading previous context...');
    try {
      const session = await ensureSession(metadata.opencodeSessionId, sessionId);
      return { id: session.id };
    } catch {
      await deleteThreadMetadata(sessionId);
    }
  }

  onProgress?.('initializing review agent...');
  const session = await ensureSession(undefined, sessionId);
  await saveThreadMetadata(sessionId, session.id, model ?? '', 0);
  return { id: session.id };
}
