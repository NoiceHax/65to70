import Dexie, { type EntityTable } from 'dexie';
import {
  COMPLETION_THRESHOLD,
  COVERAGE_BUCKETS,
  type Collection,
  type CollectionItem,
  type MetaEntry,
  type Movie,
  type PendingDetection,
  type Session,
  type SiteRule,
  type SyncState,
  type TitleKey,
} from './types';

/**
 * Everything lives here and nowhere else. No user data is uploaded; the only
 * outbound traffic in the whole extension is prepared-index downloads and
 * explicitly connected sync targets.
 */
export class KeeperDB extends Dexie {
  movies!: EntityTable<Movie, 'key'>;
  sessions!: EntityTable<Session, 'id'>;
  pending!: EntityTable<PendingDetection, 'id'>;
  collections!: EntityTable<Collection, 'id'>;
  collectionItems!: EntityTable<CollectionItem, 'id'>;
  siteRules!: EntityTable<SiteRule, 'hostname'>;
  syncState!: EntityTable<SyncState, 'provider'>;
  meta!: EntityTable<MetaEntry, 'key'>;

  constructor() {
    super('keeper');

    this.version(1).stores({
      movies: 'key, tmdbId, mediaType, title, year, watched, liked, rating, lastDetected, *tags',
      sessions: '++id, titleKey, startedAt, lastSeenAt, complete, site, [titleKey+complete]',
      pending: '++id, sessionId, hostname, detectedAt, status',
      collections: '++id, &name, order',
      collectionItems: '++id, collectionId, titleKey, [collectionId+order]',
      siteRules: 'hostname, strategy, learnedAt',
      syncState: 'provider',
      meta: 'key',
    });
  }
}

export const db = new KeeperDB();

// ---------------------------------------------------------------------------
// Coverage helpers
// ---------------------------------------------------------------------------

export function emptyCoverage(): Uint8Array {
  return new Uint8Array(COVERAGE_BUCKETS);
}

/** Fraction of buckets played, 0–1. */
export function coverageRatio(coverage: Uint8Array): number {
  let covered = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i]) covered++;
  return covered / coverage.length;
}

/**
 * Union of several bitmaps. Completion is evaluated against the union across a
 * title's sessions, so watching half on Monday and half on Friday still counts.
 */
export function unionCoverage(maps: Uint8Array[]): Uint8Array {
  const out = emptyCoverage();
  for (const map of maps) {
    for (let i = 0; i < out.length && i < map.length; i++) {
      if (map[i]) out[i] = 1;
    }
  }
  return out;
}

export function isComplete(coverage: Uint8Array): boolean {
  return coverageRatio(coverage) >= COMPLETION_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * Recompute `watched` and `rewatch` for a title from its sessions.
 *
 * `watched` is true when the *union* of session coverage clears the threshold —
 * not when any single session does. `rewatch` counts individually-complete
 * sessions beyond the first, which is what Letterboxd's Rewatch column means.
 */
/** Group key for one episode. Films collapse to a single group. */
function episodeKey(session: Session): string {
  return `${session.season ?? 0}:${session.episode ?? 0}`;
}

export async function recomputeWatchState(key: TitleKey): Promise<void> {
  const sessions = await db.sessions.where('titleKey').equals(key).toArray();
  if (sessions.length === 0) return;

  const movie = await db.movies.get(key);
  if (!movie) return;

  // A figure set by hand is not something later measurement gets to overwrite.
  // Episode counts still update, since those are counted rather than measured.
  const manual = movie.manualProgress !== undefined;

  /*
   * Coverage only ever unions within a single episode.
   *
   * Unioning across a whole series was actively wrong: two half-watched
   * episodes covering opposite halves would add up to "complete", marking a
   * show watched that had never been finished once. Grouping by episode makes
   * films a group of one, so they behave exactly as before.
   */
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const group = episodeKey(session);
    groups.set(group, [...(groups.get(group) ?? []), session]);
  }

  let finishedGroups = 0;
  let rewatches = 0;

  for (const group of groups.values()) {
    if (isComplete(unionCoverage(group.map((s) => s.coverage)))) finishedGroups++;
    // A second complete session of the same episode is a rewatch of it.
    rewatches += Math.max(0, group.filter((s) => s.complete === 1).length - 1);
  }

  if (movie.mediaType === 'tv') {
    // A series is never "finished" the way a film is; it accumulates. Watched
    // here means at least one episode has been seen through.
    await db.movies.update(key, {
      ...(manual ? {} : { watched: finishedGroups > 0 ? 1 : 0 }),
      episodesWatched: finishedGroups,
      rewatch: rewatches,
    });
    return;
  }

  await db.movies.update(key, {
    ...(manual ? {} : { watched: finishedGroups > 0 ? 1 : 0 }),
    rewatch: rewatches,
  });
}

/**
 * How much of a title has been seen, across every session for it.
 *
 * A single session is not the answer. Pages reload — ad layers on these sites
 * force it constantly — and each reload starts a fresh session, so a film
 * watched in three stretches has three partial bitmaps. Reporting only the
 * latest is how a finished film reads as a quarter watched.
 *
 * A manual figure wins outright: the person watching knows better than the
 * measurement does.
 */
