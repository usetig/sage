import React from 'react';
import { Box, Text } from 'ink';
import type { StreamEvent } from '../lib/codex.js';

const MAX_DISPLAYED_EVENTS = 40;

const TAG_COLOR: Record<StreamEvent['tag'], { color?: string; dim?: boolean }> = {
  assistant: { color: 'green' },
  reasoning: { color: 'yellow' },
  command: { color: 'magentaBright' },
  file: { color: 'cyan' },
  todo: { color: 'blueBright' },
  status: { dim: true },
  error: { color: 'red' },
};

interface StreamOverlayProps {
  events: StreamEvent[];
  context: { sessionId: string; prompt?: string } | null;
  isLive: boolean;
}

export function StreamOverlay({ events, context, isLive }: StreamOverlayProps) {
  const displayed = events.length > MAX_DISPLAYED_EVENTS
    ? events.slice(-MAX_DISPLAYED_EVENTS)
    : events;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{'─'.repeat(80)}</Text>
      <Text bold color="cyan">
        Sage Activity Stream
      </Text>
      {context && (
        <Text dimColor>
          Session: {context.sessionId}
          {context.prompt ? ` • Prompt: ${context.prompt}` : ''}
        </Text>
      )}
      <Text dimColor>
        {isLive ? 'Streaming… Press Ctrl+O to hide.' : 'Press Ctrl+O to return to critiques.'}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {displayed.length === 0 ? (
          <Text dimColor>No activity captured yet.</Text>
        ) : (
          displayed.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </Box>
    </Box>
  );
}

interface EventRowProps {
  event: StreamEvent;
}

function EventRow({ event }: EventRowProps) {
  const { color, dim } = TAG_COLOR[event.tag];
  const lines = event.message.split('\n');
  const timestamp = formatTimestamp(event.timestamp);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} dimColor={dim}>
        [{timestamp}] {lines[0]}
      </Text>
      {lines.slice(1).map((line, index) => (
        <Text key={`${event.id}-${index}`} color={color} dimColor>
          {'  '}{line}
        </Text>
      ))}
    </Box>
  );
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  const seconds = `${date.getSeconds()}`.padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

