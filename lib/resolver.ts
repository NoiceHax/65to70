import { db } from './db';
import { getSettings } from './settings';
import { findByImdbId, search, verifyId, TmdbError, type TmdbTitle } from './tmdb';
import { isDecisive, rankMatches, type ScoredCandidate } from './match';
import { titleKey, type MediaType, type Movie, type PendingDetection, type Source } from './types';

/**
 * Turning a detection into a canonical title.
 *
 * Order matters and is not negotiable:
 *
 *   1. Already-known titles, from the local database.
 *   2. Catalogue ids lifted from the URL — exact, no guessing involved.
 *   3. Title search, and only if the user opted into network resolution.
 *
 * Anything that survives with a decisive score is attached to the pending
 * detection as a resolved match. Anything ambiguous keeps its candidates and
 * waits for the user. Nothing here ever marks a title watched on its own.
 */

export interface ResolveOutcome {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'offline';
  movie?: Movie;
  candidates: ScoredCandidate[];
  /** Set when resolution failed for a reason worth showing the user. */
  message?: string;
}

function toMovie(found: TmdbTitle, source: Source): Movie {
  return {
    key: titleKey(found.mediaType, found.tmdbId),
    tmdbId: found.tmdbId,
    imdbId: found.imdbId,
    mediaType: found.mediaType,
    title: found.title,
    originalTitle: found.originalTitle,
    year: found.year,
    runtime: found.runtime,
    poster: found.poster,
    watched: 0,
    liked: 0,
    rating: null,
    rewatch: 0,
    sources: [source],
    addedFrom: source.platform,
    tags: [],
    lastDetected: Date.now(),
  };
}

/**
 * Insert or merge a title.
 *
 * Merging rather than overwriting protects everything the user has invested in
 * a record — ratings, notes, collection membership — when a title is detected
 * again months later. Provenance accumulates rather than being replaced.
 */
export async function upsertMovie(found: TmdbTitle, source: Source): Promise<Movie> {
  const key = titleKey(found.mediaType, found.tmdbId);
  const existing = await db.movies.get(key);

  if (!existing) {
    const movie = toMovie(found, source);
    await db.movies.put(movie);
    return movie;
  }

  const alreadyKnown = existing.sources.some(
    (s) => s.kind === source.kind && s.platform === source.platform,
  );

  const merged: Movie = {
    ...existing,
    // Refresh catalogue metadata, which can improve over time.
    title: found.title || existing.title,
    originalTitle: found.originalTitle ?? existing.originalTitle,
    year: found.year ?? existing.year,
    runtime: found.runtime ?? existing.runtime,
    poster: found.poster ?? existing.poster,
    imdbId: found.imdbId ?? existing.imdbId,
    sources: alreadyKnown ? existing.sources : [...existing.sources, source],
    lastDetected: Date.now(),
  };

  await db.movies.put(merged);
  return merged;
}

async function resolveByUrlIds(
  pending: PendingDetection,
  apiKey: string,
  language: string,
): Promise<TmdbTitle | null> {
  for (const id of pending.urlIds ?? []) {
    const options = { apiKey, language };

    if (id.source === 'imdb') {
      const found = await findByImdbId(id.id, options);
      if (found) return found;
      continue;
    }

    const numeric = Number(id.id);
    if (!Number.isFinite(numeric)) continue;

    // A bare path number could be a site-internal id, so it only counts if
    // TMDB actually has it. A miss costs one request and falls through to
    // title matching.
    const found = await verifyId(numeric, id.mediaType, options);
    if (found) return found;
  }

  return null;
}

/**
 * Resolve one pending detection.
 *
 * Writes candidates back onto the pending row either way, so the confirm queue
 * can show its working rather than presenting a bare guess.
 */
