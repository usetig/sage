import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { AVAILABLE_MODELS, type ModelConfig } from '../lib/models.js';

interface SettingsScreenProps {
  currentModel: string;
  onSelectModel: (modelId: string) => void;
  onBack: () => void;
}

export function SettingsScreen({ currentModel, onSelectModel, onBack }: SettingsScreenProps) {
  const currentIndex = AVAILABLE_MODELS.findIndex((m) => m.id === currentModel);
  const [selectedIndex, setSelectedIndex] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((input: string, key: Key) => {
    if (key.escape || input.toLowerCase() === 'b') {
      onBack();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, AVAILABLE_MODELS.length - 1));
      return;
    }

    if (key.return) {
      const model = AVAILABLE_MODELS[selectedIndex];
      onSelectModel(model.id);
      return;
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Settings</Text>
      <Text>{'─'.repeat(40)}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text>Select Sage Model:</Text>
        <Box marginTop={1} flexDirection="column">
          {AVAILABLE_MODELS.map((model, index) => (
            <ModelRow
              key={model.id}
              model={model}
              isSelected={index === selectedIndex}
              isCurrent={model.id === currentModel}
            />
          ))}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use ↑ ↓ to move, ↵ to select, ESC/B to go back</Text>
      </Box>
    </Box>
  );
}

interface ModelRowProps {
  model: ModelConfig;
  isSelected: boolean;
  isCurrent: boolean;
}

function ModelRow({ model, isSelected, isCurrent }: ModelRowProps) {
  const checkmark = isCurrent ? '✓ ' : '  ';
  const label = `${checkmark}${model.name}`;

  return (
    <Box>
      <Text inverse={isSelected}>
        {label}
      </Text>
      {isCurrent && !isSelected && (
        <Text dimColor> (current)</Text>
      )}
    </Box>
  );
}
