import path from 'path';
import { promises as fs } from 'fs';
import type { CritiqueResponse } from './codex.js';
import { getReviewsDir } from './paths.js';

export interface StoredReview {
  turnSignature: string;
  completedAt: string;
  latestPrompt?: string | null;
  critique: CritiqueResponse;
  artifactPath?: string;
  promptText?: string;
}

export interface SessionReviewCache {
  sessionId: string;
  lastTurnSignature: string | null;
  reviews: StoredReview[];
}

const REVIEWS_DIR = getReviewsDir();

const MAX_REVIEWS_PER_SESSION = 500;

async function ensureReviewsDir(): Promise<void> {
  await fs.mkdir(REVIEWS_DIR, { recursive: true });
}

function cachePath(sessionId: string): string {
  return path.join(REVIEWS_DIR, `${sessionId}.json`);
}

export function createEmptyCache(sessionId: string): SessionReviewCache {
  return {
    sessionId,
    lastTurnSignature: null,
    reviews: [],
  };
}

export async function loadReviewCache(sessionId: string): Promise<SessionReviewCache | null> {
  await ensureReviewsDir();
  const filePath = cachePath(sessionId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionReviewCache>;
    return normalizeCache(parsed, sessionId);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    console.warn(`[Sage] Failed to load review cache for ${sessionId}: ${error?.message ?? error}`);
    return null;
  }
}

export async function saveReviewCache(cache: SessionReviewCache): Promise<void> {
  await ensureReviewsDir();
  const filePath = cachePath(cache.sessionId);
  const tmpPath = `${filePath}.tmp`;
  const content = `${JSON.stringify(cache, null, 2)}\n`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function deleteReviewCache(sessionId: string): Promise<void> {
  await ensureReviewsDir();
  const filePath = cachePath(sessionId);
  try {
    await fs.unlink(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[Sage] Failed to delete review cache for ${sessionId}: ${error?.message ?? error}`);
    }
  }
}

export function appendReviewToCache(
  cache: SessionReviewCache,
  review: StoredReview,
): SessionReviewCache {
  const existingIndex = cache.reviews.findIndex((item) => item.turnSignature === review.turnSignature);
  if (existingIndex >= 0) {
    cache.reviews.splice(existingIndex, 1);
  }
  cache.reviews.push(review);
  cache.lastTurnSignature = review.turnSignature;

  if (cache.reviews.length > MAX_REVIEWS_PER_SESSION) {
    cache.reviews = cache.reviews.slice(cache.reviews.length - MAX_REVIEWS_PER_SESSION);
  }

  return cache;
}

export function ensureReviewCache(cache: SessionReviewCache | null, sessionId: string): SessionReviewCache {
  return cache ?? createEmptyCache(sessionId);
}

function normalizeCache(
  raw: Partial<SessionReviewCache> | null,
  sessionId: string,
): SessionReviewCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  const sanitized: StoredReview[] = [];
  for (const entry of reviews) {
    if (!entry || typeof entry !== 'object') continue;
    const { turnSignature, completedAt, critique } = entry as StoredReview;
    if (!turnSignature || typeof turnSignature !== 'string') continue;
    if (!completedAt || typeof completedAt !== 'string') continue;
    if (!critique || typeof critique !== 'object') continue;
    sanitized.push({
      turnSignature,
      completedAt,
      critique,
      latestPrompt: entry.latestPrompt ?? null,
      artifactPath: entry.artifactPath,
      promptText: entry.promptText,
    });
  }

  sanitized.sort((a, b) => {
    const aTime = Date.parse(a.completedAt);
    const bTime = Date.parse(b.completedAt);
    return aTime - bTime;
  });

  const lastTurnSignature =
    typeof raw.lastTurnSignature === 'string'
      ? raw.lastTurnSignature
      : sanitized.length
        ? sanitized[sanitized.length - 1].turnSignature
        : null;

  return {
    sessionId,
    lastTurnSignature,
    reviews: sanitized,
  };
}
