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
  const prefix = isUser ? '>' : '●';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text dimColor>{prefix}</Text>
        {' '}
        <Text>{message.content}</Text>
      </Text>
    </Box>
  );
}