export async function titleProgress(key: TitleKey): Promise<number> {
  const movie = await db.movies.get(key);
  if (movie?.manualProgress !== undefined) return movie.manualProgress;

  const sessions = await db.sessions.where('titleKey').equals(key).toArray();
  if (sessions.length === 0) return 0;

  if (movie?.mediaType === 'tv') {
    // Progress through a single episode is the only meaningful figure for a
    // series; the newest one is what the viewer is on.
    const newest = sessions.reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a));
    const sameEpisode = sessions.filter(
      (s) => s.season === newest.season && s.episode === newest.episode,
    );
    return coverageRatio(unionCoverage(sameEpisode.map((s) => s.coverage)));
  }

  return coverageRatio(unionCoverage(sessions.map((s) => s.coverage)));
}

/**
 * Set progress by hand, overriding measurement.
 *
 * Also settles whether it counts as watched, since that is the reason anyone
 * reaches for this — a film finished that the bitmap disagrees about.
 */
export async function setManualProgress(key: TitleKey, ratio: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, ratio));
  await db.movies.update(key, {
    manualProgress: clamped,
    watched: clamped >= COMPLETION_THRESHOLD ? 1 : 0,
  });
}

/** Hand progress back to measurement. */
export async function clearManualProgress(key: TitleKey): Promise<void> {
  await db.movies.update(key, { manualProgress: undefined });
  await recomputeWatchState(key);
}

export interface ActiveTracking {
  sessionId: number;
  /** Resolved title when known, otherwise whatever was read off the page. */
  title: string;
  /** False while the title is still just page text, not a catalogue match. */
  identified: boolean;
  site: string;
  ratio: number;
  season?: number;
  episode?: number;
  lastSeenAt: number;
}

/**
 * What is being tracked right now.
 *
 * A session counts as live if it reported in recently — the content script
 * flushes every fifteen seconds, so a minute and a half of silence means
 * playback stopped, the tab closed, or something broke. Erring long is
 * deliberate: showing a stale row briefly is better than a status that blinks
 * out while a film is still playing.
 */
export async function activeTracking(withinMs = 90_000): Promise<ActiveTracking[]> {
  const since = Date.now() - withinMs;

  const sessions = await db.sessions
    .where('lastSeenAt')
    .above(since)
    .filter((session) => session.stoppedAt === undefined)
    .toArray();

  const out: ActiveTracking[] = [];

  for (const session of sessions) {
    if (session.id === undefined) continue;

    let title: string | null = null;
    let identified = false;

    // Across every session for the title, not just this one. Reloads fragment
    // a single viewing into several sessions, and reporting the newest alone
    // makes a finished film read as barely started.
    let ratio = coverageRatio(session.coverage);

    if (session.titleKey) {
      const movie = await db.movies.get(session.titleKey);
      if (movie) {
        title = movie.title;
        identified = true;
        ratio = await titleProgress(session.titleKey);
      }
    }

    if (!title) {
      // Not confirmed yet, so fall back to what the queue is showing.
      const pending = await db.pending.where('sessionId').equals(session.id).first();
      title = pending?.cleanedTitle || null;
    }

    out.push({
      sessionId: session.id,
      title: title || 'Identifying…',
      identified,
      site: session.site,
      ratio,
      season: session.season,
      episode: session.episode,
      lastSeenAt: session.lastSeenAt,
    });
  }

  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export interface WatchedEpisode {
  season: number;
  episode: number;
  lastSeenAt: number;
}

/** Episodes of a series that have been seen through, newest first. */
export async function watchedEpisodes(key: TitleKey): Promise<WatchedEpisode[]> {
  const sessions = await db.sessions.where('titleKey').equals(key).toArray();

  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.season === undefined || session.episode === undefined) continue;
    const group = episodeKey(session);
    groups.set(group, [...(groups.get(group) ?? []), session]);
  }

  const out: WatchedEpisode[] = [];
  for (const group of groups.values()) {
    if (!isComplete(unionCoverage(group.map((s) => s.coverage)))) continue;
    out.push({
      season: group[0].season!,
      episode: group[0].episode!,
      lastSeenAt: Math.max(...group.map((s) => s.lastSeenAt)),
    });
  }

  return out.sort((a, b) => b.season - a.season || b.episode - a.episode);
}

/**
 * Titles with real progress but no complete session — "you stopped 42 minutes
 * in, 3 days ago". Works across every service at once because it reads our own
 * sessions rather than any provider's API.
 */
export async function continueWatching(limit = 20) {
  const sessions = await db.sessions
    .orderBy('lastSeenAt')
    .reverse()
    .filter((s) => s.complete === 0 && s.titleKey !== null)
    .limit(limit * 3)
    .toArray();

  const seen = new Set<TitleKey>();
  const out: Array<{ movie: Movie; session: Session; ratio: number }> = [];

  for (const session of sessions) {
    const key = session.titleKey!;
    if (seen.has(key)) continue;

    const ratio = coverageRatio(session.coverage);
    // Ignore trailers and instant bail-outs.
    if (ratio < 0.05) continue;

    const movie = await db.movies.get(key);
    if (!movie || movie.watched === 1) continue;

    seen.add(key);
    out.push({ movie, session, ratio });
    if (out.length >= limit) break;
  }

  return out;
}
