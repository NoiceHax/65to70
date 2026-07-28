import { browser } from 'wxt/browser';
import { coverageRatio, db, emptyCoverage, isComplete } from './db';
import { cleanTitle, isUsableTitle, type CleanedTitle } from './titleClean';
import { rankCandidates, type PageMetaResult } from './pageMeta';
import { refreshBadge } from './badge';
import type { UrlIdCandidate } from './urlIds';
import type {
  ConfirmPromptMessage,
  MediaProgressMessage,
  PageMetaMessage,
} from './messages';
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
  /** Catalogue ids read from the URL, top frame preferred. */
  urlIds?: UrlIdCandidate[];

  /** Cross-origin iframe origins seen on the page, for the diagnostics panel. */
  embeddedOrigins?: string[];
  /** Whether any injected frame reported a usable media element. */
  sawVideo?: boolean;
  lastSeenUrl?: string;
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
 * Discovery order is not preference order — the most structured source is not
 * always the most truthful. A client-rendered site bakes its brand name into
 * `og:title` on every page, so ranking has to demote it below the live
 * `document.title` and reject anything that is just the site's own name.
 */
export function bestTitle(state: TabState): (CleanedTitle & { raw: string }) | null {
  const candidates = rankCandidates(
    [...(state.metaTop ?? []), ...(state.metaSub ?? [])],
    state.hostname ?? '',
  );

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

  // A new page means the previous diagnosis no longer applies.
  if (msg.isTopFrame && state.lastSeenUrl !== undefined && state.lastSeenUrl !== msg.url) {
    state.sawVideo = false;
    state.embeddedOrigins = undefined;
  }

  // Any frame finding a video is enough; they report independently.
  if (msg.hasVideo) state.sawVideo = true;

  if (msg.isTopFrame) {
    state.metaTop = msg.candidates;
    state.url = msg.url;
    state.hostname = msg.hostname;
    state.embeddedOrigins = msg.embeddedOrigins;
    state.lastSeenUrl = msg.url;
    if (msg.urlIds.length > 0) state.urlIds = msg.urlIds;
  } else {
    state.metaSub = msg.candidates;
    state.hostname ??= msg.hostname;
    // A subframe's URL is the embed URL, which often carries the id even when
    // the parent page's URL does not.
    if (msg.urlIds.length > 0 && (state.urlIds ?? []).length === 0) {
      state.urlIds = msg.urlIds;
    }
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

  if (justCompleted) await createPending(state, state.sessionId, msg.hostname, tabId);

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
    urlIds: (state.urlIds ?? []).map((i) => `${i.source}:${i.id}`).join(', ') || '(none)',
    coverage: `${Math.round(coverageRatio(coverage) * 100)}%`,
    complete: nowComplete,
    // Every candidate, so a wrong pick can be diagnosed without guessing which
    // source produced it.
    candidates: rankCandidates(
      [...(state.metaTop ?? []), ...(state.metaSub ?? [])],
      state.hostname ?? '',
    ).map((c) => `${c.strategy}="${c.rawTitle}"`),
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
  tabId: number,
): Promise<void> {
  const existing = await db.pending.where('sessionId').equals(sessionId).count();
  if (existing > 0) return;

  const title = bestTitle(state);
  const urlIds = state.urlIds ?? [];

  // A URL-borne catalogue id is enough on its own. Client-rendered sites are
  // exactly the case where no readable title exists, and they're also the ones
  // most likely to key their pages on a TMDB id.
  if (!title && urlIds.length === 0) {
    // Tier 3 territory: playback completed, nothing identifiable on the page.
    // M4's onboarding surface will ask the user once and remember the answer.
    console.warn('[keeper] completed session with nothing identifiable', { hostname });
    return;
  }

  const pending: PendingDetection = {
    sessionId,
    rawTitle: title?.raw ?? '',
    cleanedTitle: title?.title ?? '',
    year: title?.year,
    season: title?.season ?? urlIds.find((i) => i.season !== undefined)?.season,
    episode: title?.episode ?? urlIds.find((i) => i.episode !== undefined)?.episode,
    hostname,
    candidates: [], // Populated by the resolver in M2.
    urlIds,
    detectedAt: Date.now(),
    status: 'awaiting',
  };

  const pendingId = (await db.pending.add(pending)) as number;
  await refreshBadge();
  console.log(
    '[keeper] queued for confirmation:',
    pending.cleanedTitle || `(by id ${urlIds.map((i) => `${i.source}:${i.id}`).join(', ')})`,
    pending.year ?? '',
  );

  // Resolve straight away so the confirm queue has candidates ready when the
  // user opens it. Resolution never marks anything watched — that still needs
  // an explicit confirmation.
  try {
    const { resolvePending } = await import('./resolver');
    const outcome = await resolvePending(pendingId);
    console.log('[keeper] resolution:', outcome.status, outcome.message ?? '');

    // Ask in the page, while the credits are still rolling — but only when the
    // resolver already knows what it was. Confirming a confident guess is a
    // reasonable interruption; asking someone to identify a film from scratch
    // mid-page is not, and that stays in the queue.
    if (outcome.status === 'resolved' && outcome.movie) {
      const prompt: ConfirmPromptMessage = {
        type: 'confirm-prompt',
        pendingId,
        tmdbId: outcome.movie.tmdbId,
        mediaType: outcome.movie.mediaType,
        title: outcome.movie.title,
        year: outcome.movie.year,
      };
      browser.tabs.sendMessage(tabId, prompt).catch(() => {
        // Tab closed or navigated away; the queue still has it.
      });
    }
  } catch (error) {
    console.warn('[keeper] resolution failed', error);
  }
}

export interface TabDiagnostics {
  /** True once any frame in the tab has reported in. */
  scriptRan: boolean;
  sawVideo: boolean;
  /** Cross-origin iframe origins the page loads. */
  embeddedOrigins: string[];
  bestTitle: string | null;
  urlIds: string[];
  hasOpenSession: boolean;
}

/**
 * What Keeper currently believes about a tab.
 *
 * Exists because "nothing happened" is the least actionable bug report a user
 * can give. Distinguishing "the script never ran" from "it ran but found no
 * video" from "it found a video but no title" turns one vague symptom into
 * three different, obvious fixes.
 */
export async function tabDiagnostics(tabId: number): Promise<TabDiagnostics> {
  const state = await getTabState(tabId);
  const title = bestTitle(state);

  return {
    scriptRan: state.metaTop !== undefined || state.metaSub !== undefined,
    sawVideo: state.sawVideo === true,
    embeddedOrigins: state.embeddedOrigins ?? [],
    bestTitle: title?.title ?? null,
    urlIds: (state.urlIds ?? []).map((id) => `${id.source}:${id.id}`),
    hasOpenSession: state.sessionId !== undefined,
  };
}

/** Close out any session still open for a tab that's gone. */
export async function handleTabClosed(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (state.sessionId !== undefined) await endSession(state.sessionId);
  await clearTabState(tabId);
}
