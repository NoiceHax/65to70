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
export async function recomputeWatchState(key: TitleKey): Promise<void> {
  const sessions = await db.sessions.where('titleKey').equals(key).toArray();
  if (sessions.length === 0) return;

  const watched = isComplete(unionCoverage(sessions.map((s) => s.coverage)));
  const completeSessions = sessions.filter((s) => s.complete === 1).length;

  await db.movies.update(key, {
    watched: watched ? 1 : 0,
    rewatch: Math.max(0, completeSessions - 1),
  });
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
