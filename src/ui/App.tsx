import path from 'path';
import { promises as fs } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import type { Thread } from '@openai/codex-sdk';
import { listActiveSessions, extractTurns, type ActiveSession, type TurnSummary } from '../lib/jsonl.js';
import {
  performInitialReview,
  performIncrementalReview,
  type ReviewResult,
} from '../lib/review.js';
import type { StreamEvent } from '../lib/codex.js';
import { CritiqueCard } from './CritiqueCard.js';
import { ChatCard } from './ChatCard.js';
import { Spinner } from './Spinner.js';
import { isDebugMode } from '../lib/debug.js';
import {
  loadReviewCache,
  saveReviewCache,
  appendReviewToCache,
  ensureReviewCache,
  deleteReviewCache,
  type StoredReview,
  type SessionReviewCache,
} from '../lib/reviewsCache.js';
import { StreamOverlay } from './StreamOverlay.js';
import { getQueueDir } from '../lib/paths.js';
import { ensureHooksConfigured } from '../scripts/configureHooks.js';

type Screen = 'loading' | 'error' | 'session-list' | 'running' | 'chat';

const repositoryPath = path.resolve(process.cwd());

type QueueSource = 'hook' | 'manual';

interface CompletedReview extends ReviewResult {
  session: ActiveSession;
  turnSignature?: string;
}

interface ReviewQueueItem {
  sessionId: string;
  transcriptPath: string;
  turns: TurnSummary[];
  promptPreview: string;
  latestTurnSignature: string | null;
  signalPath: string | null;
  source: QueueSource;
  isPartial: boolean;
}

interface ChatMessage {
  role: 'sage' | 'user';
  content: string;
  timestamp: Date;
  relatedReviewIndex?: number;
}

const debugMode = isDebugMode();
const STREAM_EVENT_HISTORY_LIMIT = 400;

