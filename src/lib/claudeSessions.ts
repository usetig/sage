import { createReadStream, Dirent, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

export interface ClaudeSessionMetadata {
  sessionId: string;
  cwd: string;
  title: string;
  initialPrompt: string;
  timestamp: string | null;
  projectDir: string;
  logPath: string;
  isWarmup: boolean;
}

const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');

export class ClaudeSessionsError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'ClaudeSessionsError';
  }
}

export async function listClaudeSessions(): Promise<ClaudeSessionMetadata[]> {
  try {
    const projects = await safeReadDir(CLAUDE_PROJECTS_DIR);
    const sessions: ClaudeSessionMetadata[] = [];

    for (const entry of projects) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry.name);
      const files = await safeReadDir(projectDir);

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const logPath = path.join(projectDir, file.name);
        const metadata = await readSessionMetadata(logPath, file.name, projectDir);
        if (!metadata) continue;

        sessions.push({
          ...metadata,
          projectDir,
          logPath,
        });
      }
    }

    return sessions.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  } catch (error) {
    throw new ClaudeSessionsError('Failed to list Claude sessions', error);
  }
}

function normalizeMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  if (raw && typeof raw === 'object' && 'text' in (raw as { text?: unknown })) {
    const text = (raw as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function isMainUserPrompt(parsed: any): boolean {
  if (parsed?.isSidechain) return false;
  if (parsed?.type === 'user') return parsed.parentUuid === null || parsed.parentUuid === undefined;
  return parsed?.message?.role === 'user' && !parsed.isSidechain;
}

function extractTimestamp(parsed: any): string | null {
  if (typeof parsed?.timestamp === 'string') return parsed.timestamp;
  if (typeof parsed?.createdAt === 'string') return parsed.createdAt;
  if (parsed?.message && typeof parsed.message?.timestamp === 'string') return parsed.message.timestamp;
  return null;
}

async function safeReadDir(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readSessionMetadata(
  filePath: string,
  fileName: string,
  defaultCwd: string,
): Promise<Omit<ClaudeSessionMetadata, 'projectDir' | 'logPath'> | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const accumulator: {
    sessionId?: string;
    cwd?: string;
    firstUserPrompt?: string;
    firstMainPrompt?: string;
    firstNonWarmupPrompt?: string;
    summaryTitle?: string;
    timestamp?: string;
  } = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!accumulator.sessionId && typeof parsed.sessionId === 'string') {
        accumulator.sessionId = parsed.sessionId;
      }

      if (!accumulator.cwd && typeof parsed.cwd === 'string') {
        accumulator.cwd = parsed.cwd;
      }

      if (!accumulator.timestamp) {
        const ts = extractTimestamp(parsed);
        if (ts) accumulator.timestamp = ts;
      }

      if (parsed?.type === 'summary') {
        const summaryText =
          typeof parsed.summary === 'string'
            ? parsed.summary
            : typeof parsed.title === 'string'
              ? parsed.title
              : undefined;
        if (summaryText) {
          accumulator.summaryTitle = summaryText;
        }
      }

      if (!accumulator.firstUserPrompt && parsed?.type === 'user' && parsed.message?.content) {
        const normalized = normalizeMessage(parsed.message.content);
        if (normalized) {
          accumulator.firstUserPrompt = normalized;
        }
      }

      if (isMainUserPrompt(parsed) && parsed.message?.content) {
        const normalized = normalizeMessage(parsed.message.content);
        if (normalized) {
          if (!accumulator.firstMainPrompt) {
            accumulator.firstMainPrompt = normalized;
          }
          if (!accumulator.firstNonWarmupPrompt && !isWarmupText(normalized)) {
            accumulator.firstNonWarmupPrompt = normalized;
          }
          if (accumulator.firstMainPrompt && accumulator.firstNonWarmupPrompt) {
            break;
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const sessionId = accumulator.sessionId ?? fileName.replace(/\.jsonl$/, '');
  const cwd = accumulator.cwd ?? defaultCwd;
  const titleCandidate =
    accumulator.firstNonWarmupPrompt ??
    accumulator.summaryTitle ??
    accumulator.firstMainPrompt ??
    '';
  const title = titleCandidate || 'Untitled session';
  const timestamp = accumulator.timestamp ?? null;
  const initialPrompt =
    accumulator.firstNonWarmupPrompt ??
    accumulator.firstMainPrompt ??
    accumulator.summaryTitle ??
    '';
  const warmupCandidate = accumulator.firstNonWarmupPrompt
    ? ''
    : accumulator.firstMainPrompt ?? accumulator.firstUserPrompt ?? '';
  const isWarmup =
    Boolean(warmupCandidate) && !accumulator.firstNonWarmupPrompt && isWarmupText(warmupCandidate);

  if (!sessionId) return null;

  return {
    sessionId,
    cwd,
    title,
    initialPrompt,
    timestamp,
    isWarmup,
  };
}

function isWarmupText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === 'warmup' || normalized === 'warm up';
}
