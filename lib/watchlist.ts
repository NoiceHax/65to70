import { db } from './db';
import { upsertMovie } from './resolver';
import type { TmdbTitle } from './tmdb';
import type { Movie, Source, TitleKey } from './types';

/**
 * The universal watchlist.
 *
 * Everything collapses to one row per canonical id — which is also the
 * duplicate detector, for free: regional title variants and differently-spelled
 * listings resolve to the same TMDB id and merge automatically.
 *
 * What does *not* collapse is provenance. A merged list that forgets where each
 * entry came from can't sync back, can't resolve conflicts, and can't answer
 * "why is this here?". So `sources` accumulates instead of being replaced, and
 * a title saved on two services shows both.
 */

const WATCHLIST_KINDS = new Set<Source['kind']>(['watchlist', 'added', 'imported']);

export function isOnWatchlist(movie: Movie): boolean {
  return movie.sources.some((source) => WATCHLIST_KINDS.has(source.kind));
}

export async function addToWatchlist(found: TmdbTitle, source: Source): Promise<Movie> {
  return upsertMovie(found, source);
}

/**
 * Remove a title from the watchlist.
 *
 * Drops watchlist provenance but keeps the record itself, because it may carry
 * a rating, notes or collection membership that the user built up and that
 * removing it from a list should not destroy.
 */
export async function removeFromWatchlist(key: TitleKey): Promise<void> {
  const movie = await db.movies.get(key);
  if (!movie) return;

  const remaining = movie.sources.filter((source) => !WATCHLIST_KINDS.has(source.kind));

  // Nothing left to justify the row and nothing invested in it — drop it.
  const worthKeeping =
    remaining.length > 0 ||
    movie.watched === 1 ||
    movie.liked === 1 ||
    movie.rating !== null ||
    (movie.notes?.length ?? 0) > 0;

  if (worthKeeping) await db.movies.update(key, { sources: remaining });
  else await db.movies.delete(key);
}

export interface WatchlistEntry {
  movie: Movie;
  /** Distinct platforms this title was saved on, in the order first seen. */
  savedOn: string[];
  addedAt?: string;
}

/** Unwatched titles the user has saved anywhere. */
export async function watchlist(): Promise<WatchlistEntry[]> {
  const all = await db.movies.toArray();

  return all
    .filter((movie) => movie.watched === 0 && isOnWatchlist(movie))
    .map((movie) => {
      const relevant = movie.sources.filter((s) => WATCHLIST_KINDS.has(s.kind));
      const savedOn: string[] = [];
      for (const source of relevant) {
        if (!savedOn.includes(source.platform)) savedOn.push(source.platform);
      }
      const addedAt = relevant
        .map((s) => s.at)
        .sort()
        .at(0);

      return { movie, savedOn, addedAt };
    })
    .sort((a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? ''));
}

/**
 * Titles saved more than once under different provenance.
 *
 * Not a feature so much as a by-product of canonical ids — worth surfacing
 * because it's the visible proof the merge worked.
 */
export async function duplicatesAcrossPlatforms(): Promise<WatchlistEntry[]> {
  return (await watchlist()).filter((entry) => entry.savedOn.length > 1);
}
