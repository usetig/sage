import { createHash } from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import type { Thread } from '@openai/codex-sdk';
import {
  listSpecstorySessions,
  syncSpecstoryHistory,
  type SpecstorySessionSummary,
} from '../lib/specstory.js';
import { extractTurns, type TurnSummary } from '../lib/markdown.js';
import {
  performInitialReview,
  performIncrementalReview,
  type ReviewResult,
} from '../lib/review.js';
import { ensureStopHookConfigured } from '../lib/hooks.js';
import { CritiqueCard } from './CritiqueCard.js';
import { isDebugMode } from '../lib/debug.js';

type Screen = 'loading' | 'error' | 'session-list' | 'running';

const repositoryPath = path.resolve(process.cwd());

interface CompletedReview extends ReviewResult {
  session: SpecstorySessionSummary;
}

interface ReviewQueueItem {
  sessionId: string;
  markdownPath: string;
  turns: TurnSummary[];
  promptPreview: string;
}

const debugMode = isDebugMode();

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SpecstorySessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [activeSession, setActiveSession] = useState<SpecstorySessionSummary | null>(null);
  const [reviews, setReviews] = useState<CompletedReview[]>([]);
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [currentJob, setCurrentJob] = useState<ReviewQueueItem | null>(null);
  const [isInitialReview, setIsInitialReview] = useState(false);
  const [manualSyncTriggered, setManualSyncTriggered] = useState(false);

  const queueRef = useRef<ReviewQueueItem[]>([]);
  const workerRunningRef = useRef(false);
  const watcherRef = useRef<FSWatcher | null>(null);
  const lastProcessedVersionRef = useRef<string | null>(null);
  const codexThreadRef = useRef<Thread | null>(null);
  const lastTurnSignatureRef = useRef<string | null>(null);
  const manualSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        void handleSessionSelection(session);
        return;
      }
    }

    if (screen === 'running') {
      const lower = input.toLowerCase();
      if (lower === 'b') {
        void handleExitContinuousMode();
        return;
      }
      if (lower === 'm') {
        void handleManualSync();
        return;
      }
    }

    if (screen === 'error' && input.toLowerCase() === 'r') {
      setError(null);
      void reloadSessions();
      return;
    }
  });

  useEffect(() => {
    return () => {
      void cleanupWatcher();
    };
  }, []);

  useEffect(() => {
    if (screen !== 'running') return;
    if (!activeSession) return;
    if (workerRunningRef.current) return;
    if (queueRef.current.length === 0) return;
    void processQueue();
  }, [screen, activeSession, queue.length]);

  async function handleSessionSelection(session: SpecstorySessionSummary) {
    await resetContinuousState();
    setActiveSession(session);
    setScreen('running');
    setStatusMessages(['Running initial review…']);
    setIsInitialReview(true);

    try {
      await syncSpecstoryHistory();
      const versionBefore = await getFileVersion(session.markdownPath);
      if (versionBefore) {
        lastProcessedVersionRef.current = versionBefore;
      }

      const result = await performInitialReview(
        { sessionId: session.sessionId, markdownPath: session.markdownPath },
        (message) => setStatusMessages((prev) => [...prev, message]),
      );

      codexThreadRef.current = result.thread;

      const latestTurn = result.turns.length ? result.turns[result.turns.length - 1] : null;
      lastTurnSignatureRef.current = latestTurn ? computeTurnSignature(latestTurn) : null;

      setReviews([
        {
          critique: result.critique,
          markdownPath: result.markdownPath,
          latestPrompt: result.latestPrompt,
          debugInfo: result.debugInfo,
          session,
        },
      ]);

      const versionAfter = await getFileVersion(session.markdownPath);
      if (versionAfter) {
        lastProcessedVersionRef.current = versionAfter;
      }

      if (debugMode) {
        const baseMessages = [
          'Debug mode active — Codex agent bypassed.',
          `Session ID: ${session.sessionId}`,
          `SpecStory markdown: ${session.markdownPath}`,
        ];
        const artifactMessage = result.debugInfo?.artifactPath
          ? [`Debug context artifact: ${result.debugInfo.artifactPath}`]
          : [];
        setStatusMessages([...baseMessages, ...artifactMessage]);
      } else {
        setStatusMessages([]);
      }
      setIsInitialReview(false);

      await startWatcher(session);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Initial review failed. Please try again.';
      setError(message);
      setIsInitialReview(false);
      await resetContinuousState();
      setScreen('error');
    }
  }

  async function handleExitContinuousMode() {
    await resetContinuousState();
    setScreen('session-list');
  }

  async function handleManualSync() {
    if (!activeSession) return;

    // Show temporary feedback
    setManualSyncTriggered(true);

    // Clear any existing timeout
    if (manualSyncTimeoutRef.current) {
      clearTimeout(manualSyncTimeoutRef.current);
    }

    try {
      await syncSpecstoryHistory();
      // File watcher will detect changes and enqueue reviews automatically
      // Keep the feedback visible for 2 seconds
      manualSyncTimeoutRef.current = setTimeout(() => {
        setManualSyncTriggered(false);
      }, 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Manual sync failed.';
      setStatusMessages((prev) => [...prev, `Manual sync error: ${message}`]);
      setManualSyncTriggered(false);
    }
  }

  async function resetContinuousState() {
    await cleanupWatcher();
    queueRef.current = [];
    setQueue([]);
    workerRunningRef.current = false;
    setCurrentJob(null);
    setReviews([]);
    setStatusMessages([]);
    setActiveSession(null);
    setIsInitialReview(false);
    lastProcessedVersionRef.current = null;
    codexThreadRef.current = null;
    lastTurnSignatureRef.current = null;
  }

  async function cleanupWatcher() {
    if (watcherRef.current) {
      await watcherRef.current.close().catch(() => undefined);
      watcherRef.current = null;
    }
  }

  function enqueueJob(job: ReviewQueueItem) {
    if (!job.turns.length) return;
    queueRef.current = [...queueRef.current, job];
    setQueue(queueRef.current);
    setStatusMessages((prev) => [...prev, `Queued review: ${job.promptPreview}`]);
    if (!workerRunningRef.current) {
      void processQueue();
    }
  }

  async function processQueue(): Promise<void> {
    if (workerRunningRef.current) return;
    if (!activeSession) return;
    if (queueRef.current.length === 0) return;

    workerRunningRef.current = true;

    while (queueRef.current.length > 0) {
      if (!activeSession) {
        break;
      }

      const job = queueRef.current[0];
      setCurrentJob(job);
      setStatusMessages([`Reviewing queued prompt: ${job.promptPreview}`]);

      const thread = codexThreadRef.current;
      if (!thread && !debugMode) {
        setStatusMessages((prev) => [...prev, 'No active Codex thread to continue the review.']);
        break;
      }

      let completedJob = false;
      try {
        const result = await performIncrementalReview(
          {
            sessionId: job.sessionId,
            markdownPath: job.markdownPath,
            thread,
            turns: job.turns,
          },
          (message) => setStatusMessages((prev) => [...prev, message]),
        );

        if (activeSession && activeSession.sessionId === job.sessionId) {
          setReviews((prev) => [
            ...prev,
            {
              critique: result.critique,
              markdownPath: result.markdownPath,
              latestPrompt: result.latestPrompt,
              debugInfo: result.debugInfo,
              session: activeSession,
            },
          ]);
        }

        if (job.turns.length) {
          const latestTurn = job.turns[job.turns.length - 1];
          lastTurnSignatureRef.current = computeTurnSignature(latestTurn);
        }

        const version = await getFileVersion(job.markdownPath);
        if (version) {
          lastProcessedVersionRef.current = version;
        }

        if (debugMode) {
          const debugMessages = [
            'Debug mode active — Codex agent bypassed.',
            `Session ID: ${job.sessionId}`,
            `SpecStory markdown: ${job.markdownPath}`,
          ];
          const artifact = result.debugInfo?.artifactPath
            ? `Debug context artifact: ${result.debugInfo.artifactPath}`
            : null;
          setStatusMessages(artifact ? [...debugMessages, artifact] : debugMessages);
        } else {
          setStatusMessages([]);
        }
        completedJob = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Queued review failed.';
        setStatusMessages((prev) => [...prev, `Review failed: ${message}`]);
        setQueue([...queueRef.current]);
        break;
      }

      if (completedJob) {
        queueRef.current = queueRef.current.slice(1);
        setQueue(queueRef.current);
      }
    }

    workerRunningRef.current = false;
    setCurrentJob(null);
  }

  async function startWatcher(session: SpecstorySessionSummary) {
    await cleanupWatcher();

    const watcher = chokidar.watch(session.markdownPath, {
      ignoreInitial: true,
    });

    const handleChange = async () => {
      const version = await getFileVersion(session.markdownPath);
      if (!version || version === lastProcessedVersionRef.current) {
        return;
      }

      lastProcessedVersionRef.current = version;

      try {
        const markdown = await fs.readFile(session.markdownPath, 'utf8');
        const allTurns = extractTurns(markdown);
        const newTurns = collectNewTurns(allTurns, latestKnownSignature());
        if (!newTurns.length) {
          return;
        }

        const promptPreview = getPromptPreview(newTurns[0].user);

        enqueueJob({
          sessionId: session.sessionId,
          markdownPath: session.markdownPath,
          turns: newTurns,
          promptPreview,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to read updated markdown.';
        setStatusMessages((prev) => [...prev, message]);
      }
    };

    watcher.on('change', handleChange);
    watcherRef.current = watcher;
  }

  async function getFileVersion(filePath: string): Promise<string | null> {
    try {
      const stats = await fs.stat(filePath);
      return stats.mtimeMs.toString();
    } catch {
      return null;
    }
  }

  function computeTurnSignature(turn: TurnSummary): string {
    return createHash('sha256')
      .update(turn.user)
      .update('\n')
      .update(turn.agent ?? '')
      .digest('hex');
  }

  function collectNewTurns(allTurns: TurnSummary[], lastSignature: string | null): TurnSummary[] {
    if (!allTurns.length) return [];
    if (!lastSignature) return allTurns;

    for (let index = allTurns.length - 1; index >= 0; index -= 1) {
      if (computeTurnSignature(allTurns[index]) === lastSignature) {
        return allTurns.slice(index + 1);
      }
    }

    return allTurns;
  }

  function latestKnownSignature(): string | null {
    if (queueRef.current.length) {
      const lastJob = queueRef.current[queueRef.current.length - 1];
      const turns = lastJob.turns;
      if (turns.length) {
        return computeTurnSignature(turns[turns.length - 1]);
      }
    }
    return lastTurnSignatureRef.current;
  }

  function formatQueueLabel(job: ReviewQueueItem): string {
    if (job.turns.length <= 1) return job.promptPreview;
    const extraCount = job.turns.length - 1;
    const plural = extraCount === 1 ? '' : 's';
    return `${job.promptPreview} (+${extraCount} more turn${plural})`;
  }

  function getPromptPreview(text: string, maxLength = 80): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, maxLength - 1)}…`;
  }

  async function reloadSessions() {
    setScreen('loading');
    setError(null);
    setStatusMessages([]);
    await resetContinuousState();
    try {
      await ensureStopHookConfigured();
    } catch (err) {
      const message =
        err instanceof Error
          ? `Failed to configure Claude hook: ${err.message}`
          : 'Failed to configure Claude hook. Try again.';
      setError(message);
      setScreen('error');
      return;
    }

    try {
      await syncSpecstoryHistory();
      const fetched = await listSpecstorySessions();
      const filtered = fetched.filter((session) => !session.isWarmup);
      setSessions(filtered);
      if (filtered.length) {
        setSelectedIndex(0);
        setScreen('session-list');
      } else {
        setError('No non-warmup Claude Code sessions found for this repository.');
        setScreen('error');
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to sync SpecStory sessions. Try again.';
      setError(message);
      setScreen('error');
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="double" borderColor="cyan" padding={1}>
        <Text bold color="cyan">
          🧙 Sage — {getProjectName(repositoryPath)}
        </Text>
      </Box>

      {screen === 'loading' && (
        <Box marginTop={1}>
          <Text>Syncing SpecStory history…</Text>
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
            {sessions.map((session, index) => (
              <SessionRow
                key={`${session.sessionId}-${session.timestamp ?? index}`}
                session={session}
                index={index}
                isSelected={index === selectedIndex}
              />
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Use ↑ ↓ to move, ↵ to review, R to refresh.</Text>
          </Box>
        </Box>
      )}

      {screen === 'running' && activeSession && (
        <Box marginTop={1} flexDirection="column">
          {statusMessages.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {statusMessages.map((message, index) => (
                <Text key={`${message}-${index}`} dimColor>
                  {message}
                </Text>
              ))}
            </Box>
          )}

          {currentJob && (
            <Box marginTop={1} flexDirection="column">
              <Text>Current job:</Text>
              <Text dimColor>{formatQueueLabel(currentJob)}</Text>
            </Box>
          )}

          {queue.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text>Queued reviews:</Text>
              {queue.map((item, index) => (
                <Text key={`${item.sessionId}-${index}`} dimColor>
                  {index + 1}. {formatQueueLabel(item)}
                </Text>
              ))}
            </Box>
          )}

          {reviews.map((item, index) => (
            <CritiqueCard
              key={`${item.session.sessionId}-${index}`}
              critique={item.critique}
              prompt={item.latestPrompt}
              index={index + 1}
              artifactPath={item.debugInfo?.artifactPath}
            />
          ))}

          <Box marginTop={1}>
            <Text dimColor>{formatStatus(currentJob, queue.length, isInitialReview, manualSyncTriggered)}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

interface SessionRowProps {
  session: SpecstorySessionSummary;
  index: number;
  isSelected: boolean;
}

function SessionRow({ session, index, isSelected }: SessionRowProps) {
  const timestamp = session.timestamp ? formatRelativeTime(session.timestamp) : 'Unknown time';
  const prompt = session.title ? truncate(session.title, 60) : '(no prompt recorded)';

  return (
    <Box>
      <Text inverse={isSelected}>
        ● #{index + 1} {prompt} @ {repositoryPath} [{timestamp}]
      </Text>
    </Box>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
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

function getProjectName(cwdPath: string): string {
  return path.basename(cwdPath);
}

function formatStatus(
  currentJob: ReviewQueueItem | null,
  queueLength: number,
  isInitialReview: boolean,
  manualSyncTriggered: boolean,
): string {
  const manualSyncLabel = manualSyncTriggered ? 'M to manually sync (triggered)' : 'M to manually sync';

  if (isInitialReview) {
    return 'Status: ⏵ Running initial review...';
  }

  if (currentJob) {
    const turnInfo = currentJob.turns.length > 1
      ? ` (${currentJob.turns.length} turns)`
      : '';
    const queueInfo = queueLength > 0 ? ` • ${queueLength} queued` : '';
    return `Status: ⏵ Reviewing "${currentJob.promptPreview}"${turnInfo}${queueInfo} • ${manualSyncLabel}`;
  }

  return `Status: ⏺ Waiting for Claude response • ${manualSyncLabel}`;
}
