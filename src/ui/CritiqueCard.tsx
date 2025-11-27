import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { CritiqueResponse } from '../lib/codex.js';

interface CritiqueCardProps {
  critique: CritiqueResponse;
  prompt?: string;
  index: number;
}

const VERDICT_SYMBOLS = {
  Approved: '✓',
  Concerns: '⚠',
  'Critical Issues': '✗',
} as const;

const VERDICT_COLORS = {
  Approved: 'green',
  Concerns: 'yellow',
  'Critical Issues': 'red',
} as const;

export function CritiqueCard({
  critique,
  prompt,
  index,
}: CritiqueCardProps) {
  const symbol = VERDICT_SYMBOLS[critique.verdict] || '•';
  const color = VERDICT_COLORS[critique.verdict] || 'white';
  const { stdout } = useStdout();
  // Account for outer App container padding (1 space left + 1 space right = 2 total)
  const terminalWidth = (stdout?.columns ?? 80) - 2;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        Reviewing response for: {prompt ? `"${truncatePrompt(prompt)}"` : `Review #${index}`}
      </Text>

      <Box marginTop={1}>
        <Text>
          {symbol} <Text bold color={color}>VERDICT: {critique.verdict}</Text>
        </Text>
      </Box>

      {critique.verdict !== 'Approved' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>WHY</Text>
          <Text>{critique.why}</Text>
        </Box>
      )}

      {critique.alternatives && critique.alternatives.trim() && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="blue">ALTERNATIVES</Text>
          <Text>{critique.alternatives}</Text>
        </Box>
      )}

      {critique.questions && critique.questions.trim() && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="magenta">QUESTIONS</Text>
          <Text>{critique.questions}</Text>
        </Box>
      )}

      {critique.message_for_agent && critique.message_for_agent.trim() && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">MESSAGE FOR AGENT</Text>
          <Text>{critique.message_for_agent}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{'—'.repeat(terminalWidth)}</Text>
      </Box>
    </Box>
  );
}

function truncatePrompt(text: string, maxLength = 60): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}
