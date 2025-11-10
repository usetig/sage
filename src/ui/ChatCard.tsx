import React from 'react';
import { Box, Text } from 'ink';

interface ChatMessage {
  role: 'sage' | 'user';
  content: string;
  timestamp: Date;
  relatedReviewIndex?: number;
}

interface ChatCardProps {
  message: ChatMessage;
}

export function ChatCard({ message }: ChatCardProps) {
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