export async function resolvePending(pendingId: number): Promise<ResolveOutcome> {
  const pending = await db.pending.get(pendingId);
  if (!pending) return { status: 'unresolved', candidates: [] };

  const settings = await getSettings();
  const source: Source = {
    kind: 'detected',
    platform: pending.hostname,
    at: new Date(pending.detectedAt).toISOString().slice(0, 10),
  };

  const mediaType: MediaType = pending.season !== undefined ? 'tv' : 'movie';
  const session = await db.sessions.get(pending.sessionId);
  const runtimeMinutes = session?.durationSec
    ? Math.round(session.durationSec / 60)
    : undefined;

  if (!settings.tmdbApiKey) {
    return {
      status: 'offline',
      candidates: [],
      message: 'Add a TMDB API key in options to identify titles.',
    };
  }

  try {
    // 1. Ids from the URL settle it outright when they verify.
    const byId = await resolveByUrlIds(pending, settings.tmdbApiKey, settings.language);
    if (byId) {
      const movie = await upsertMovie(byId, source);
      await db.pending.update(pendingId, {
        candidates: [
          {
            tmdbId: byId.tmdbId,
            mediaType: byId.mediaType,
            title: byId.title,
            year: byId.year,
            score: 1,
          },
        ],
      });
      return { status: 'resolved', movie, candidates: [{ candidate: byId, score: 1 }] };
    }

    // 2. Title search, only with explicit consent.
    if (!pending.cleanedTitle) {
      return { status: 'unresolved', candidates: [], message: 'No title could be read.' };
    }
    if (!settings.allowNetworkResolve) {
      return {
        status: 'offline',
        candidates: [],
        message: 'Title lookup is off. Enable it in options, or pick the title yourself.',
      };
    }

    const results = await search(
      pending.cleanedTitle,
      mediaType,
      pending.year,
      { apiKey: settings.tmdbApiKey, language: settings.language },
    );

    const ranked = rankMatches(
      { title: pending.cleanedTitle, year: pending.year, runtimeMinutes },
      results,
    );

    await db.pending.update(pendingId, {
      candidates: ranked.slice(0, 5).map(({ candidate, score }) => ({
        tmdbId: candidate.tmdbId,
        mediaType: candidate.mediaType,
        title: candidate.title,
        year: candidate.year,
        score,
      })),
    });

    if (isDecisive(ranked)) {
      const movie = await upsertMovie(ranked[0].candidate, source);
      return { status: 'resolved', movie, candidates: ranked };
    }

    return {
      status: ranked.length > 0 ? 'ambiguous' : 'unresolved',
      candidates: ranked,
    };
  } catch (error) {
    const message =
      error instanceof TmdbError ? error.message : 'Could not reach TMDB.';
    return { status: 'unresolved', candidates: [], message };
  }
}

/**
 * Attach a resolved title to its session and clear the pending row.
 *
 * This is the only path by which anything becomes "watched", and it is only
 * ever called from a user action in the confirm queue.
 */
export async function confirmPending(
  pendingId: number,
  found: TmdbTitle,
): Promise<Movie | null> {
  const pending = await db.pending.get(pendingId);
  if (!pending) return null;

  const movie = await upsertMovie(found, {
    kind: 'detected',
    platform: pending.hostname,
    at: new Date(pending.detectedAt).toISOString().slice(0, 10),
  });

  await db.sessions.update(pending.sessionId, {
    titleKey: movie.key,
    mediaType: found.mediaType,
    season: pending.season,
    episode: pending.episode,
  });

  await db.movies.update(movie.key, { lastConfirmed: Date.now() });
  await db.pending.delete(pendingId);

  const { recomputeWatchState } = await import('./db');
  await recomputeWatchState(movie.key);

  return movie;
}

/**
 * Free-text search, for when every candidate is wrong.
 *
 * The escape hatch that makes the confirm queue honest: an automatic matcher
 * will always have cases it can't reach, and the answer to those is to let the
 * user say what it was — not to guess harder.
 */
export async function searchManually(
  query: string,
  mediaType: MediaType,
): Promise<TmdbTitle[]> {
  const settings = await getSettings();
  if (!settings.tmdbApiKey || query.trim().length === 0) return [];

  return search(query.trim(), mediaType, undefined, {
    apiKey: settings.tmdbApiKey,
    language: settings.language,
  });
}

export interface ConfirmOptions {
  liked?: boolean;
  /** 0.5–5.0 in half steps, or null to leave unrated — which is the norm. */
  rating?: number | null;
}

/**
 * Confirm a detection against one of its candidates.
 *
 * Fetches full details first because the search results the queue displays are
 * summaries — runtime and IMDb id come from the detail endpoint, and both are
 * needed later for availability and for the Letterboxd export.
 */
export async function confirmCandidate(
  pendingId: number,
  tmdbId: number,
  mediaType: MediaType,
  options: ConfirmOptions = {},
): Promise<Movie | null> {
  const settings = await getSettings();
  if (!settings.tmdbApiKey) return null;

  const { getById } = await import('./tmdb');
  const found = await getById(tmdbId, mediaType, {
    apiKey: settings.tmdbApiKey,
    language: settings.language,
  });
  if (!found) return null;

  const movie = await confirmPending(pendingId, found);
  if (!movie) return null;

  // Only written when the user actually expressed something. An unrated film
  // is a normal outcome, not a gap to fill in.
  const patch: Partial<Movie> = {};
  if (options.liked !== undefined) patch.liked = options.liked ? 1 : 0;
  if (options.rating !== undefined) patch.rating = options.rating;
  if (Object.keys(patch).length > 0) await db.movies.update(movie.key, patch);

  return (await db.movies.get(movie.key)) ?? movie;
}

/** Drop a detection without recording anything — "this wasn't me". */
export async function dismissPending(pendingId: number): Promise<void> {
  const pending = await db.pending.get(pendingId);
  if (!pending) return;

  await db.sessions.delete(pending.sessionId);
  await db.pending.delete(pendingId);
}
