import fs from 'fs';
import path from 'path';
import readline from 'readline';

export interface SessionMetadata {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  lastPrompt?: string;
  lastStopTime?: number;
  lastUpdated: number;
}

export interface ActiveSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  lastPrompt?: string;
  lastStopTime?: number;
  lastUpdated: number;
  title: string;
}

export interface ExtractedTurns {
  turns: TurnSummary[];
  latestTurnUuid: string | null;
}

export interface TurnSummary {
  user: string;
  agent?: string;
  userUuid?: string;
  assistantUuid?: string;
}

const RUNTIME_DIR = path.join(process.cwd(), '.sage', 'runtime');
const SESSIONS_DIR = path.join(RUNTIME_DIR, 'sessions');

function readJson(filePath: string): SessionMetadata | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SessionMetadata;
    if (!parsed?.sessionId || !parsed?.transcriptPath || !parsed?.cwd) {
      return null;
    }
    return parsed;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[Sage] Failed to read session metadata ${filePath}: ${error?.message ?? error}`);
    }
    return null;
  }
}

export async function listActiveSessions(): Promise<ActiveSession[]> {
  const entries: string[] = [];
  try {
    entries.push(...fs.readdirSync(SESSIONS_DIR));
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const sessions: ActiveSession[] = [];
  for (const entry of entries) {
    const metaPath = path.join(SESSIONS_DIR, entry);
    const metadata = readJson(metaPath);
    if (!metadata) continue;
    if (!fs.existsSync(metadata.transcriptPath)) {
      continue;
    }
    const isWarmup = await isWarmupSession(metadata.transcriptPath);
    if (isWarmup) continue;
    sessions.push({
      ...metadata,
      title: metadata.lastPrompt ? previewText(metadata.lastPrompt) : metadata.sessionId,
    });
  }

  sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
  return sessions;
}

export async function extractTurns(options: {
  transcriptPath: string;
  sinceUuid?: string | null;
}): Promise<ExtractedTurns> {
  const { transcriptPath, sinceUuid } = options;
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const userEntries: Array<{ uuid: string; text: string }> = [];
  const assistantByParent = new Map<string, { text: string[]; uuid: string }>();

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        console.warn('[Sage] Skipping invalid JSONL line in transcript.');
        continue;
      }

      if (entry?.isSidechain) continue;
      if (entry?.isCompactSummary || entry?.isMeta) continue;

      if (entry?.type === 'user' && entry?.message) {
        const text = extractText(entry.message);
        if (!text) continue;
        userEntries.push({ uuid: entry.uuid ?? '', text });
      } else if (entry?.type === 'assistant' && entry?.message && entry?.parentUuid) {
        const text = extractText(entry.message);
        if (!text) continue;
        const existing = assistantByParent.get(entry.parentUuid);
        if (existing) {
          existing.text.push(text);
        } else {
          const assistantUuid = entry.uuid ?? entry.parentUuid;
          assistantByParent.set(entry.parentUuid, {
            uuid: assistantUuid,
            text: [text],
          });
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const turns: TurnSummary[] = [];
  let latestUuid: string | null = null;
  for (const userEntry of userEntries) {
    const assistant = assistantByParent.get(userEntry.uuid);
    const assistantText = assistant ? assistant.text.join('\n\n') : undefined;
    const summary: TurnSummary = {
      user: userEntry.text,
      agent: assistantText,
      userUuid: userEntry.uuid,
      assistantUuid: assistant?.uuid,
    };
    turns.push(summary);
    if (assistant?.uuid) {
      latestUuid = assistant.uuid;
    }
  }

  if (sinceUuid) {
    const index = turns.findIndex((turn) => turn.assistantUuid === sinceUuid);
    if (index >= 0) {
      turns.splice(0, index + 1);
    }
  }

  return { turns, latestTurnUuid: latestUuid };
}

async function isWarmupSession(transcriptPath: string): Promise<boolean> {
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.isSidechain) continue;
      if (entry?.isCompactSummary || entry?.isMeta) continue;
      if (entry?.type === 'user' && entry?.message) {
        const text = extractText(entry.message);
        if (!text) return false;
        return text.trim().toLowerCase() === 'warmup';
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return false;
}

function extractText(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message?.content === 'string') return message.content;
  const content = message.content;
  if (Array.isArray(content)) {
    const pieces = content
      .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text.trim())
      .filter(Boolean);
    return pieces.join('\n\n');
  }
  return '';
}

function previewText(value: string, maxLength = 80): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}
