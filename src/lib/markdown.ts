export interface TurnSummary {
  user: string;
  agent?: string;
}

export function extractLatestTurn(markdown: string): TurnSummary | null {
  const lines = markdown.split(/\r?\n/);
  let mode: 'idle' | 'user' | 'agent' = 'idle';
  let userContent: string[] = [];
  let agentContent: string[] = [];
  let lastTurn: TurnSummary | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('_**User')) {
      if (userContent.length) {
        lastTurn = buildTurn(userContent, agentContent);
        userContent = [];
        agentContent = [];
      } else if (agentContent.length) {
        agentContent = [];
      }
      mode = 'user';
      continue;
    }

    if (line.startsWith('_**Agent')) {
      mode = 'agent';
      continue;
    }

    if (line.startsWith('---')) {
      if (userContent.length) {
        lastTurn = buildTurn(userContent, agentContent);
        userContent = [];
        agentContent = [];
      }
      mode = 'idle';
      continue;
    }

    if (mode === 'user') userContent.push(raw);
    else if (mode === 'agent') agentContent.push(raw);
  }

  if (userContent.length) {
    lastTurn = buildTurn(userContent, agentContent);
  }

  return lastTurn;
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
