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

  const entriesByUuid = new Map<string, any>();
  const primaryUserPrompts: Array<{ uuid: string; text: string }> = [];
  const assistantEntries: Array<{ uuid: string; parentUuid: string | null; message: any }> = [];
  const errorToolResults: Array<{ parentUuid: string | null }> = [];

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

      const uuid: string | null = typeof entry?.uuid === 'string' ? entry.uuid : null;
      if (uuid) {
        entriesByUuid.set(uuid, entry);
      }

      if (entry?.type === 'user' && entry?.message) {
        if (!uuid) continue;
        if (isErrorToolResult(entry.message)) {
          const parentUuid =
            typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
          errorToolResults.push({ parentUuid });
        }
        if (!isPrimaryUserPrompt(entry)) {
          continue;
        }
    const text = extractText(entry.message);
    if (!text) continue;
    primaryUserPrompts.push({ uuid, text });
      } else if (entry?.type === 'assistant' && entry?.message) {
        const parentUuid: string | null =
          typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
        const assistantUuid: string | null = uuid ?? parentUuid;
        if (!assistantUuid) continue;
        assistantEntries.push({
          uuid: assistantUuid,
          parentUuid,
          message: entry.message,
        });
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const turns: TurnSummary[] = [];
  let latestUuid: string | null = null;
  const primaryUserSet = new Set(primaryUserPrompts.map((item) => item.uuid));
  const responsesByUser = new Map<string, Array<{ uuid: string; message: any }>>();
  const rejectedPrompts = new Set<string>();

  for (const entry of assistantEntries) {
    const rootUuid = resolveRootUserUuid(entry.parentUuid, entriesByUuid, primaryUserSet);
    if (!rootUuid) continue;
    if (!responsesByUser.has(rootUuid)) {
      responsesByUser.set(rootUuid, []);
    }
    responsesByUser.get(rootUuid)!.push({ uuid: entry.uuid, message: entry.message });
  }

  for (const errorEntry of errorToolResults) {
    const rootUuid = resolveRootUserUuid(errorEntry.parentUuid, entriesByUuid, primaryUserSet);
    if (rootUuid) {
      rejectedPrompts.add(rootUuid);
    }
  }

  for (const userEntry of primaryUserPrompts) {
    const responses = responsesByUser.get(userEntry.uuid) ?? [];
    const agentPieces: string[] = [];
    let lastAssistantUuid: string | undefined;

    for (const response of responses) {
      const formatted = formatAssistantMessage(response.message);
      if (formatted.trim()) {
        agentPieces.push(formatted.trim());
      }
      lastAssistantUuid = response.uuid;
      latestUuid = response.uuid;
    }

    if (rejectedPrompts.has(userEntry.uuid)) {
      continue;
    }

    const assistantText = agentPieces.length ? agentPieces.join('\n\n') : undefined;
    const summary: TurnSummary = {
      user: userEntry.text,
      agent: assistantText,
      userUuid: userEntry.uuid,
      assistantUuid: lastAssistantUuid,
    };
    turns.push(summary);
  }

  if (sinceUuid) {
    const index = turns.findIndex((turn) => turn.assistantUuid === sinceUuid);
    if (index >= 0) {
      turns.splice(0, index + 1);
    }
  }

  return { turns, latestTurnUuid: latestUuid };
}

function isPrimaryUserPrompt(entry: any): boolean {
  if (!entry || entry.type !== 'user') return false;
  const message = entry.message;
  if (!message || message.role !== 'user') return false;
  if (!hasThinkingMetadata(entry.thinkingMetadata)) return false;
  return extractText(message).trim().length > 0;
}

function hasThinkingMetadata(metadata: any): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return true;
}

function isErrorToolResult(message: any): boolean {
  if (!message) return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((item: any) => {
    if (!item || typeof item !== 'object') return false;
    if (item.type !== 'tool_result') return false;
    if (item.is_error === true) return true;
    const text = typeof item.content === 'string' ? item.content : '';
    return typeof text === 'string'
      && /rejected|interrupted/i.test(text);
  });
}

function resolveRootUserUuid(
  parentUuid: string | null,
  entriesByUuid: Map<string, any>,
  primaryUserSet: Set<string>,
): string | null {
  let current = parentUuid ?? null;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) {
      return null;
    }
    visited.add(current);
    if (primaryUserSet.has(current)) {
      return current;
    }
    const parentEntry = entriesByUuid.get(current);
    if (!parentEntry) {
      return null;
    }
    const nextParent =
      typeof parentEntry.parentUuid === 'string' ? parentEntry.parentUuid : null;
    current = nextParent;
  }
  return null;
}

function formatAssistantMessage(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.content === 'string') return message.content;
  const content = message.content;
  if (!Array.isArray(content)) return '';

  const pieces: string[] = [];
  for (const chunk of content) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      const text = chunk.text.trim();
      if (text) {
        pieces.push(text);
      }
      continue;
    }
    if (chunk.type === 'tool_use') {
      const name = typeof chunk.name === 'string' ? chunk.name : '';
      if (!shouldIncludeToolUse(name)) continue;
      const header = name ? `[Tool ${name}]` : '[Tool]';
      const rendered = stringifyToolInput(chunk.input);
      pieces.push(rendered ? `${header}\n${rendered}` : header);
    }
  }
  return pieces.join('\n\n');
}

const IGNORED_TOOL_NAMES = new Set(['Read', 'Task']);

function shouldIncludeToolUse(name: string): boolean {
  if (!name) return false;
  return !IGNORED_TOOL_NAMES.has(name);
}

function stringifyToolInput(input: any): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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
