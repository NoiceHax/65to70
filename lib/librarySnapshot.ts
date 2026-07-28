import { db } from './db';
import { normalizeTitle } from './match';
import { providersForMany } from './providers';
import type { LibraryEntry } from './messages';

/**
 * A compact view of the library for the search overlay.
 *
 * Built in the background because content scripts can't reach the extension's
 * database, and pre-normalised so the overlay does no string work per result.
 *
 * Short titles are excluded: matching "Up" or "It" against arbitrary search
 * result text produces constant false positives, and one wrong badge costs more
 * trust than a missing one gains.
 */

const MIN_TITLE_LENGTH = 4;

let cache: { entries: LibraryEntry[]; builtAt: number } | null = null;
const CACHE_MS = 30_000;

export async function librarySnapshot(): Promise<LibraryEntry[]> {
  if (cache && Date.now() - cache.builtAt < CACHE_MS) return cache.entries;

  const movies = await db.movies.toArray();
  const relevant = movies.filter(
    (movie) =>
      movie.watched === 1 ||
      movie.rating !== null ||
      movie.liked === 1 ||
      movie.sources.some((s) => s.kind !== 'detected'),
  );

  const providers = await providersForMany(relevant.map((m) => m.tmdbId));

  const entries: LibraryEntry[] = [];
  for (const movie of relevant) {
    const normalized = normalizeTitle(movie.title);
    if (normalized.length < MIN_TITLE_LENGTH) continue;

    entries.push({
      n: normalized,
      title: movie.title,
      year: movie.year,
      rating: movie.rating,
      liked: movie.liked === 1,
      watched: movie.watched === 1,
      at: movie.lastConfirmed
        ? new Date(movie.lastConfirmed).toISOString().slice(0, 10)
        : undefined,
      on: providers.get(movie.tmdbId),
    });
  }

  // Longest first, so "Blade Runner 2049" wins over "Blade Runner" when both
  // are in the library and both appear in the same heading.
  entries.sort((a, b) => b.n.length - a.n.length);

  cache = { entries, builtAt: Date.now() };
  return entries;
}

export function invalidateLibrarySnapshot(): void {
  cache = null;
}