type StreamContext = {
  sessionId: string;
  prompt?: string;
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [currentStatusMessage, setCurrentStatusMessage] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [reviews, setReviews] = useState<CompletedReview[]>([]);
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [currentJob, setCurrentJob] = useState<ReviewQueueItem | null>(null);
  const [isInitialReview, setIsInitialReview] = useState(false);
  const [manualSyncTriggered, setManualSyncTriggered] = useState(false);
  const [isStreamOverlayOpen, setIsStreamOverlayOpen] = useState(false);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streamContext, setStreamContext] = useState<StreamContext | null>(null);
  const [isStreamLive, setIsStreamLive] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  
  // Chat mode state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [activeChatReviewIndex, setActiveChatReviewIndex] = useState<number | null>(null);
  const [isWaitingForChat, setIsWaitingForChat] = useState(false);

  // Hook configuration state
  const [hooksJustConfigured, setHooksJustConfigured] = useState(false);
  const [hookConfigWarning, setHookConfigWarning] = useState<string | null>(null);

  const queueRef = useRef<ReviewQueueItem[]>([]);
  const workerRunningRef = useRef(false);
  const watcherRef = useRef<FSWatcher | null>(null);
  const codexThreadRef = useRef<Thread | null>(null);
  const lastTurnSignatureRef = useRef<string | null>(null);
  const manualSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resumeStatusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reviewCacheRef = useRef<SessionReviewCache | null>(null);
  const processedSignalsRef = useRef<Set<string>>(new Set());
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const initialReviewDeferredRef = useRef(false);
  const streamEventsRef = useRef<StreamEvent[]>([]);

  useEffect(() => {
    const init = async () => {
      // Configure hooks first (non-blocking on failure)
      try {
        const result = await ensureHooksConfigured();
        if (result.configured && !result.alreadyConfigured) {
          setHooksJustConfigured(true);
        }
      } catch (err) {
        // Log but don't block app startup - hooks can be configured manually
        console.error('Failed to auto-configure hooks:', err);
        setHookConfigWarning('Could not auto-configure hooks. Run: npm run configure-hooks');
      }
      // Always load sessions regardless of hook config result
      await reloadSessions();
    };
    void init();
  }, []);

  useInput((input: string, key: Key) => {
    const normalizedInput = input.toLowerCase();

    if (key.ctrl && normalizedInput === 'o') {
      if (isStreamOverlayOpen) {
        setIsStreamOverlayOpen(false);
      } else if (screen === 'running') {
        setIsStreamOverlayOpen(true);
      }
      return;
    }

    if (screen === 'session-list' && sessions.length) {
      if (normalizedInput === 'r') {
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
      const lower = normalizedInput;
      if (lower === 'b') {
        void handleExitContinuousMode();
        return;
      }
      if (lower === 'm') {
        void handleManualSync();
        return;
      }
      if (lower === 'c') {
        // Enter chat mode for the most recent review
        const latestIndex = reviews.length - 1;
        if (latestIndex >= 0) {
          setActiveChatReviewIndex(latestIndex);
          setScreen('chat');
          return;
        }
      }
    }

    if (screen === 'chat') {
      if (key.escape && !isWaitingForChat) {
        setScreen('running');
        setActiveChatReviewIndex(null);
        setChatInput('');
        setCurrentStatusMessage(null);
        return;
      }

      if (key.return && chatInput.trim() && !isWaitingForChat) {
        void handleChatSubmit(chatInput.trim());
        setChatInput('');
        return;
      }

      // Don't allow input modifications while waiting for response
      if (isWaitingForChat) {
        return;
      }

      if (key.backspace || key.delete) {
        setChatInput((prev) => prev.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setChatInput((prev) => prev + input);
        return;
      }
    }

    if (screen === 'error' && normalizedInput === 'r') {
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
    if (screen !== 'running' && isStreamOverlayOpen) {
      setIsStreamOverlayOpen(false);
    }
  }, [screen, isStreamOverlayOpen]);

  useEffect(() => {
    if (screen !== 'running') return;
    if (!activeSession) return;
    if (workerRunningRef.current) return;
    if (queueRef.current.length === 0) return;
    void processQueue();
  }, [screen, activeSession, queue.length]);

  function beginStream(context: StreamContext): void {
    streamEventsRef.current = [];
    setStreamEvents([]);
    setStreamContext(context);
    setIsStreamLive(true);
  }

  function appendStreamEvent(event: StreamEvent): void {
    streamEventsRef.current = [...streamEventsRef.current, event];
    if (streamEventsRef.current.length > STREAM_EVENT_HISTORY_LIMIT) {
      streamEventsRef.current = streamEventsRef.current.slice(-STREAM_EVENT_HISTORY_LIMIT);
    }
    setStreamEvents(streamEventsRef.current);
  }

  function finalizeStream(context: StreamContext, events: StreamEvent[]): void {
    const trimmed = events.length > STREAM_EVENT_HISTORY_LIMIT
      ? events.slice(-STREAM_EVENT_HISTORY_LIMIT)
      : events;
    streamEventsRef.current = trimmed;
    setStreamEvents(trimmed);
    setStreamContext(context);
    setIsStreamLive(false);
  }

  async function handleSessionSelection(session: ActiveSession) {
    await resetContinuousState();
    const cached = await loadReviewCache(session.sessionId);
    reviewCacheRef.current = cached;

    const restoredReviews = cached
      ? cached.reviews.map((stored) => toCompletedReview(stored, session))
      : [];

    if (cached?.lastTurnSignature) {
      lastTurnSignatureRef.current = cached.lastTurnSignature;
    } else {
      lastTurnSignatureRef.current = null;
    }

    if (restoredReviews.length) {
      setReviews(restoredReviews);
      setStatusMessages([`Restored ${restoredReviews.length} previous review${restoredReviews.length === 1 ? '' : 's'}.`]);
    } else {
      setStatusMessages([]);
    }
    setCurrentStatusMessage('loading session context...');

    activeSessionRef.current = session;
    setActiveSession(session);
    setScreen('running');
    setIsInitialReview(true);
    beginStream({ sessionId: session.sessionId, prompt: session.title || undefined });

    try {
      const lastReviewedUuid = cached?.lastTurnSignature ?? null;
      initialReviewDeferredRef.current = false;

      const result = await performInitialReview(
        { sessionId: session.sessionId, transcriptPath: session.transcriptPath, lastReviewedUuid },
        (message) => setCurrentStatusMessage(message),
        appendStreamEvent,
      );

      const streamPrompt = result.latestPrompt
        ? getPromptPreview(result.latestPrompt)
        : session.title || undefined;
      finalizeStream({ sessionId: session.sessionId, prompt: streamPrompt }, result.streamEvents);

      codexThreadRef.current = result.thread;
      const initialThreadId = result.thread?.id ?? null;
      if (initialThreadId) {
        setThreadId(initialThreadId);
      }
      const deferredInitialReview = result.thread === null && result.isFreshCritique === false;
      initialReviewDeferredRef.current = deferredInitialReview;

      if (reviewCacheRef.current?.lastTurnSignature) {
        const cachedSignature = reviewCacheRef.current.lastTurnSignature;
        const signatureStillPresent = result.turns.some((turn) => turn.assistantUuid === cachedSignature);
        if (!signatureStillPresent && reviewCacheRef.current.reviews.length) {
          reviewCacheRef.current = null;
          setReviews([]);
          await deleteReviewCache(session.sessionId);
          setCurrentStatusMessage('Cleared stale review history for this session.');
          setStatusMessages((prev) => [
            ...prev,
            'Cached critiques no longer match this session; cleared stored history.',
          ]);
        }
      }

      if (result.turnSignature) {
        lastTurnSignatureRef.current = result.turnSignature;
      }

      const resumedWithoutChanges = result.isFreshCritique === false && !deferredInitialReview;

      if (result.isFreshCritique) {
        appendReview({
          critique: result.critique,
          transcriptPath: result.transcriptPath,
          latestPrompt: result.latestPrompt,
          debugInfo: result.debugInfo,
          completedAt: result.completedAt,
          turnSignature: result.turnSignature,
          session,
          isFreshCritique: result.isFreshCritique,
          streamEvents: result.streamEvents,
        });
      }

      if (debugMode) {
        const debugInfo = [
          'Debug mode active — Codex agent bypassed.',
          `Session ID: ${session.sessionId}`,
          `Transcript: ${session.transcriptPath}`,
          result.debugInfo?.artifactPath ? `Debug context artifact: ${result.debugInfo.artifactPath}` : '',
        ]
          .filter(Boolean)
          .join(' • ');
        setCurrentStatusMessage(debugInfo);
      } else {
        if (resumeStatusTimeoutRef.current) {
          clearTimeout(resumeStatusTimeoutRef.current);
          resumeStatusTimeoutRef.current = null;
        }
        if (deferredInitialReview) {
          setStatusMessages(['Initial review paused until Claude finishes its first response.']);
        } else if (resumedWithoutChanges) {
          setCurrentStatusMessage('Resuming Sage thread...');
          resumeStatusTimeoutRef.current = setTimeout(() => {
            setCurrentStatusMessage(null);
            resumeStatusTimeoutRef.current = null;
          }, 1200);
          setStatusMessages(['Session previously reviewed. Using existing context...']);
        } else {
          setCurrentStatusMessage(null);
          setStatusMessages([]);
        }
      }

      setIsInitialReview(false);

      await initializeSignalWatcher(session);
      await drainSignals(session.sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Initial review failed. Please try again.';
      setError(message);
      setIsInitialReview(false);
      setIsStreamLive(false);
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
    setCurrentStatusMessage('running manual sync...');

    // Clear any existing timeout
    if (manualSyncTimeoutRef.current) {
      clearTimeout(manualSyncTimeoutRef.current);
    }

    try {
      const queueSizeBefore = queueRef.current.length;
      await drainSignals(activeSession.sessionId);
      const manualQueued = await queueManualReview(activeSession);
      const queueDelta = queueRef.current.length - queueSizeBefore;
      if (!manualQueued && queueDelta === 0) {
        setStatusMessages((prev) => [
          ...prev,
          'Manual sync: no new Claude output yet (response may still be streaming).',
        ]);
      }
      manualSyncTimeoutRef.current = setTimeout(() => {
        setManualSyncTriggered(false);
      }, 2000);
      setCurrentStatusMessage(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Manual sync failed.';
      setCurrentStatusMessage(`Manual sync error: ${message}`);
      setStatusMessages((prev) => [...prev, `Manual sync error: ${message}`]);
      setManualSyncTriggered(false);
    }
  }

  async function handleChatSubmit(question: string) {
    if (!codexThreadRef.current && !debugMode) {
      setCurrentStatusMessage('No active Codex thread for chat.');
      return;
    }

    if (activeChatReviewIndex === null) return;
    if (isWaitingForChat) return; // Prevent duplicate submissions

    // Set waiting state to block further inputs
    setIsWaitingForChat(true);

    // Add user question to chat history
    setChatMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: question,
        timestamp: new Date(),
        relatedReviewIndex: activeChatReviewIndex,
      },
    ]);


    try {
      const { chatWithSage } = await import('../lib/review.js');
      const { response } = await chatWithSage(
        codexThreadRef.current,
        question,
        activeSession!.sessionId,
      );

      // Add Sage's response to chat history
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'sage',
          content: response,
          timestamp: new Date(),
          relatedReviewIndex: activeChatReviewIndex,
        },
      ]);

      setCurrentStatusMessage(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Chat failed';
      setCurrentStatusMessage(`Chat error: ${errorMsg}`);
    } finally {
      // Always clear waiting state when done
      setIsWaitingForChat(false);
    }
  }

  async function resetContinuousState() {
    await cleanupWatcher();
    if (manualSyncTimeoutRef.current) {
      clearTimeout(manualSyncTimeoutRef.current);
      manualSyncTimeoutRef.current = null;
    }
    if (resumeStatusTimeoutRef.current) {
      clearTimeout(resumeStatusTimeoutRef.current);
      resumeStatusTimeoutRef.current = null;
    }
    queueRef.current = [];
    setQueue([]);
    workerRunningRef.current = false;
    setCurrentJob(null);
    setReviews([]);
    setStatusMessages([]);
    setCurrentStatusMessage(null);
    setActiveSession(null);
    activeSessionRef.current = null;
    setIsInitialReview(false);
    codexThreadRef.current = null;
    setThreadId(null);
    lastTurnSignatureRef.current = null;
    reviewCacheRef.current = null;
    processedSignalsRef.current.clear();
    initialReviewDeferredRef.current = false;
    setIsStreamOverlayOpen(false);
    setStreamEvents([]);
    streamEventsRef.current = [];
    setStreamContext(null);
    setIsStreamLive(false);
  }

  async function cleanupWatcher() {
    if (watcherRef.current) {
      await watcherRef.current.close().catch(() => undefined);
      watcherRef.current = null;
    }
  }

  function appendReview(review: CompletedReview): void {
    if (review.isFreshCritique === false) {
      return;
    }
    setReviews((prev) => {
      if (review.turnSignature && prev.some((item) => item.turnSignature === review.turnSignature)) {
        return prev;
      }
      return [...prev, review];
    });
    void persistReview(review);
  }

  async function persistReview(review: CompletedReview): Promise<void> {
    if (review.isFreshCritique === false) return;
    if (review.isPartial) return;
    if (!review.turnSignature) return;
    const sessionId = review.session.sessionId;
    const stored: StoredReview = {
      turnSignature: review.turnSignature,
      completedAt: review.completedAt,
      latestPrompt: review.latestPrompt ?? null,
      critique: review.critique,
      artifactPath: review.debugInfo?.artifactPath,
      promptText: review.debugInfo?.promptText,
    };

    const currentCache = ensureReviewCache(reviewCacheRef.current, sessionId);
    const updatedCache = appendReviewToCache(currentCache, stored);
    reviewCacheRef.current = updatedCache;
    try {
      await saveReviewCache(updatedCache);
    } catch (error: any) {
      setStatusMessages((prev) => [
        ...prev,
        `Failed to persist review history: ${error?.message ?? String(error)}`,
      ]);
    }
  }


  function enqueueJob(job: ReviewQueueItem) {
    if (!job.turns.length) return;
    queueRef.current = [...queueRef.current, job];
    setQueue(queueRef.current);
    const origin = job.source === 'manual' ? 'Queued manual review' : 'Queued review';
    const partialSuffix = job.isPartial ? ' (partial response)' : '';
    setStatusMessages((prev) => [...prev, `${origin}: ${job.promptPreview}${partialSuffix}`]);
    if (!workerRunningRef.current) {
      void processQueue();
    }
  }

  async function processQueue(): Promise<void> {
    if (workerRunningRef.current) return;
    if (!activeSession) return;
    if (queueRef.current.length === 0) return;

    workerRunningRef.current = true;

    while (queueRef.current.length > 0 && activeSession) {
      const job = queueRef.current[0];
      setCurrentJob(job);

      const shouldRunDeferredInitial =
        (!codexThreadRef.current || initialReviewDeferredRef.current) && !debugMode;

      if (shouldRunDeferredInitial) {
        beginStream({ sessionId: job.sessionId, prompt: job.promptPreview });
        try {
          const deferredResult = await performInitialReview(
            {
              sessionId: job.sessionId,
              transcriptPath: job.transcriptPath,
              lastReviewedUuid: lastTurnSignatureRef.current,
            },
            (message) => setCurrentStatusMessage(message),
            appendStreamEvent,
          );

          const deferredPrompt = deferredResult.latestPrompt
            ? getPromptPreview(deferredResult.latestPrompt)
            : job.promptPreview;
          finalizeStream({ sessionId: job.sessionId, prompt: deferredPrompt }, deferredResult.streamEvents);

          codexThreadRef.current = deferredResult.thread;
          const deferredThreadId = deferredResult.thread?.id ?? null;
          if (deferredThreadId) {
            setThreadId(deferredThreadId);
          }

          if (deferredResult.turnSignature) {
            lastTurnSignatureRef.current = deferredResult.turnSignature;
          }

          const stillDeferred =
            deferredResult.thread === null && deferredResult.isFreshCritique === false;
          initialReviewDeferredRef.current = stillDeferred;

          if (deferredResult.isFreshCritique) {
            appendReview({
              critique: deferredResult.critique,
              transcriptPath: deferredResult.transcriptPath,
              latestPrompt: deferredResult.latestPrompt,
              debugInfo: deferredResult.debugInfo,
              completedAt: deferredResult.completedAt,
              turnSignature: deferredResult.turnSignature,
              session: activeSessionRef.current ?? activeSession,
              isFreshCritique: deferredResult.isFreshCritique,
              streamEvents: deferredResult.streamEvents,
            });
          }

          if (!stillDeferred) {
            setCurrentStatusMessage(null);
            setStatusMessages([]);
          } else {
            setStatusMessages(['Initial review paused until Claude finishes its first response.']);
          }

          if (job.signalPath) {
            try {
              await fs.unlink(job.signalPath);
            } catch {
              // ignore unlink errors
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Initial review failed. Please try again.';
          setCurrentStatusMessage(message);
          setStatusMessages((prev) => [...prev, message]);
          setIsStreamLive(false);
        }

        queueRef.current = queueRef.current.slice(1);
        setQueue(queueRef.current);
        setCurrentJob(null);
        if (job.signalPath) {
          processedSignalsRef.current.delete(job.signalPath);
        }
        continue;
      }

      beginStream({ sessionId: job.sessionId, prompt: job.promptPreview });
      if (!debugMode) {
        const currentThreadId = codexThreadRef.current?.id ?? null;
        if (currentThreadId) {
          setThreadId(currentThreadId);
        }
      }
      try {
        const result = await performIncrementalReview(
          {
            sessionId: job.sessionId,
            transcriptPath: job.transcriptPath,
            thread: codexThreadRef.current,
            turns: job.turns,
            latestTurnSignature: job.latestTurnSignature,
            isPartial: job.isPartial,
          },
          (message) => setCurrentStatusMessage(message),
          appendStreamEvent,
        );

        const incrementalPrompt = result.latestPrompt
          ? getPromptPreview(result.latestPrompt)
          : job.promptPreview;
        finalizeStream({ sessionId: job.sessionId, prompt: incrementalPrompt }, result.streamEvents);

        if (result.turnSignature && !job.isPartial) {
          lastTurnSignatureRef.current = result.turnSignature;
        }

        const effectiveTurnSignature =
          job.isPartial && result.turnSignature
            ? `partial:${result.turnSignature}`
            : result.turnSignature;

        appendReview({
          critique: result.critique,
          transcriptPath: result.transcriptPath,
          latestPrompt: result.latestPrompt,
          debugInfo: result.debugInfo,
          completedAt: result.completedAt,
          turnSignature: effectiveTurnSignature,
          session: activeSessionRef.current ?? activeSession,
          isFreshCritique: result.isFreshCritique,
          streamEvents: result.streamEvents,
          isPartial: job.isPartial,
        });

        if (job.signalPath) {
          try {
            await fs.unlink(job.signalPath);
          } catch {
            // ignore unlink errors
          }
        }

        setCurrentStatusMessage(debugMode
          ? [
              'Debug mode active — Codex agent bypassed.',
              `Session ID: ${job.sessionId}`,
              `Transcript: ${job.transcriptPath}`,
              result.debugInfo?.artifactPath ? `Debug context artifact: ${result.debugInfo.artifactPath}` : '',
            ]
              .filter(Boolean)
              .join(' • ')
          : null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Queued review failed.';
        setCurrentStatusMessage(`Review failed: ${message}`);
        setStatusMessages((prev) => [...prev, `Review failed for "${job.promptPreview}": ${message}`]);
        setIsStreamLive(false);
      }

      queueRef.current = queueRef.current.slice(1);
      setQueue(queueRef.current);
      setCurrentJob(null);
      if (job.signalPath) {
        processedSignalsRef.current.delete(job.signalPath);
      }
    }

    workerRunningRef.current = false;
  }

  async function initializeSignalWatcher(session: ActiveSession) {
    await cleanupWatcher();

    const needsReviewDir = getQueueDir();
    const watcher = chokidar.watch(needsReviewDir, { ignoreInitial: true, depth: 0 });
    watcher.on('add', (filePath) => {
      if (!processedSignalsRef.current.has(filePath)) {
        processedSignalsRef.current.add(filePath);
        void processSignalFile(filePath, session.sessionId);
      }
    });

    watcherRef.current = watcher;
  }

  async function drainSignals(sessionId: string) {
    const needsReviewDir = getQueueDir();
    let files: string[] = [];
    try {
      files = await fs.readdir(needsReviewDir);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const file of files) {
      const fullPath = path.join(needsReviewDir, file);
      if (processedSignalsRef.current.has(fullPath)) continue;
      processedSignalsRef.current.add(fullPath);
      await processSignalFile(fullPath, sessionId);
    }
  }

  async function processSignalFile(filePath: string, activeSessionId: string) {
    let enqueued = false;
    try {
      const signal = await readSignalFile(filePath);
      if (!signal) {
        processedSignalsRef.current.delete(filePath);
        return;
      }

      const currentSession = activeSessionRef.current;
      if (!currentSession || currentSession.sessionId !== signal.sessionId) {
        processedSignalsRef.current.delete(filePath);
        return;
      }

      const sinceSignature = latestKnownSignature();
      const { turns, latestTurnUuid } = await extractTurns({
        transcriptPath: signal.transcriptPath,
        sinceUuid: sinceSignature ?? null,
      });

      if (!turns.length) {
        await fs.unlink(filePath).catch(() => undefined);
        processedSignalsRef.current.delete(filePath);
        return;
      }

      const promptPreview = getPromptPreview(turns[0].user);
      enqueueJob({
        sessionId: signal.sessionId,
        transcriptPath: signal.transcriptPath,
        turns,
        promptPreview,
        latestTurnSignature: latestTurnUuid,
        signalPath: filePath,
        source: 'hook',
        isPartial: turns.some((turn) => turn.isPartial === true),
      });
      enqueued = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to process review signal.';
      setStatusMessages((prev) => [...prev, message]);
    } finally {
      if (!enqueued) {
        processedSignalsRef.current.delete(filePath);
      }
    }
  }

  async function queueManualReview(session: ActiveSession): Promise<boolean> {
    const sinceSignature = latestKnownSignature();
    const { turns, latestTurnUuid } = await extractTurns({
      transcriptPath: session.transcriptPath,
      sinceUuid: sinceSignature ?? null,
      includeIncomplete: true,
    });

    if (!turns.length) {
      return false;
    }

    const hasAgentContent = turns.some((turn) => Boolean(turn.agent && turn.agent.trim()));
    if (!hasAgentContent) {
      return false;
    }

    const effectiveSignature =
      latestTurnUuid ?? turns[turns.length - 1]?.assistantUuid ?? null;

    const duplicatePending = queueRef.current.some((item) => {
      if (item.sessionId !== session.sessionId) return false;
      if (effectiveSignature) {
        return item.latestTurnSignature === effectiveSignature;
      }
      return item.source === 'manual' && item.latestTurnSignature === null;
    });
    if (duplicatePending) {
      return false;
    }

    const isPartial = turns.some((turn) => turn.isPartial === true);

    if (effectiveSignature) {
      if (isPartial) {
        const partialSignature = `partial:${effectiveSignature}`;
        const hasExistingPartial = reviews.some(
          (review) => review.isPartial && review.turnSignature === partialSignature,
        );
        if (hasExistingPartial) {
          return false;
        }
      } else {
        const hasExistingFullReview = reviews.some(
          (review) => !review.isPartial && review.turnSignature === effectiveSignature,
        );
        if (hasExistingFullReview) {
          return false;
        }
      }
    }

    const promptPreview = getPromptPreview(turns[0].user);
    enqueueJob({
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      turns,
      promptPreview,
      latestTurnSignature: effectiveSignature,
      signalPath: null,
      source: 'manual',
      isPartial,
    });

    return true;
  }

  async function readSignalFile(filePath: string): Promise<{ sessionId: string; transcriptPath: string; queuedAt: number } | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { sessionId?: string; transcriptPath?: string; queuedAt?: number };
      if (!parsed.sessionId || !parsed.transcriptPath) {
        return null;
      }
      return {
        sessionId: parsed.sessionId,
        transcriptPath: parsed.transcriptPath,
        queuedAt: parsed.queuedAt ?? Date.now(),
      };
    } catch {
      return null;
    }
  }

  function latestKnownSignature(): string | null {
    if (queueRef.current.length) {
      for (let index = queueRef.current.length - 1; index >= 0; index -= 1) {
        const job = queueRef.current[index];
        if (job.source === 'manual' && job.isPartial) {
          continue;
        }
        if (job.latestTurnSignature) {
          return job.latestTurnSignature;
        }
      }
    }
    return lastTurnSignatureRef.current;
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
      const fetched = await listActiveSessions();
      setSessions(fetched);
      if (fetched.length) {
        setSelectedIndex(0);
        setScreen('session-list');
      } else {
        setError('No active Claude Code sessions found for this repository.');
        setScreen('error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions. Try again.';
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

      {screen === 'running' && (
        <Box marginTop={1}>
          <Text dimColor>
            Codex thread: {debugMode ? 'Debug mode (no thread)' : threadId ?? 'Establishing…'}
          </Text>
        </Box>
      )}

      {isStreamOverlayOpen ? (
        <StreamOverlay
          events={streamEvents}
          context={streamContext}
          isLive={isStreamLive}
        />
      ) : (
        <>
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
              {hooksJustConfigured && (
                <Text color="green">✓ Hooks configured</Text>
              )}
              {hookConfigWarning && (
                <Text color="yellow">⚠ {hookConfigWarning}</Text>
              )}
              <Text>Select a Claude session to review:</Text>
              <Box flexDirection="column" marginTop={1}>
                {sessions.map((session, index) => (
                  <SessionRow
                    key={`${session.sessionId}-${session.lastUpdated ?? index}`}
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

              {reviews.map((item, index) => (
              <CritiqueCard
                key={`${item.session.sessionId}-${index}`}
                critique={item.critique}
                prompt={item.latestPrompt}
                index={index + 1}
                isPartial={item.isPartial === true}
              />
              ))}

              <Box marginTop={1} flexDirection="column">
                {(() => {
                  const { status, keybindings, isReviewing, statusMessage, queuedItems } = formatStatus(currentJob, queue, isInitialReview, manualSyncTriggered);

                  const queueDisplay = queuedItems.length > 0 && (
                    <Box marginTop={1} flexDirection="column">
                      <Text dimColor>Queue:</Text>
                      {queuedItems.map((item, index) => {
                        const label = formatQueueLabel(item);
                        return (
                          <Text key={`${item.sessionId}-${index}`} dimColor>
                            {`  ${index + 1}. ${label}`}
                          </Text>
                        );
                      })}
                    </Box>
                  );

                  if (currentStatusMessage) {
                    return (
                      <>
                        {currentJob && (
                          <Text dimColor>
                            Reviewing response for: {formatQueueLabel(currentJob)}
                          </Text>
                        )}
                        <Spinner message={currentStatusMessage} />
                        <Text dimColor>{keybindings}</Text>
                        {queueDisplay}
                      </>
                    );
                  }

                  if (isReviewing && statusMessage) {
                    return (
                      <>
                        <Spinner message={statusMessage} />
                        <Text dimColor>{keybindings}</Text>
                        {queueDisplay}
                      </>
                    );
                  }

                  return (
                    <>
                      <Text dimColor>{status}</Text>
                      <Text dimColor>{keybindings}</Text>
                      {queueDisplay}
                    </>
                  );
                })()}
              </Box>
            </Box>
          )}

          {screen === 'chat' && activeChatReviewIndex !== null && (
            <Box marginTop={1} flexDirection="column">
              <Text>{'─'.repeat(80)}</Text>
              <Text bold>
                Chat with Sage
              </Text>

              <Text>{'─'.repeat(80)}</Text>

              {statusMessages.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  {statusMessages.map((message, index) => (
                    <Text key={`${message}-${index}`} dimColor>
                      {message}
                    </Text>
                  ))}
                </Box>
              )}

              <Box marginTop={1} flexDirection="column">
                {chatMessages
                  .filter((msg) => msg.relatedReviewIndex === activeChatReviewIndex)
                  .map((msg, idx) => (
                    <ChatCard key={idx} message={msg} />
                  ))}
              </Box>

              {isWaitingForChat ? (
                <Box marginTop={1}>
                  <Spinner message="sage is thinking..." />
                </Box>
              ) : (
                <Box marginTop={1}>
                  <Text>
                    <Text dimColor>&gt; </Text>
                    {chatInput}
                    <Text inverse> </Text>
                  </Text>
                </Box>
              )}

              <Box marginTop={1}>
                <Text dimColor>
                  {isWaitingForChat
                    ? '↵ send • ESC exit'
                    : '↵ send • ESC exit'}
                </Text>
              </Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

interface SessionRowProps {
  session: ActiveSession;
  index: number;
  isSelected: boolean;
}

function SessionRow({ session, index, isSelected }: SessionRowProps) {
  const timestamp = formatRelativeTime(session.lastUpdated);
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

function toCompletedReview(stored: StoredReview, session: ActiveSession): CompletedReview {
  return {
    critique: stored.critique,
    transcriptPath: session.transcriptPath,
    latestPrompt: stored.latestPrompt ?? undefined,
    debugInfo:
      stored.artifactPath && stored.promptText
        ? { artifactPath: stored.artifactPath, promptText: stored.promptText }
        : undefined,
    completedAt: stored.completedAt,
    turnSignature: stored.turnSignature,
    session,
    isFreshCritique: true,
    streamEvents: [],
    isPartial: false,
  };
}

function formatRelativeTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return 'Unknown time';

  const diff = Date.now() - timestampMs;
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestampMs).toLocaleString();
}

function getProjectName(cwdPath: string): string {
  return path.basename(cwdPath);
}

function formatQueueLabel(job: ReviewQueueItem): string {
  const baseLabel = (() => {
    if (job.turns.length <= 1) return job.promptPreview;
    const extraCount = job.turns.length - 1;
    const plural = extraCount === 1 ? '' : 's';
    return `${job.promptPreview} (+${extraCount} more turn${plural})`;
  })();
  const partialSuffix = job.isPartial ? ' [partial]' : '';
  const originSuffix = job.source === 'manual' ? ' [manual]' : '';
  return `${baseLabel}${partialSuffix}${originSuffix}`;
}

function formatStatus(
  currentJob: ReviewQueueItem | null,
  queue: ReviewQueueItem[],
  isInitialReview: boolean,
  manualSyncTriggered: boolean,
): { status: string; keybindings: string; isReviewing: boolean; statusMessage?: string; queuedItems: ReviewQueueItem[] } {
  const manualSyncLabel = manualSyncTriggered ? 'M to trigger review manually (triggered)' : 'M to trigger review manually';
  const streamOverlayLabel = 'Ctrl+O to view stream';
  const queuedItems = currentJob ? queue.slice(1) : queue;
  const pendingCount = queuedItems.length;

  if (isInitialReview) {
    return {
      status: 'Status: ⏵ Running initial review...',
      statusMessage: 'running initial review...',
      keybindings: `${streamOverlayLabel} • ${manualSyncLabel}`,
      isReviewing: true,
      queuedItems,
    };
  }

  if (currentJob) {
    const jobLabel = `"${formatQueueLabel(currentJob)}"`;
    const queueInfo = pendingCount > 0 ? ` • ${pendingCount} queued` : '';
    const queueSuffix = pendingCount > 0 ? ` • ${pendingCount} queued` : '';
    return {
      status: `Status: ⏵ Reviewing response for ${jobLabel}${queueInfo}`,
      statusMessage: `reviewing response for ${jobLabel}${queueSuffix}`,
      keybindings: `${streamOverlayLabel} • ${manualSyncLabel}`,
      isReviewing: true,
      queuedItems,
    };
  }

  return {
    status: 'Status: ⏺ Waiting for Claude response',
    keybindings: `${streamOverlayLabel} • C to chat with Sage • ${manualSyncLabel}`,
    isReviewing: false,
    queuedItems,
  };
}
