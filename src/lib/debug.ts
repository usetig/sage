import path from 'path';
import { promises as fs } from 'fs';

const DEBUG_VALUE = process.env.SAGE_DEBUG ?? '';
const NORMALIZED = DEBUG_VALUE.trim().toLowerCase();

export const DEBUG_MODE = NORMALIZED === '1' || NORMALIZED === 'true' || NORMALIZED === 'yes' || NORMALIZED === 'on';

const DEBUG_DIR = path.join(process.cwd(), '.debug');

export function isDebugMode(): boolean {
  return DEBUG_MODE;
}

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

export async function writeDebugReviewArtifact(
  promptText: string,
  contextText: string,
  userPrompt: string,
): Promise<string> {
  const baseDir = await ensureDebugDir();
  const slug = sanitizeFilename(userPrompt || promptText);
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
  const payload = [
    'Prompt Instructions:',
    promptText,
    '',
    'Context:',
    contextText,
  ].join('\n');
  await fs.writeFile(filePath, payload, 'utf8');
  return filePath;
}

export function debugDirPath(): string {
  return DEBUG_DIR;
}
