/**
 * Core data model.
 *
 * Two invariants worth stating up front, because most of the schema exists to
 * enforce them:
 *
 *  1. A watch is never a boolean. It is one or more `Session` rows, each
 *     carrying a coverage bitmap. `Movie.watched` is a denormalised cache of
 *     "has at least one complete session", never the source of truth.
 *
 *  2. `watched` / `liked` / `rating` / `rewatch` are independent. A film can be
 *     watched and liked with no stars attached, and that is a real state - not
 *     a missing rating.
 */

export type MediaType = 'movie' | 'tv';

/** Dexie cannot index booleans, so flags are stored as 0 | 1. */
export type Flag = 0 | 1;

/** `${mediaType}:${tmdbId}` - the canonical key everything joins on. */
export type TitleKey = string;

export function titleKey(mediaType: MediaType, tmdbId: number): TitleKey {
  return `${mediaType}:${tmdbId}`;
}

/**
 * Where a title came from. A merged watchlist that forgets provenance can't
 * sync back, can't resolve conflicts, and can't answer "why is this here?".
 */
export interface Source {
  kind: 'watchlist' | 'added' | 'imported' | 'detected';
  /** 'netflix' | 'prime' | 'hotstar' | 'letterboxd' | 'simkl' | 'trakt' | hostname */
  platform: string;
  /** ISO date, YYYY-MM-DD. */
  at: string;
}

export interface Movie {
  key: TitleKey;
  tmdbId: number;
  imdbId?: string;
  mediaType: MediaType;

  title: string;
  originalTitle?: string;
  year?: number;
  /** Minutes. */
  runtime?: number;
  poster?: string;

  // State - all independent, none implies another.
  /** Cache of "any complete session exists". Recomputed by recomputeWatchState. */
  watched: Flag;
  /** Liked without necessarily being rated. */
  liked: Flag;
  /** 0.5-5.0 in 0.5 steps, or null for "never rated" - which is the norm. */
  rating: number | null;
  /** Complete sessions beyond the first. */
  rewatch: number;

  /**
   * Progress set by hand, 0-1, overriding what was measured.
   *
   * Measurement is a best guess and sometimes a poor one: a stream padded with
   * adverts, a different cut, or a page that reloaded mid-film and fragmented
   * its sessions. The person watching knows better than the bitmap does, so
   * they get the final say.
   */
  manualProgress?: number;

  /**
   * Distinct episodes finished, for series only.
   *
   * A show is never "watched" the way a film is - it accumulates. Cached here
   * because the authoritative data is spread across sessions and a list view
   * shouldn't scan them per row.
   */
  episodesWatched?: number;

  sources: Source[];
  /** First source that introduced this title. */
  addedFrom?: string;

  notes?: string;
  tags: string[];

  lastDetected?: number;
  lastConfirmed?: number;
}

/** Number of buckets in a session coverage bitmap. One bucket = 1% of runtime. */
export const COVERAGE_BUCKETS = 100;

/** Fraction of buckets that must be covered before a session counts as complete. */
export const COMPLETION_THRESHOLD = 0.8;

/**
 * One playback session. Append-only.
 *
 * `coverage` is a COVERAGE_BUCKETS-length bitmap of which 1% slices were
 * actually played. Completion is measured against bucket coverage, never
 * against `currentTime` - otherwise seeking to the end marks a film watched.
 */
export interface Session {
  id?: number;
  /** Null until the detection is resolved and confirmed. */
  titleKey: TitleKey | null;
  mediaType: MediaType;
  season?: number;
  episode?: number;

  startedAt: number;
  lastSeenAt: number;
  stoppedAt?: number;

  coverage: Uint8Array;
  /** Media duration in seconds as reported by the player. Often 0 - see below. */
  durationSec?: number;
  /**
   * Runtime from the resolved catalogue entry, in seconds.
   *
   * The authority when the player won't say. Streaming players routinely report
   * `duration` as NaN with an empty `seekable` range, so the only dependable
   * runtime comes from the title we matched - which is also more accurate,
   * since it isn't inflated by adverts spliced into the stream.
   */
  runtimeSec?: number;

  /** Hostname the playback happened on. */
  site: string;
  complete: Flag;
}

export interface ResolverCandidate {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year?: number;
  /** 0-1. */
  score: number;
}

/**
 * A detection awaiting user confirmation. Nothing is ever written to a diary
 * or synced outward from here - it has to be confirmed first.
 */
export interface PendingDetection {
  id?: number;
  sessionId: number;

  rawTitle: string;
  cleanedTitle: string;
  year?: number;
  season?: number;
  episode?: number;

  hostname: string;
  candidates: ResolverCandidate[];
  /**
   * Catalogue ids lifted from the URL, carried through so the resolver can
   * verify them against TMDB. When one checks out it settles the match
   * outright, with no fuzzy title comparison involved.
   */
  urlIds?: Array<{
    source: 'imdb' | 'tmdb';
    id: string;
    mediaType?: MediaType;
    season?: number;
    episode?: number;
    confidence: 'exact' | 'probable';
  }>;
  detectedAt: number;
  status: 'awaiting' | 'dismissed';
}

export type DetectionStrategy =
  | 'jsonld'
  | 'og'
  | 'h1'
  | 'breadcrumb'
  | 'slug'
  | 'document-title'
  | 'manual';

/**
 * A learned rule for a site whose title we once had to ask about. Lets a site
 * self-heal after a single question instead of asking every time.
 */
export interface SiteRule {
  hostname: string;
  strategy: DetectionStrategy;
  /** CSS selector, when the strategy is DOM-based. */
  selector?: string;
  learnedAt: number;
  hits: number;
}

export interface Collection {
  id?: number;
  name: string;
  createdAt: number;
  order: number;
}

export interface CollectionItem {
  id?: number;
  collectionId: number;
  titleKey: TitleKey;
  order: number;
  addedAt: number;
}

export type SyncProvider = 'simkl' | 'trakt';

export interface SyncState {
  provider: SyncProvider;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  lastSyncAt?: number;
}

/** Small key/value bag for index versions, onboarding state, settings. */
export interface MetaEntry {
  key: string;
  value: unknown;
}

/**
 * What a content script reports upward. Deliberately dumb: content scripts
 * observe and report, the background worker decides what it means.
 */
export interface RawDetection {
  /** Present for Tier 2/3 (page metadata). */
  rawTitle?: string;
  /** Present for Tier 1 (platform adapters) - e.g. a Netflix video id. */
  platformId?: string;
  platform?: string;
  strategy: DetectionStrategy;

  hostname: string;
  url: string;

  currentTimeSec: number;
  durationSec: number;
}
