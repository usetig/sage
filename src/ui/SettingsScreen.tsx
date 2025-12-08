import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { FALLBACK_MODELS, type ModelOption } from '../lib/models.js';

interface SettingsScreenProps {
  currentModel: string;
  debugMode: boolean;
  models: ModelOption[];
  onSelectModel: (modelId: string) => void;
  onToggleDebugMode: () => void;
  onBack: () => void;
}

// Total selectable items: models + 1 debug toggle
const DEBUG_TOGGLE_INDEX = (modelsLength: number) => modelsLength;

export function SettingsScreen({ currentModel, debugMode, models, onSelectModel, onToggleDebugMode, onBack }: SettingsScreenProps) {
  const modelOptions = models.length ? models : FALLBACK_MODELS;
  const currentModelIndex = modelOptions.findIndex((m) => m.id === currentModel);
  const [selectedIndex, setSelectedIndex] = useState(currentModelIndex >= 0 ? currentModelIndex : 0);

  const debugIndex = DEBUG_TOGGLE_INDEX(modelOptions.length);
  const totalItems = modelOptions.length + 1; // models + debug toggle

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
      setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
      return;
    }

    if (key.return) {
      if (selectedIndex === debugIndex) {
        onToggleDebugMode();
      } else {
        const model = modelOptions[selectedIndex];
        onSelectModel(model.id);
      }
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
          {modelOptions.map((model, index) => (
            <ModelRow
              key={model.id}
              model={model}
              isSelected={index === selectedIndex}
              isCurrent={model.id === currentModel}
            />
          ))}
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>Debug Mode:</Text>
        <Box marginTop={1}>
          <Text inverse={selectedIndex === debugIndex}>
            {debugMode ? '✓ ON' : '  OFF'}
          </Text>
          <Text dimColor> (shows verbose status messages)</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use ↑ ↓ to move, ↵ to select/toggle, ESC/B to go back</Text>
      </Box>
    </Box>
  );
}

interface ModelRowProps {
  model: ModelOption;
  isSelected: boolean;
  isCurrent: boolean;
}

function ModelRow({ model, isSelected, isCurrent }: ModelRowProps) {
  const checkmark = isCurrent ? '✓ ' : '  ';
  const label = `${checkmark}${model.label}`;

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
