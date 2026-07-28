import { browser } from 'wxt/browser';
import { coverageRatio, db, emptyCoverage, isComplete } from './db';
import { cleanTitle, isUsableTitle, type CleanedTitle } from './titleClean';
import { rankCandidates, type PageMetaResult } from './pageMeta';
import { refreshBadge } from './badge';
import { liveFramesForTab } from './frames';
import { wasDismissed } from './dismissed';
import { resolvePending } from './resolver';
import { SAMPLE_INTERVAL_MS, bucketIndex, bucketsCovered } from './progress';
import type { UrlIdCandidate } from './urlIds';
import type {
  ConfirmPromptMessage,
  EmbeddedFrame,
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
  embeddedFrames?: EmbeddedFrame[];
  /** What has already been queued for this tab, so it isn't queued twice. */
  queuedSignature?: string;
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

    // A source that stated the episode outright beats one parsed out of a
    // title string — and can express a known episode in an unknown season,
    // which the string form cannot.
    const season = cleaned.season ?? candidate.season;
    const episode = cleaned.episode ?? candidate.episode;

    return {
      ...cleaned,
      season,
      episode,
      mediaType: episode !== undefined ? 'tv' : cleaned.mediaType,
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
    state.embeddedFrames = undefined;
  }

  // Any frame finding a video is enough; they report independently.
  if (msg.hasVideo) state.sawVideo = true;

  if (msg.isTopFrame) {
    state.metaTop = msg.candidates;
    state.url = msg.url;
    state.hostname = msg.hostname;
    state.embeddedFrames = msg.embeddedFrames;
    state.lastSeenUrl = msg.url;
    if (msg.urlIds.length > 0) state.urlIds = msg.urlIds;
  } else {
    state.metaSub = msg.candidates;
    state.hostname ??= msg.hostname;

    // Merge rather than replace. These sites chain their embeds — the page
    // loads a player host, which loads the actual stream host — so the next
    // origin to grant is often only visible from inside the frame that was
    // just granted. Keeping both means the chain can be followed one link at
    // a time instead of dead-ending.
    const merged = new Map(
      (state.embeddedFrames ?? []).map((frame) => [frame.origin, frame]),
    );
    for (const frame of msg.embeddedFrames) {
      const existing = merged.get(frame.origin);
      merged.set(frame.origin, {
        origin: frame.origin,
        likelyPlayer: (existing?.likelyPlayer ?? false) || frame.likelyPlayer,
      });
    }
    state.embeddedFrames = [...merged.values()];

    // A subframe's URL is the embed URL, which often carries the id even when
    // the parent page's URL does not.
    if (msg.urlIds.length > 0 && (state.urlIds ?? []).length === 0) {
      state.urlIds = msg.urlIds;
    }
  }

  await setTabState(tabId, state);
  await maybeQueueFromPage(tabId, state, msg);
}

/**
 * Does this page look like something is being watched on it?
 *
 * Any one of these is enough. A catalogue id in the URL, a media element, or an
 * embedded player all say the same thing in different ways, and requiring more
 * than one would rule out exactly the sites that only manage one.
 */
function looksLikeWatchPage(msg: PageMetaMessage): boolean {
  if (msg.hasVideo) return true;
  if (msg.urlIds.length > 0) return true;
  if (msg.embeddedFrames.some((frame) => frame.likelyPlayer)) return true;
  return /[/?&](watch|play)\b/i.test(msg.url);
}

/**
 * Queue a title from page data alone, without waiting for playback.
 *
 * Everything used to be gated behind finding a `<video>`, which meant a page
 * whose title had been read perfectly well produced nothing at all — the
 * element was in a closed shadow root, or a frame that couldn't be reached, and
 * the identification was thrown away with it.
 *
 * That is the wrong priority. Knowing *what* is being watched is the point;
 * measuring how much of it was watched is a refinement. So identification now
 * stands on its own, and coverage attaches to the same session later if a media
 * element ever does turn up.
 */
async function maybeQueueFromPage(
  tabId: number,
  state: TabState,
  msg: PageMetaMessage,
): Promise<void> {
  if (!looksLikeWatchPage(msg)) return;

  const title = bestTitle(state);
  const urlIds = state.urlIds ?? [];
  if (!title && urlIds.length === 0) return;

  // One entry per identification per tab. Navigating between films re-queues;
  // a page re-rendering itself does not.
  const signature =
    urlIds.length > 0
      ? urlIds.map((id) => `${id.source}:${id.id}`).join(',')
      : `${title!.title}:${title!.year ?? ''}`;

  if (state.queuedSignature === signature) return;

  /*
   * A different film in the same tab gets its own session.
   *
   * Without this the second film reuses the first one's session, and a session
   * that already carries a queued entry is never queued again — so the title is
   * read correctly, matched correctly, and then dropped on the floor without a
   * word. Watching two things in one tab is completely ordinary, so this was
   * not an edge case.
   */
  if (state.sessionId !== undefined && state.queuedSignature !== undefined) {
    await endSession(state.sessionId);
    state.sessionId = undefined;
    state.durationSec = undefined;
  }

  state.queuedSignature = signature;

  if (state.sessionId === undefined) {
    const now = Date.now();
    state.sessionId = (await db.sessions.add({
      titleKey: null,
      mediaType: title?.mediaType ?? 'movie',
      startedAt: now,
      lastSeenAt: now,
      coverage: emptyCoverage(),
      site: msg.hostname,
      complete: 0,
    })) as number;
  }

  await setTabState(tabId, state);
  await createPending(state, state.sessionId, msg.hostname, tabId);
}

