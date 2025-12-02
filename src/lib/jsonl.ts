import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getSessionsDir } from './paths.js';

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
  isPartial?: boolean;
}

const SESSIONS_DIR = getSessionsDir();

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
    // Skip non-JSON files (e.g., .DS_Store on macOS)
    if (!entry.endsWith('.json')) continue;
    const metaPath = path.join(SESSIONS_DIR, entry);
    const metadata = readJson(metaPath);
    if (!metadata) continue;
    if (!fs.existsSync(metadata.transcriptPath)) {
      continue;
    }
    const isWarmup = await isWarmupSession(metadata.transcriptPath);
    if (isWarmup) continue;

    let titlePrompt: string | undefined = metadata.lastPrompt;
    if (!titlePrompt) {
      titlePrompt = (await getLastPromptFromTranscript(metadata.transcriptPath)) ?? undefined;
    }

    sessions.push({
      ...metadata,
      title: titlePrompt ? previewText(titlePrompt) : 'New conversation',
    });
  }

  sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
  return sessions;
}

export async function extractTurns(options: {
  transcriptPath: string;
  sinceUuid?: string | null;
  includeIncomplete?: boolean;
}): Promise<ExtractedTurns> {
  const { transcriptPath, sinceUuid, includeIncomplete = false } = options;
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const entriesByUuid = new Map<string, any>();
  const primaryUserPrompts: Array<{ uuid: string; text: string }> = [];
  const assistantEntries: Array<{ uuid: string; parentUuid: string | null; message: any; seq: number }> = [];
  const errorToolResults: Array<{ parentUuid: string | null; seq: number }> = [];
  const toolResultsById = new Map<string, string[]>();
  let sequence = 0;

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
      sequence += 1;
      if (uuid) {
        entriesByUuid.set(uuid, entry);
      }

      if (entry?.type === 'user' && entry?.message) {
        if (!uuid) continue;
        collectToolResultSummaries(entry.message, toolResultsById);
        if (isErrorToolResult(entry.message)) {
          const parentUuid =
            typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
          errorToolResults.push({ parentUuid, seq: sequence });
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
          seq: sequence,
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
  const responsesByUser = new Map<string, Array<{ uuid: string; message: any; seq: number }>>();
  const errorMarkers = new Map<string, number[]>();

  for (const entry of assistantEntries) {
    const rootUuid = resolveRootUserUuid(entry.parentUuid, entriesByUuid, primaryUserSet);
    if (!rootUuid) continue;
    if (!responsesByUser.has(rootUuid)) {
      responsesByUser.set(rootUuid, []);
    }
    responsesByUser.get(rootUuid)!.push({ uuid: entry.uuid, message: entry.message, seq: entry.seq });
  }

  for (const marker of errorToolResults) {
    const rootUuid = resolveRootUserUuid(marker.parentUuid, entriesByUuid, primaryUserSet);
    if (!rootUuid) continue;
    if (!errorMarkers.has(rootUuid)) {
      errorMarkers.set(rootUuid, []);
    }
    errorMarkers.get(rootUuid)!.push(marker.seq);
  }

  for (const userEntry of primaryUserPrompts) {
    const responses = responsesByUser.get(userEntry.uuid) ?? [];
    responses.sort((a, b) => a.seq - b.seq);

    const agentPieces: string[] = [];
    let lastAssistantUuid: string | undefined;
    let candidateLatestUuid: string | undefined;
    let hasText = false;
    let lastTextSeq = -Infinity;
    let lastResponseSeq = -Infinity;

    for (const response of responses) {
      lastResponseSeq = Math.max(lastResponseSeq, response.seq);
      const { text: formatted, hasTextResponse } = formatAssistantMessage(response.message, toolResultsById);
      const trimmed = formatted.trim();
      if (trimmed) {
        agentPieces.push(trimmed);
      }
      if (hasTextResponse) {
        hasText = true;
        lastTextSeq = Math.max(lastTextSeq, response.seq);
        lastAssistantUuid = response.uuid;
        candidateLatestUuid = response.uuid;
      }
    }

    const isIncomplete = lastResponseSeq > lastTextSeq;
    const shouldEmit =
      hasText ||
      (includeIncomplete && isIncomplete && agentPieces.length > 0);

    if (!shouldEmit) {
      if (candidateLatestUuid) {
        latestUuid = candidateLatestUuid;
      }
      continue;
    }

    if (!includeIncomplete && isIncomplete) {
      if (candidateLatestUuid) {
        latestUuid = candidateLatestUuid;
      }
      continue;
    }

    const errorSeqs = errorMarkers.get(userEntry.uuid) ?? [];
    const latestErrorSeq = errorSeqs.length ? Math.max(...errorSeqs) : -Infinity;
    if (latestErrorSeq !== -Infinity && lastTextSeq <= latestErrorSeq) {
      continue;
    }

    const assistantText = agentPieces.length ? agentPieces.join('\n\n') : undefined;
    const summary: TurnSummary = {
      user: userEntry.text,
      agent: assistantText,
      userUuid: userEntry.uuid,
      assistantUuid: lastAssistantUuid,
      isPartial: isIncomplete,
    };
    turns.push(summary);

    if (candidateLatestUuid) {
      latestUuid = candidateLatestUuid;
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

function formatAssistantMessage(
  message: any,
  toolResultsById: Map<string, string[]>,
): { text: string; hasTextResponse: boolean } {
  if (!message) return { text: '', hasTextResponse: false };
  if (typeof message === 'string') return { text: message, hasTextResponse: true };
  if (typeof message.content === 'string') {
    return { text: message.content, hasTextResponse: true };
  }
  const content = message.content;
  if (!Array.isArray(content)) return { text: '', hasTextResponse: false };

  const pieces: string[] = [];
  let hasText = false;
  for (const chunk of content) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      const text = chunk.text.trim();
      if (text) {
        pieces.push(text);
      }
      hasText = true;
      continue;
    }
    if (chunk.type === 'tool_use') {
      const name = typeof chunk.name === 'string' ? chunk.name : '';
      if (name === 'ExitPlanMode') {
        const planText = extractPlanText(chunk.input);
        if (planText) {
          pieces.push(planText);
          hasText = true;
          continue;
        }
      }
      if (!shouldIncludeToolUse(name)) continue;
      const header = name ? `[Tool ${name}]` : '[Tool]';
      const rendered = stringifyToolInput(chunk.input);
      pieces.push(rendered ? `${header}\n${rendered}` : header);
      const toolId = typeof chunk.id === 'string' ? chunk.id : null;
      if (toolId) {
        const summaries = toolResultsById.get(toolId);
        if (summaries?.length) {
          for (const summary of summaries) {
            pieces.push(summary);
          }
        }
      }
    }
  }
  return { text: pieces.join('\n\n'), hasTextResponse: hasText };
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

function extractPlanText(input: any): string | null {
  if (!input || typeof input !== 'object') return null;
  const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
  if (!plan) return null;
  return ['Claude plan proposal:', plan].join('\n\n');
}

function collectToolResultSummaries(message: any, store: Map<string, string[]>): void {
  if (!message || typeof message !== 'object') return;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const chunk of content) {
    if (!chunk || typeof chunk !== 'object' || chunk.type !== 'tool_result') continue;
    const toolId = typeof chunk.tool_use_id === 'string' ? chunk.tool_use_id : null;
    if (!toolId) continue;

    const summaries = store.get(toolId) ?? [];
    const directText = extractToolResultContent(chunk.content);
    if (directText) {
      summaries.push(directText);
    }

    const structured = chunk.toolUseResult ?? message.toolUseResult;
    const structuredSummaries = extractStructuredToolResult(structured);
    if (structuredSummaries.length) {
      summaries.push(...structuredSummaries);
    }

    if (summaries.length) {
      store.set(toolId, mergeUniqueStrings(summaries));
    }
  }
}

function extractToolResultContent(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return raw.trim() ? raw.trim() : null;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text.trim();
        }
        return '';
      })
      .filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

function extractStructuredToolResult(structured: any): string[] {
  if (!structured || typeof structured !== 'object') return [];
  const answers = structured.answers && typeof structured.answers === 'object'
    ? structured.answers
    : null;
  if (!answers) return [];

  const summaries: string[] = [];
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer !== 'string' || !answer.trim()) continue;
    const questionText = question.trim();
    const answerText = answer.trim();
    summaries.push(`User selection: ${questionText} → ${answerText}`);
  }
  return summaries;
}

function mergeUniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
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

async function getLastPromptFromTranscript(transcriptPath: string): Promise<string | null> {
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lastPrompt: string | null = null;
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
      if (entry?.type === 'user' && entry?.message && isPrimaryUserPrompt(entry)) {
        const text = extractText(entry.message);
        if (text.trim()) {
          lastPrompt = text;
        }
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return lastPrompt;
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
