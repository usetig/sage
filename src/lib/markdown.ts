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
        const turn = buildTurn(userContent, agentContent);
        if (!isInterruptTurn(turn)) {
          turns.push(turn);
        } else {
          console.log('[Sage] Filtered interrupt turn:', turn.user.slice(0, 80));
        }
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
    const turn = buildTurn(userContent, agentContent);
    if (!isInterruptTurn(turn)) {
      turns.push(turn);
    } else {
      console.log('[Sage] Filtered interrupt turn (final):', turn.user.slice(0, 80));
    }
  }

  return turns;
}

function isSidechainHeader(lowerCasedHeader: string): boolean {
  return lowerCasedHeader.includes('(sidechain)');
}

function isInterruptTurn(turn: TurnSummary): boolean {
  const userLower = turn.user.toLowerCase().trim();
  // Detect user interrupt patterns from Claude Code
  return (
    userLower.includes('[request interrupted by user') ||
    userLower.startsWith('request interrupted by user') ||
    // Also filter if there's an interrupt AND no agent response
    (userLower.includes('interrupt') && !turn.agent)
  );
}

function buildTurn(userLines: string[], agentLines: string[]): TurnSummary {
  return {
    user: cleanupUserPrompt(cleanupBlock(userLines)),
    agent: agentLines.length ? cleanupBlock(agentLines) : undefined,
  };
}

function cleanupBlock(lines: string[]): string {
  return lines.join('\n').trim();
}

function cleanupUserPrompt(text: string): string {
  // Strip out problematic image file paths that Codex might try to read
  // These are typically temp files that no longer exist or are inaccessible
  
  // Pattern 1: Absolute paths to temp directories with image extensions
  // e.g., /var/folders/.../Screenshot.png or /tmp/image.jpg
  let cleaned = text.replace(/['"]?(\/(?:var\/folders|tmp|private\/var\/folders)[^\s'"]+\.(?:png|jpg|jpeg|gif|webp|bmp))['"]?/gi, '[Image file path removed]');
  
  // Pattern 2: User provided an image message
  if (text.includes('User provided an image')) {
    cleaned = cleaned.replace(/User provided an image \([^)]+\)\./g, 'User provided an image.');
  }
  
  return cleaned;
}
