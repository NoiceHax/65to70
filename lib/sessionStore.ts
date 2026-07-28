import { browser } from 'wxt/browser';
import { coverageRatio, db, emptyCoverage, isComplete } from './db';
import { cleanTitle, isUsableTitle, type CleanedTitle } from './titleClean';
import type { PageMetaResult } from './pageMeta';
import type { MediaProgressMessage, PageMetaMessage } from './messages';
import type { PendingDetection, Session } from './types';

/**
 * Background-side session tracking.
 *
 * Coverage is accumulated here rather than in the content script because
 * content scripts are destroyed on navigation and would lose it. The content
 * script only reports which buckets it newly saw.
 *
 * Per-tab state lives in `storage.session` rather than a module variable
 * because MV3 service workers are killed after ~30 seconds idle — which is
 * shorter than the gap between progress reports, so an in-memory map would be
 * empty most of the time.
 */

const DURATION_EPSILON_SEC = 5;
/** Below this, a session isn't worth a database row. */
const MIN_MEANINGFUL_RATIO = 0.05;

interface TabState {
  sessionId?: number;
  durationSec?: number;
  hostname?: string;
  url?: string;
  /** Metadata from the top frame — preferred, since embedded players are iframes. */
  metaTop?: PageMetaResult[];
  /** Metadata from a subframe, used only when the top frame offered none. */
  metaSub?: PageMetaResult[];
}

const tabKey = (tabId: number) => `tab:${tabId}`;

async function getTabState(tabId: number): Promise<TabState> {
  const key = tabKey(tabId);
  const stored = await browser.storage.session.get(key);
  return (stored[key] as TabState) ?? {};
}

async function setTabState(tabId: number, state: TabState): Promise<void> {
  await browser.storage.session.set({ [tabKey(tabId)]: state });
}

export async function clearTabState(tabId: number): Promise<void> {
  await browser.storage.session.remove(tabKey(tabId));
}

/**
 * Best usable title for a tab.
 *
 * Candidates arrive already ordered most-structured-first, but structure isn't
 * the same as usefulness — a JSON-LD `name` of "Player" loses to a keyword-
 * stuffed `og:title` that still contains the film. So take the first candidate
 * that survives cleaning rather than the first candidate outright.
 */
export function bestTitle(state: TabState): (CleanedTitle & { raw: string }) | null {
  const candidates = [...(state.metaTop ?? []), ...(state.metaSub ?? [])];

  for (const candidate of candidates) {
    const cleaned = cleanTitle(candidate.rawTitle);
    if (!isUsableTitle(cleaned)) continue;

    return {
      ...cleaned,
      year: cleaned.year ?? candidate.yearHint,
      raw: candidate.rawTitle,
    };
  }

  return null;
}

export async function handlePageMeta(tabId: number, msg: PageMetaMessage): Promise<void> {
  const state = await getTabState(tabId);

  if (msg.isTopFrame) {
    state.metaTop = msg.candidates;
    state.url = msg.url;
    state.hostname = msg.hostname;
  } else {
    state.metaSub = msg.candidates;
    state.hostname ??= msg.hostname;
  }

  await setTabState(tabId, state);
}

async function endSession(sessionId: number): Promise<void> {
  const session = await db.sessions.get(sessionId);
  if (!session) return;

  await db.sessions.update(sessionId, { stoppedAt: Date.now() });

  // Drop rows for glances and mis-fires so the database doesn't fill with noise.
  if (session.complete === 0 && coverageRatio(session.coverage) < MIN_MEANINGFUL_RATIO) {
    await db.sessions.delete(sessionId);
  }
}

export async function handleMediaProgress(
  tabId: number,
  msg: MediaProgressMessage,
): Promise<void> {
  const state = await getTabState(tabId);
  state.hostname ??= msg.hostname;

  // A changed duration means the player swapped media — an ad, or the next
  // episode auto-playing. Close the old session instead of blending two titles.
  if (
    state.sessionId !== undefined &&
    state.durationSec !== undefined &&
    Math.abs(state.durationSec - msg.durationSec) > DURATION_EPSILON_SEC
  ) {
    await endSession(state.sessionId);
    state.sessionId = undefined;
  }

  if (state.sessionId === undefined) {
    const now = Date.now();
    const session: Session = {
      titleKey: null,
      mediaType: bestTitle(state)?.mediaType ?? 'movie',
      startedAt: now,
      lastSeenAt: now,
      coverage: emptyCoverage(),
      durationSec: msg.durationSec,
      site: msg.hostname,
      complete: 0,
    };
    state.sessionId = (await db.sessions.add(session)) as number;
    state.durationSec = msg.durationSec;
  }

  const session = await db.sessions.get(state.sessionId);
  if (!session) {
    // Row vanished (cleared database, manual delete). Start fresh next report.
    state.sessionId = undefined;
    await setTabState(tabId, state);
    return;
  }

  const coverage = new Uint8Array(session.coverage);
  for (const bucket of msg.buckets) {
    if (bucket >= 0 && bucket < coverage.length) coverage[bucket] = 1;
  }

  const nowComplete = isComplete(coverage);
  const justCompleted = nowComplete && session.complete === 0;

  await db.sessions.update(state.sessionId, {
    coverage,
    lastSeenAt: Date.now(),
    complete: nowComplete ? 1 : 0,
    ...(msg.ended ? { stoppedAt: Date.now() } : {}),
  });

  if (justCompleted) await createPending(state, state.sessionId, msg.hostname);

  if (msg.ended) {
    await endSession(state.sessionId);
    state.sessionId = undefined;
    state.durationSec = undefined;
  }

  await setTabState(tabId, state);

  const title = bestTitle(state);
  console.log('[keeper]', {
    site: msg.hostname,
    title: title?.title ?? '(no title found)',
    year: title?.year,
    coverage: `${Math.round(coverageRatio(coverage) * 100)}%`,
    complete: nowComplete,
  });
}

/**
 * Queue a completed session for user confirmation.
 *
 * This is as far as a detection ever gets on its own. Nothing is written to a
 * diary or pushed to a sync target until the user confirms it — a wrong entry
 * in a curated Letterboxd diary is worse than a missing one.
 */
async function createPending(
  state: TabState,
  sessionId: number,
  hostname: string,
): Promise<void> {
  const existing = await db.pending.where('sessionId').equals(sessionId).count();
  if (existing > 0) return;

  const title = bestTitle(state);
  if (!title) {
    // Tier 3 territory: playback completed but no title could be read. M4's
    // onboarding surface will ask the user once and remember the answer.
    console.warn('[keeper] completed session with no readable title', { hostname });
    return;
  }

  const pending: PendingDetection = {
    sessionId,
    rawTitle: title.raw,
    cleanedTitle: title.title,
    year: title.year,
    season: title.season,
    episode: title.episode,
    hostname,
    candidates: [], // Populated by the resolver in M2.
    detectedAt: Date.now(),
    status: 'awaiting',
  };

  await db.pending.add(pending);
  console.log('[keeper] queued for confirmation:', pending.cleanedTitle, pending.year ?? '');
}

/** Close out any session still open for a tab that's gone. */
export async function handleTabClosed(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (state.sessionId !== undefined) await endSession(state.sessionId);
  await clearTabState(tabId);
}
