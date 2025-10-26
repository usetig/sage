export interface TurnSummary {
  user: string;
  agent?: string;
}

export function extractLatestTurn(markdown: string): TurnSummary | null {
  const turns = extractTurns(markdown);
  if (!turns.length) return null;
  return turns[turns.length - 1];
}

export function extractTurns(markdown: string): TurnSummary[] {
  const lines = markdown.split(/\r?\n/);
  let mode: 'idle' | 'user' | 'agent' | 'skip' = 'idle';
  let userContent: string[] = [];
  let agentContent: string[] = [];
  const turns: TurnSummary[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    const lowerLine = line.toLowerCase();

    if (lowerLine.startsWith('_**user')) {
      if (isSidechainHeader(lowerLine)) {
        mode = 'skip';
        continue;
      }

      if (userContent.length) {
        turns.push(buildTurn(userContent, agentContent));
        userContent = [];
        agentContent = [];
      } else if (agentContent.length) {
        agentContent = [];
      }

      mode = 'user';
      continue;
    }

    if (lowerLine.startsWith('_**agent')) {
      if (isSidechainHeader(lowerLine)) {
        mode = 'skip';
        continue;
      }

      mode = 'agent';
      continue;
    }

    if (line.startsWith('---')) {
      mode = 'idle';
      continue;
    }

    if (mode === 'user') userContent.push(raw);
    else if (mode === 'agent') agentContent.push(raw);
  }

  if (userContent.length) {
    turns.push(buildTurn(userContent, agentContent));
  }

  return turns;
}

function isSidechainHeader(lowerCasedHeader: string): boolean {
  return lowerCasedHeader.includes('(sidechain)');
}

function buildTurn(userLines: string[], agentLines: string[]): TurnSummary {
  return {
    user: cleanupBlock(userLines),
    agent: agentLines.length ? cleanupBlock(agentLines) : undefined,
  };
}

function cleanupBlock(lines: string[]): string {
  return lines.join('\n').trim();
}
