import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_BASE_DIR = path.join(process.cwd(), '.sage', 'sessions');
const HISTORY_BASE_DIR = path.join(process.cwd(), '.sage', 'history');

export interface ExportOptions {
  baseDir?: string;
  specstoryBin?: string;
}

export class SpecstoryExportError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'SpecstoryExportError';
  }
}

export async function exportSessionMarkdown(sessionId: string, options: ExportOptions = {}): Promise<string> {
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
  const specstoryBin = options.specstoryBin ?? 'specstory';
  const sessionDir = path.join(baseDir, sessionId);

  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await clearDirectory(sessionDir);

    await runSpecstory(specstoryBin, sessionId, sessionDir);

    const markdownPath = await findSessionMarkdown(sessionDir, sessionId);
    if (!markdownPath) {
      throw new SpecstoryExportError(`No markdown export produced for session ${sessionId}`);
    }

    await ensureSessionMarker(markdownPath, sessionId);
    return markdownPath;
  } catch (error) {
    if (error instanceof SpecstoryExportError) throw error;
    throw new SpecstoryExportError(`Failed to export SpecStory markdown for ${sessionId}`, error);
  }
}

async function runSpecstory(specstoryBin: string, sessionId: string, outputDir: string): Promise<void> {
  const args = [
    'sync',
    'claude',
    '-s',
    sessionId,
    '--output-dir',
    outputDir,
    '--no-version-check',
    '--silent',
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(specstoryBin, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new SpecstoryExportError(`SpecStory exited with status ${code}`));
    });
  });
}

async function findSessionMarkdown(outputDir: string, sessionId: string): Promise<string | null> {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(outputDir, entry.name));

  if (!markdownFiles.length) return null;
  if (markdownFiles.length === 1) return markdownFiles[0];

  const candidates: string[] = [];
  for (const filePath of markdownFiles) {
    const slice = await readFilePrefix(filePath, 512);
    if (slice.includes(sessionId)) {
      candidates.push(filePath);
    }
  }

  if (candidates.length === 1) return candidates[0];
  return candidates[0] ?? null;
}

async function readFilePrefix(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.slice(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function ensureSessionMarker(filePath: string, sessionId: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf8');
  if (!content.includes(`Claude Code Session ${sessionId}`)) {
    throw new SpecstoryExportError(`Exported markdown missing session marker for ${sessionId}`);
  }
}

async function clearDirectory(dirPath: string): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch((error: any) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
    }),
  );
}

export interface SpecstorySessionSummary {
  sessionId: string;
  title: string;
  timestamp: string | null;
  markdownPath: string;
  isWarmup: boolean;
  initialPrompt?: string;
}

export async function syncSpecstoryHistory(options: { specstoryBin?: string } = {}): Promise<void> {
  const specstoryBin = options.specstoryBin ?? 'specstory';

  await fs.mkdir(HISTORY_BASE_DIR, { recursive: true });

  const args = ['sync', 'claude', '--output-dir', HISTORY_BASE_DIR, '--no-version-check', '--silent'];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(specstoryBin, args, { stdio: 'ignore' });
    child.on('error', (error) => {
      reject(new SpecstoryExportError('Failed to start SpecStory sync command', error));
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new SpecstoryExportError(`SpecStory sync exited with status ${code}`));
    });
  });
}

export async function listSpecstorySessions(): Promise<SpecstorySessionSummary[]> {
  await fs.mkdir(HISTORY_BASE_DIR, { recursive: true });
  const entries = await fs.readdir(HISTORY_BASE_DIR, { withFileTypes: true });
  const sessions: SpecstorySessionSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(HISTORY_BASE_DIR, entry.name);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      continue;
    }

    const summary = await parseSpecstoryMarkdown(filePath, stats.mtime);
    if (summary) {
      sessions.push(summary);
    }
  }

  return sessions.sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      const aTime = new Date(a.timestamp).valueOf();
      const bTime = new Date(b.timestamp).valueOf();
      if (!Number.isNaN(bTime - aTime)) return bTime - aTime;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });
}

async function parseSpecstoryMarkdown(
  filePath: string,
  modifiedTime: Date,
): Promise<SpecstorySessionSummary | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return null;
  }

  const sessionMatch = content.match(/<!--\s*Claude Code Session\s+([a-f0-9-]+)\s+\(([^)]+)\)\s*-->/i);
  if (!sessionMatch) return null;

  const sessionId = sessionMatch[1];

  const baseName = path.basename(filePath, '.md');

  const mainUserMatch = content.match(/_\*\*User\*\*_\s*\n+([\s\S]*?)(?=\n-{3,}|_\*\*Agent|\Z)/);
  const initialPrompt = mainUserMatch ? cleanupPreview(mainUserMatch[1]) : undefined;
  const isWarmup = !initialPrompt;

  const headingMatch = content.match(/^#\s+(.+)\s*$/m);
  let heading = headingMatch ? headingMatch[1].trim() : '';
  if (heading) {
    heading = heading.replace(/\s*\([^()]*\)\s*$/, '').trim();
  }

  const slugTitle = deriveTitleFromFilename(baseName);
  const title = initialPrompt ?? (heading || slugTitle || baseName);

  const timestamp = modifiedTime.toISOString();

  return {
    sessionId,
    title,
    timestamp,
    markdownPath: filePath,
    isWarmup,
    initialPrompt,
  };
}

function deriveTitleFromFilename(baseName: string): string {
  const parts = baseName.split('_');
  if (parts.length <= 2) return baseName;
  const slugParts = parts.slice(2).join(' ');
  const cleaned = slugParts.replace(/-/g, ' ').trim();
  if (!cleaned) return baseName;
  return capitalizeWords(cleaned);
}

function cleanupPreview(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 120) return singleLine;
  return `${singleLine.slice(0, 119)}…`;
}

function capitalizeWords(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}
