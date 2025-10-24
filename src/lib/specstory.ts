import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_BASE_DIR = path.join(process.cwd(), '.sage', 'sessions');

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
    '-u',
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
