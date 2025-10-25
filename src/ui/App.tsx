import path from 'path';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { listClaudeSessions, type ClaudeSessionMetadata } from '../lib/claudeSessions.js';
import { performInitialReview, type ReviewResult } from '../lib/review.js';

type Screen = 'loading' | 'error' | 'session-list' | 'running' | 'result';

interface CompletedReview extends ReviewResult {
  session: ClaudeSessionMetadata;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ClaudeSessionMetadata[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessages, setStatusMessages] = useState<string[]>(['Preparing review…']);
  const [activeSession, setActiveSession] = useState<ClaudeSessionMetadata | null>(null);
  const [review, setReview] = useState<CompletedReview | null>(null);

  useEffect(() => {
    void reloadSessions();
  }, []);

  useInput((input: string, key: Key) => {
    if (screen === 'session-list' && sessions.length) {
      if (input.toLowerCase() === 'r') {
        void reloadSessions();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(prev + 1, sessions.length - 1));
        return;
      }

      if (key.return) {
        const session = sessions[selectedIndex];
        setActiveSession(session);
        setStatusMessages(['Exporting SpecStory markdown…']);
        setScreen('running');
        void runReview(session);
        return;
      }
    }

    if (screen === 'result' && input.toLowerCase() === 'b') {
      setReview(null);
      setActiveSession(null);
      void reloadSessions();
      return;
    }

    if (screen === 'error' && input.toLowerCase() === 'r') {
      setError(null);
      void reloadSessions();
      return;
    }
  });

  const highlightedSessions = useMemo(() => {
    const currentCwd = normalizePath(process.cwd());
    return sessions.map((session) => ({
      ...session,
      isCurrentRepo: normalizePath(session.cwd) === currentCwd,
    }));
  }, [sessions]);

  async function reloadSessions() {
    setScreen('loading');
    setError(null);
    setStatusMessages(['Preparing review…']);
    setActiveSession(null);
    setReview(null);
    try {
      const fetched = await listClaudeSessions();
      const currentRepo = normalizePath(process.cwd());
      const scoped = fetched
        .filter((session) => normalizePath(session.cwd) === currentRepo)
        .filter((session) => !session.isWarmup);
      setSessions(scoped);
      if (scoped.length) {
        setSelectedIndex(0);
        setScreen('session-list');
      } else {
        setError('No non-warmup Claude Code sessions found for this repository.');
        setScreen('error');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load Claude sessions. Try again.';
      setError(message);
      setScreen('error');
    }
  }

  async function runReview(session: ClaudeSessionMetadata) {
    try {
      const result = await performInitialReview(session.sessionId, (message) => {
        setStatusMessages((prev) => [...prev, message]);
      });
      setReview({ ...result, session });
      setScreen('result');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Review failed. Confirm SpecStory and Codex access.';
      setError(message);
      setActiveSession(null);
      setStatusMessages(['Preparing review…']);
      setScreen('error');
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="double" borderColor="cyan" padding={1}>
        <Text bold color="cyan">
          🧙 Sage — Code Reviewer
        </Text>
      </Box>

      {screen === 'loading' && (
        <Box marginTop={1}>
          <Text>Loading Claude sessions…</Text>
        </Box>
      )}

      {screen === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">⚠️ {error ?? 'Something went wrong loading sessions.'}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press R to retry once issues are fixed.</Text>
          </Box>
        </Box>
      )}

      {screen === 'session-list' && (
        <Box marginTop={1} flexDirection="column">
          <Text>Select a Claude session to review:</Text>
          <Box flexDirection="column" marginTop={1}>
            {highlightedSessions.map((session, index) => (
              <SessionRow
                key={`${session.sessionId}-${session.timestamp ?? index}`}
                session={session}
                index={index}
                isSelected={index === selectedIndex}
              />
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Use ↑ ↓ to move, ↵ to review, R to refresh. ● marks this repo.</Text>
          </Box>
        </Box>
      )}

      {screen === 'running' && activeSession && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Running review for <Text bold>{activeSession.sessionId}</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            {statusMessages.map((message, index) => (
              <Text key={`${message}-${index}`} dimColor>
                {message}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {screen === 'result' && review && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Review for session <Text bold>{review.session.sessionId}</Text>
          </Text>
          {review.latestPrompt && (
            <Box marginTop={1}>
              <Text dimColor>Last user prompt: {truncate(review.latestPrompt, 120)}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>{review.critique}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Markdown export: {review.markdownPath}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press B to choose another session.</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

interface SessionRowProps {
  session: ClaudeSessionMetadata & { isCurrentRepo?: boolean };
  index: number;
  isSelected: boolean;
}

function SessionRow({ session, index, isSelected }: SessionRowProps) {
  const timestamp = session.timestamp ? formatRelativeTime(session.timestamp) : 'Unknown time';
  const bullet = session.isCurrentRepo ? '●' : '○';
  const prompt = session.title ? truncate(session.title, 60) : '(no prompt recorded)';

  return (
    <Box>
      <Text inverse={isSelected}>
        {bullet} #{index + 1} {prompt} @ {session.cwd} [{timestamp}]
      </Text>
    </Box>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function formatRelativeTime(isoTimestamp: string): string {
  const timestamp = new Date(isoTimestamp);
  if (Number.isNaN(timestamp.getTime())) return 'Unknown time';

  const diff = Date.now() - timestamp.getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return timestamp.toLocaleString();
}
