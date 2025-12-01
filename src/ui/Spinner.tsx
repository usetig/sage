import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { THINKING_MESSAGES, THINKING_TRIGGER } from './thinking_messages.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  message?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ message }) => {
  const [frame, setFrame] = useState(0);
  const [currentMessage, setCurrentMessage] = useState(() => {
    return THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)];
  });

  // Animate spinner frames
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prevFrame) => (prevFrame + 1) % SPINNER_FRAMES.length);
    }, 100);

    return () => {
      clearInterval(timer);
    };
  }, []);

  // Check if this is a thinking message (case-insensitive)
  const isThinkingMessage = message?.toLowerCase() === THINKING_TRIGGER.toLowerCase();

  // Rotate thinking messages randomly every 6 seconds
  useEffect(() => {
    if (!isThinkingMessage) return;

    const timer = setInterval(() => {
      setCurrentMessage(THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]);
    }, 6000);

    return () => {
      clearInterval(timer);
    };
  }, [isThinkingMessage]);

  // Determine which message to display
  const displayMessage = isThinkingMessage ? currentMessage : message;

  return (
    <Text color="blue">
      {SPINNER_FRAMES[frame]} {displayMessage}
    </Text>
  );
};
