import React from 'react';
import { Box, Text } from 'ink';

export default function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="double" borderColor="cyan" padding={1}>
        <Text bold color="cyan">
          🧙 Sage — Code Reviewer
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Hello from Sage v0! Ready to review Claude Code sessions.</Text>
      </Box>
    </Box>
  );
}
