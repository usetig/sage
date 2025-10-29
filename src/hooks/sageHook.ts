/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}

const projectRoot = process.env.CLAUDE_PROJECT_DIR
  ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
  : process.cwd();

const RUNTIME_DIR = path.join(projectRoot, '.sage', 'runtime');
const SESSIONS_DIR = path.join(RUNTIME_DIR, 'sessions');
const QUEUE_DIR = path.join(RUNTIME_DIR, 'needs-review');
const ERROR_LOG = path.join(RUNTIME_DIR, 'hook-errors.log');

function ensureRuntimeDirs(): void {
  for (const dir of [RUNTIME_DIR, SESSIONS_DIR, QUEUE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (error) => reject(error));
  });
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.promises.writeFile(tempPath, contents, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function appendError(message: string): Promise<void> {
  try {
    ensureRuntimeDirs();
    await fs.promises.appendFile(ERROR_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // best effort
  }
}

async function handlePayload(raw: string): Promise<void> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch (error) {
    await appendError(`Failed to parse hook payload: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: eventName } = payload;
  ensureRuntimeDirs();

  if (!sessionId || !eventName || !transcriptPath) {
    await appendError(`Missing required hook fields: ${JSON.stringify(payload)}`);
    return;
  }

  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (eventName === 'SessionEnd') {
    try {
      await removeFileIfExists(sessionFile);
    } catch (error: any) {
      await appendError(`Failed to remove session metadata: ${error.message ?? error}`);
    }

    try {
      const entries = await fs.promises.readdir(QUEUE_DIR);
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(`${sessionId}-`) || entry === sessionId)
          .map((entry) => removeFileIfExists(path.join(QUEUE_DIR, entry))),
      );
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        await appendError(`Failed to clean signals for ${sessionId}: ${error.message ?? error}`);
      }
    }
    return;
  }

  let metadata: any = {};
  try {
    const existing = await fs.promises.readFile(sessionFile, 'utf8');
    metadata = JSON.parse(existing);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      await appendError(`Failed to read session metadata: ${error.message ?? error}`);
    }
  }

  const cleanedCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined;
  const effectiveCwd = cleanedCwd ?? (typeof metadata.cwd === 'string' ? metadata.cwd : undefined);

  metadata.sessionId = sessionId;
  metadata.transcriptPath = transcriptPath;
  if (effectiveCwd) {
    metadata.cwd = effectiveCwd;
  }
  metadata.lastUpdated = Date.now();

  if (eventName === 'UserPromptSubmit' && typeof payload.prompt === 'string') {
    metadata.lastPrompt = payload.prompt;
  }

  if (eventName === 'Stop') {
    metadata.lastStopTime = Date.now();
  }

  if (!metadata.cwd) {
    await appendError(`No cwd available for session ${sessionId} during ${eventName}; proceeding without updating cwd.`);
  }

  try {
    await writeFileAtomic(sessionFile, `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error: any) {
    await appendError(`Failed to write session metadata: ${error.message ?? error}`);
  }

  if (eventName === 'Stop') {
    const signal = {
      sessionId,
      transcriptPath,
      queuedAt: Date.now(),
    };
    try {
      const fileName = `${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
      const uniqueSignalPath = path.join(QUEUE_DIR, fileName);
      await writeFileAtomic(uniqueSignalPath, `${JSON.stringify(signal)}\n`);
    } catch (error: any) {
      await appendError(`Failed to write review signal: ${error.message ?? error}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--install')) {
    ensureRuntimeDirs();
    return;
  }

  try {
    const raw = await readStdin();
    await handlePayload(raw);
  } catch (error) {
    await appendError(`Unhandled hook error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void main();
