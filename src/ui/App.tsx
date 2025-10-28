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
import { ClarificationCard } from './ClarificationCard.js';
import { Spinner } from './Spinner.js';
import { isDebugMode } from '../lib/debug.js';

type Screen = 'loading' | 'error' | 'session-list' | 'running' | 'clarification';

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

interface ClarificationMessage {
  role: 'sage' | 'user';
  content: string;
  timestamp: Date;
  relatedReviewIndex?: number;
}

const debugMode = isDebugMode();

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SpecstorySessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentStatusMessage, setCurrentStatusMessage] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SpecstorySessionSummary | null>(null);
  const [reviews, setReviews] = useState<CompletedReview[]>([]);
  const [collapsedWhy, setCollapsedWhy] = useState<boolean[]>([]);
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [currentJob, setCurrentJob] = useState<ReviewQueueItem | null>(null);
  const [isInitialReview, setIsInitialReview] = useState(false);
  const [manualSyncTriggered, setManualSyncTriggered] = useState(false);
  
  // Clarification mode state
  const [clarificationMessages, setClarificationMessages] = useState<ClarificationMessage[]>([]);
  const [clarificationInput, setClarificationInput] = useState('');
  const [activeClarificationReviewIndex, setActiveClarificationReviewIndex] = useState<number | null>(null);
  const [isWaitingForClarification, setIsWaitingForClarification] = useState(false);

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
      if (lower === 'w') {
        toggleAllApprovedWhy();
        return;
      }
      if (lower === 'c') {
        // Enter clarification mode for the most recent review
        const latestIndex = reviews.length - 1;
        if (latestIndex >= 0) {
          setActiveClarificationReviewIndex(latestIndex);
          setScreen('clarification');
          return;
        }
      }
    }

    if (screen === 'clarification') {
      if (key.escape && !isWaitingForClarification) {
        setScreen('running');
        setActiveClarificationReviewIndex(null);
        setClarificationInput('');
        return;
      }

      if (key.return && clarificationInput.trim() && !isWaitingForClarification) {
        void handleClarificationSubmit(clarificationInput.trim());
        setClarificationInput('');
        return;
      }

      // Don't allow input modifications while waiting for response
      if (isWaitingForClarification) {
        return;
      }

      if (key.backspace || key.delete) {
        setClarificationInput((prev) => prev.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setClarificationInput((prev) => prev + input);
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
    setCurrentStatusMessage('preparing initial review...');
    setIsInitialReview(true);

    try {
      await syncSpecstoryHistory();
      const versionBefore = await getFileVersion(session.markdownPath);
      if (versionBefore) {
        lastProcessedVersionRef.current = versionBefore;
      }

      const result = await performInitialReview(
        { sessionId: session.sessionId, markdownPath: session.markdownPath },
        (message) => setCurrentStatusMessage(message),
      );

      codexThreadRef.current = result.thread;

      const latestTurn = result.turns.length ? result.turns[result.turns.length - 1] : null;
      lastTurnSignatureRef.current = latestTurn ? computeTurnSignature(latestTurn) : null;

      appendReview({
        critique: result.critique,
        markdownPath: result.markdownPath,
        latestPrompt: result.latestPrompt,
        debugInfo: result.debugInfo,
        session,
      });

      const versionAfter = await getFileVersion(session.markdownPath);
      if (versionAfter) {
        lastProcessedVersionRef.current = versionAfter;
      }

      if (debugMode) {
        const debugInfo = [
          'Debug mode active — Codex agent bypassed.',
          `Session ID: ${session.sessionId}`,
          `SpecStory markdown: ${session.markdownPath}`,
          result.debugInfo?.artifactPath ? `Debug context artifact: ${result.debugInfo.artifactPath}` : '',
        ].filter(Boolean).join(' • ');
        setCurrentStatusMessage(debugInfo);
      } else {
        setCurrentStatusMessage(null);
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
      setCurrentStatusMessage(`Manual sync error: ${message}`);
      setManualSyncTriggered(false);
    }
  }

  async function handleClarificationSubmit(question: string) {
    if (!codexThreadRef.current && !debugMode) {
      setCurrentStatusMessage('No active Codex thread for clarification.');
      return;
    }

    if (activeClarificationReviewIndex === null) return;
    if (isWaitingForClarification) return; // Prevent duplicate submissions

    // Set waiting state to block further inputs
    setIsWaitingForClarification(true);

    // Add user question to clarification history
    setClarificationMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: question,
        timestamp: new Date(),
        relatedReviewIndex: activeClarificationReviewIndex,
      },
    ]);


    try {
      const { clarifyReview } = await import('../lib/review.js');
      const { response } = await clarifyReview(
        codexThreadRef.current,
        question,
        activeSession!.sessionId,
      );

      // Add Sage's explanation to clarification history
      setClarificationMessages((prev) => [
        ...prev,
        {
          role: 'sage',
          content: response,
          timestamp: new Date(),
          relatedReviewIndex: activeClarificationReviewIndex,
        },
      ]);

      setCurrentStatusMessage(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Clarification failed';
      setCurrentStatusMessage(`Clarification error: ${errorMsg}`);
    } finally {
      // Always clear waiting state when done
      setIsWaitingForClarification(false);
    }
  }

  async function resetContinuousState() {
    await cleanupWatcher();
    queueRef.current = [];
    setQueue([]);
    workerRunningRef.current = false;
    setCurrentJob(null);
    setReviews([]);
    setCollapsedWhy([]);
    setCurrentStatusMessage(null);
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

  function appendReview(review: CompletedReview): void {
    setReviews((prev) => [...prev, review]);
    setCollapsedWhy((prev) => [...prev, review.critique.verdict === 'Approved']);
  }

  function toggleWhyCollapse(index: number): void {
    setCollapsedWhy((prev) => {
      if (index < 0 || index >= prev.length) {
        return prev;
      }
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }

  function toggleAllApprovedWhy(): void {
    setCollapsedWhy((prev) => {
      // Check if any approved reviews have WHY collapsed
      const hasAnyCollapsed = reviews.some((review, index) =>
        review.critique.verdict === 'Approved' && prev[index] === true
      );

      // Create new array with updated values for approved reviews
      const next = [...prev];
      reviews.forEach((review, index) => {
        if (review.critique.verdict === 'Approved') {
          // If any are collapsed, expand all. Otherwise, collapse all.
          next[index] = !hasAnyCollapsed;
        }
      });

      return next;
    });
  }

  function enqueueJob(job: ReviewQueueItem) {
    if (!job.turns.length) return;
    queueRef.current = [...queueRef.current, job];
    setQueue(queueRef.current);
    // Status will be shown when job starts processing
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

      const thread = codexThreadRef.current;
      if (!thread && !debugMode) {
        setCurrentStatusMessage('No active Codex thread to continue the review.');
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
          (message) => setCurrentStatusMessage(message),
        );

        if (activeSession && activeSession.sessionId === job.sessionId) {
          appendReview({
            critique: result.critique,
            markdownPath: result.markdownPath,
            latestPrompt: result.latestPrompt,
            debugInfo: result.debugInfo,
            session: activeSession,
          });
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
          const debugInfo = [
            'Debug mode active — Codex agent bypassed.',
            `Session ID: ${job.sessionId}`,
            `SpecStory markdown: ${job.markdownPath}`,
            result.debugInfo?.artifactPath ? `Debug context artifact: ${result.debugInfo.artifactPath}` : '',
          ].filter(Boolean).join(' • ');
          setCurrentStatusMessage(debugInfo);
        } else {
          setCurrentStatusMessage(null);
        }
        completedJob = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Queued review failed.';
        setCurrentStatusMessage(`Review failed: ${message}`);
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
        setCurrentStatusMessage(message);
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
    setCurrentStatusMessage(null);
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
          🧙 Sage — /{getProjectName(repositoryPath)}
        </Text>
      </Box>

      {screen === 'loading' && (
        <Box marginTop={1}>
          <Text>Loading sessions…</Text>
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
          {reviews.map((item, index) => (
            <CritiqueCard
              key={`${item.session.sessionId}-${index}`}
              critique={item.critique}
              prompt={item.latestPrompt}
              index={index + 1}
              hideWhy={collapsedWhy[index] ?? false}
            />
          ))}

          {/* STATUS BAR: Shows review progress at the bottom where user's eyes naturally are
              - Shows spinner with detailed progress from onProgress callbacks (currentStatusMessage)
              - Falls back to high-level status (statusMessage) if no detailed progress
              - Shows static text when not reviewing */}
          <Box marginTop={1} flexDirection="column">
            {(() => {
              const { status, keybindings, isReviewing, statusMessage } = formatStatus(currentJob, queue.length, isInitialReview, manualSyncTriggered);

              // Priority 1: Show detailed progress message with spinner
              if (currentStatusMessage) {
                return (
                  <>
                    <Spinner message={currentStatusMessage} />
                    <Text dimColor>{keybindings}</Text>
                  </>
                );
              }

              // Priority 2: Show high-level status with spinner if reviewing
              if (isReviewing && statusMessage) {
                return (
                  <>
                    <Spinner message={statusMessage} />
                    <Text dimColor>{keybindings}</Text>
                  </>
                );
              }

              // Priority 3: Show static waiting status
              return (
                <>
                  <Text dimColor>{status}</Text>
                  <Text dimColor>{keybindings}</Text>
                </>
              );
            })()}
          </Box>
        </Box>
      )}

      {screen === 'clarification' && activeClarificationReviewIndex !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text>{'─'.repeat(80)}</Text>
          <Text bold>
            Chat with Sage
          </Text>

          <Text>{'─'.repeat(80)}</Text>

          {currentStatusMessage && (
            <Box marginTop={1}>
              <Text dimColor>{currentStatusMessage}</Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            {clarificationMessages
              .filter((msg) => msg.relatedReviewIndex === activeClarificationReviewIndex)
              .map((msg, idx) => (
                <ClarificationCard key={idx} message={msg} />
              ))}
          </Box>

          {isWaitingForClarification ? (
            <Box marginTop={1}>
              <Spinner message="sage is thinking..." />
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text>
                <Text dimColor>&gt; </Text>
                {clarificationInput}
                <Text inverse> </Text>
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>
              {isWaitingForClarification
                ? '↵ send • ESC exit'
                : '↵ send • ESC exit'}
            </Text>
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
        ● #{index + 1} {prompt} [{timestamp}]
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
): { status: string; keybindings: string; isReviewing: boolean; statusMessage?: string } {
  const manualSyncLabel = manualSyncTriggered ? 'M to manually sync (triggered)' : 'M to manually sync';
  const toggleWhyLabel = 'W to toggle WHY';
  const pendingCount = currentJob ? Math.max(queueLength - 1, 0) : Math.max(queueLength, 0);

  if (isInitialReview) {
    return {
      status: 'Status: ⏵ Running initial review...',
      statusMessage: 'running initial review...',
      keybindings: `${manualSyncLabel} • ${toggleWhyLabel}`,
      isReviewing: true,
    };
  }

  if (currentJob) {
    const turnInfo = currentJob.turns.length > 1
      ? ` (${currentJob.turns.length} turns)`
      : '';
    const queueInfo = pendingCount > 0 ? ` • ${pendingCount} queued` : '';
    const queueSuffix = pendingCount > 0 ? ` • ${pendingCount} queued` : '';
    return {
      status: `Status: ⏵ Reviewing "${currentJob.promptPreview}"${turnInfo}${queueInfo}`,
      statusMessage: `reviewing "${currentJob.promptPreview}"${queueSuffix}`,
      keybindings: `${manualSyncLabel} • ${toggleWhyLabel}`,
      isReviewing: true,
    };
  }

  return {
    status: 'Status: ⏺ Waiting for Claude response',
    keybindings: `C to chat with Sage • ${toggleWhyLabel} • ${manualSyncLabel}`,
    isReviewing: false,
  };
}