async function endSession(sessionId: number): Promise<void> {
  const session = await db.sessions.get(sessionId);
  if (!session) return;

  await db.sessions.update(sessionId, { stoppedAt: Date.now() });

  // Drop rows for glances and mis-fires so the database doesn't fill with
  // noise — but never one the user has been asked to confirm. Sessions created
  // from page data alone carry no coverage by design, and pruning those would
  // delete the identification along with them.
  const queued = await db.pending.where('sessionId').equals(sessionId).count();
  if (
    queued === 0 &&
    session.complete === 0 &&
    coverageRatio(session.coverage) < MIN_MEANINGFUL_RATIO
  ) {
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

    /*
     * Ask as soon as something is playing, not at the end.
     *
     * Waiting for the completion threshold meant two hours of silence before
     * the extension gave any sign it had noticed — and if anything upstream was
     * wrong, the silence was indistinguishable from being broken. Confirming
     * identity up front is also simply a better question: "is this Supergirl?"
     * is answerable while it's on screen.
     *
     * Whether it counts as *watched* is still decided by coverage. This settles
     * what it is, not whether you finished it.
     */
    await setTabState(tabId, state);
    await createPending(state, state.sessionId, msg.hostname, tabId);
  }

  const session = await db.sessions.get(state.sessionId);
  if (!session) {
    // Row vanished (cleared database, manual delete). Start fresh next report.
    state.sessionId = undefined;
    await setTabState(tabId, state);
    return;
  }

  /*
   * Positions become coverage here, not in the page.
   *
   * The runtime is what turns one into the other, and the player frequently
   * cannot supply it — NaN duration, empty seekable range. The resolved
   * catalogue entry can, and is more accurate anyway, since it isn't inflated
   * by adverts spliced into the stream. Until something knows the runtime,
   * positions are simply held; nothing is lost, the conversion just waits.
   */
  const runtimeSec =
    session.runtimeSec && session.runtimeSec > 0
      ? session.runtimeSec
      : (session.durationSec ?? 0);

  const coverage = new Uint8Array(session.coverage);

  if (runtimeSec > 0) {
    let previous: number | null = null;
    for (const sample of msg.samples) {
      const bucket = bucketIndex(sample, runtimeSec);
      // Consecutive samples are one interval apart during ordinary playback,
      // so the span between them was genuinely watched. A seek lands far from
      // the previous sample and only credits where it landed.
      const covered = bucketsCovered(previous, bucket, SAMPLE_INTERVAL_MS, SAMPLE_INTERVAL_MS);
      for (const index of covered) {
        if (index >= 0 && index < coverage.length) coverage[index] = 1;
      }
      previous = bucket;
    }
  }

  const nowComplete = isComplete(coverage);
  const justCompleted = nowComplete && session.complete === 0;

  await db.sessions.update(state.sessionId, {
    coverage,
    lastSeenAt: Date.now(),
    complete: nowComplete ? 1 : 0,
    ...(msg.ended ? { stoppedAt: Date.now() } : {}),
  });

  // Normally the queue entry already exists from detection. This is the
  // fallback for a session that started before that was the behaviour, or one
  // whose title only became readable later.
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

  {
    // Already told this isn't a film here. A catalogue id overrides that,
    // since it's a far stronger signal than a page title.
    const known = bestTitle(state);
    if (
      known &&
      (state.urlIds ?? []).length === 0 &&
      (await wasDismissed(hostname, known.title))
    ) {
      return;
    }
  }

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
    const outcome = await resolvePending(pendingId);
    console.log('[keeper] resolution:', outcome.status, outcome.message ?? '');

    // The runtime the coverage maths needs. Taken from the catalogue rather
    // than the player, which frequently cannot supply one at all.
    if (outcome.movie?.runtime) {
      await db.sessions.update(sessionId, { runtimeSec: outcome.movie.runtime * 60 });
      console.log('[keeper] runtime from catalogue:', outcome.movie.runtime, 'min');
    }

    /*
     * Drop what turned out not to be a film.
     *
     * Identifying from page data alone means site chrome gets picked up too —
     * a homepage titled "Home - NetMirror", a hidden utility frame called
     * "RotateCookiesPage". Asking the user to sort those out is offloading a
     * machine's job onto them.
     *
     * The resolver already answers this: a real title matches something, and
     * these match nothing. So "no candidates" is treated as "not a film" and
     * the entry is withdrawn.
     *
     * The exception is `offline`, which means nothing was configured to match
     * against. That's a setup problem, not a verdict, and discarding on it
     * would silently throw away real viewing.
     */
    const matched =
      outcome.status === 'resolved' ||
      outcome.candidates.length > 0 ||
      urlIds.length > 0 ||
      outcome.status === 'offline';

    if (!matched) {
      console.log('[keeper] discarded, matched nothing:', pending.cleanedTitle);
      await db.pending.delete(pendingId);
      await refreshBadge();
      return;
    }

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
  embeddedFrames: EmbeddedFrame[];
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

  // Where the frames actually are now takes priority over what the markup
  // said. Embed hosts redirect, and a src attribute names the origin the
  // player has already left — granting that one changes nothing.
  const live = await liveFramesForTab(tabId);
  const merged = new Map(
    (state.embeddedFrames ?? []).map((frame) => [frame.origin, frame]),
  );
  for (const frame of live) {
    const existing = merged.get(frame.origin);
    merged.set(frame.origin, {
      origin: frame.origin,
      likelyPlayer: (existing?.likelyPlayer ?? false) || frame.likelyPlayer,
    });
  }

  return {
    scriptRan: state.metaTop !== undefined || state.metaSub !== undefined,
    sawVideo: state.sawVideo === true,
    embeddedFrames: [...merged.values()],
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
