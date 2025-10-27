import React from 'react';
import { Box, Text } from 'ink';

interface ClarificationMessage {
  role: 'sage' | 'user';
  content: string;
  timestamp: Date;
  relatedReviewIndex?: number;
}

interface ClarificationCardProps {
  message: ClarificationMessage;
}

export function ClarificationCard({ message }: ClarificationCardProps) {
  const isUser = message.role === 'user';
  const borderColor = isUser ? 'blue' : 'magenta';
  const label = isUser ? '👤 YOU' : '💬 SAGE';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={borderColor}>
        {label}
      </Text>
      <Box borderStyle="round" borderColor={borderColor} padding={1} marginTop={0.5}>
        <Text>{message.content}</Text>
      </Box>
    </Box>
  );
}

