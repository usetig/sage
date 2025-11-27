import path from 'path';
import { promises as fs } from 'fs';

const DEBUG_DIR = path.join(process.cwd(), '.debug');

export async function ensureDebugDir(): Promise<string> {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  return DEBUG_DIR;
}

function sanitizeFilename(value: string): string {
  const replaced = value.replace(/\s+/g, '-');
  const cleaned = replaced.replace(/[^a-zA-Z0-9\-_.]/g, '');
  const trimmed = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (trimmed) return trimmed.slice(0, 60);
  return 'prompt';
}

export interface DebugArtifactPayload {
  instructions: string;
  context: string;
  promptLabel?: string;
  sessionId?: string;
  reviewType?: 'initial' | 'incremental';
}

export async function writeDebugReviewArtifact(
  payload: DebugArtifactPayload,
): Promise<string> {
  const baseDir = await ensureDebugDir();
  const nameSource = payload.promptLabel
    || payload.instructions.split('\n')[0]
    || 'prompt';
  const slug = sanitizeFilename(nameSource);
  const baseName = `review-${slug || 'prompt'}`;
  let attempt = 0;
  let filePath: string;

  while (true) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const fileName = `${baseName}${suffix}.txt`;
    filePath = path.join(baseDir, fileName);
    try {
      await fs.access(filePath);
      attempt += 1;
      if (attempt > 100) {
        throw new Error('Unable to create unique debug artifact filename.');
      }
    } catch {
      break;
    }
  }
  const header = [
    '=' .repeat(80),
    'CODEX PROMPT DEBUG ARTIFACT',
    '=' .repeat(80),
    payload.sessionId ? `Session: ${payload.sessionId}` : '',
    payload.reviewType ? `Review Type: ${payload.reviewType === 'initial' ? 'Initial Review' : 'Incremental Review'}` : '',
  ].filter(Boolean).join('\n');

  const fileContents = [
    header,
    '',
    '=' .repeat(80),
    'INSTRUCTIONS',
    '=' .repeat(80),
    '',
    payload.instructions,
    '',
    '=' .repeat(80),
    'CONTEXT (Conversation Turns)',
    '=' .repeat(80),
    '',
    payload.context,
  ].join('\n');
  await fs.writeFile(filePath, fileContents, 'utf8');
  return filePath;
}

export function debugDirPath(): string {
  return DEBUG_DIR;
}
