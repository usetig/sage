import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  message?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ message }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prevFrame) => (prevFrame + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Text color="blue">
      {SPINNER_FRAMES[frame]} {message}
    </Text>
  );
};
