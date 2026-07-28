import { db } from './db';
import { loadSimilarIndex } from './similar';
import { upsertMovie } from './resolver';
import { providersForMany } from './providers';
import { isOnWatchlist } from './watchlist';
import { titleKey, type Movie } from './types';

/**
 * Recommendations, computed entirely on-device.
 *
 * Every title you have finished, liked or rated votes for the films related to
 * it, and the films collecting the most votes surface. The relationships come
 * from a prepared index built offline; your library is only ever read locally.
 *
 * Two rules carried over from the queue optimiser, for the same reasons:
 *
 *  - Reasons are facts. "Because you watched Inception and Interstellar" is
 *    checkable. A match percentage is unfalsifiable when it's right and looks
 *    ridiculous when it's wrong, and tells you nothing you can act on either
 *    way.
 *  - A low rating is a signal too. Films you disliked vote *against* things
 *    like them, which is the part recommenders usually throw away.
 */

export interface Recommendation {
  tmdbId: number;
  title: string;
  year?: number;
  /** Titles from your library that led here, strongest first. */
  because: string[];
  availableOn: string[];
}

export interface RecommendOptions {
  limit?: number;
  /** Only suggest things currently streaming somewhere in your region. */
  availableOnly?: boolean;
}

/** How strongly one library title speaks for what it resembles. */
function weightOf(movie: Movie): number {
  if (movie.rating !== null) {
    // 3 is the pivot: above it endorses, below it warns off.
    if (movie.rating >= 4.5) return 2.5;
    if (movie.rating >= 3.5) return 1.8;
    if (movie.rating >= 3) return 1;
    if (movie.rating >= 2) return -1;
    return -2;
  }

  if (movie.liked === 1) return 2;
  if (movie.watched === 1) return 1;
  return 0.4; // On the watchlist: interest, but unproven.
}

/** Earlier entries in a relationship list are stronger matches. */
function positionWeight(index: number, total: number): number {
  return 1 - (index / Math.max(1, total)) * 0.5;
}

export async function recommend(
  options: RecommendOptions = {},
): Promise<Recommendation[]> {
  const { limit = 12, availableOnly = false } = options;

  const index = await loadSimilarIndex();
  if (!index) return [];

  const library = await db.movies.toArray();
  const sources = library.filter((movie) => weightOf(movie) !== 0);
  if (sources.length === 0) return [];

  // Never suggest something already watched, already saved, or disliked.
  const excluded = new Set<number>();
  for (const movie of library) {
    if (movie.watched === 1 || isOnWatchlist(movie) || (movie.rating ?? 5) < 2.5) {
      excluded.add(movie.tmdbId);
    }
  }

  const scores = new Map<number, number>();
  const credits = new Map<number, { title: string; weight: number }[]>();

  for (const source of sources) {
    const related = index.similar[String(source.tmdbId)];
    if (!related) continue;

    const weight = weightOf(source);

    related.forEach((candidateId, position) => {
      if (excluded.has(candidateId)) return;

      const contribution = weight * positionWeight(position, related.length);
      scores.set(candidateId, (scores.get(candidateId) ?? 0) + contribution);

      // Only positive influences are worth naming — "because you disliked X"
      // is not a reason anyone wants to read.
      if (weight > 0) {
        credits.set(candidateId, [
          ...(credits.get(candidateId) ?? []),
          { title: source.title, weight: contribution },
        ]);
      }
    });
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  const providers = await providersForMany(ranked.slice(0, limit * 4).map(([id]) => id));

  const out: Recommendation[] = [];

  for (const [tmdbId] of ranked) {
    if (out.length >= limit) break;

    const details = index.titles[String(tmdbId)];
    if (!details) continue;

    const availableOn = providers.get(tmdbId) ?? [];
    if (availableOnly && availableOn.length === 0) continue;

    const because = (credits.get(tmdbId) ?? [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map((credit) => credit.title);

    if (because.length === 0) continue;

    out.push({ tmdbId, title: details.t, year: details.y, because, availableOn });
  }

  return out;
}

/**
 * Why the list might be empty or thin.
 *
 * Recommendations need both a relationship index and something to recommend
 * from. Distinguishing the two matters — one is a setup step, the other just
 * needs more watching — and "no recommendations" alone says neither.
 */
export async function recommendationReadiness(): Promise<{
  hasIndex: boolean;
  usableTitles: number;
}> {
  const index = await loadSimilarIndex();
  const library = await db.movies.toArray();

  return {
    hasIndex: index !== null,
    usableTitles: library.filter((movie) => weightOf(movie) > 0).length,
  };
}

/** Save a recommendation to the watchlist. */
export async function saveRecommendation(rec: Recommendation): Promise<void> {
  await upsertMovie(
    { tmdbId: rec.tmdbId, mediaType: 'movie', title: rec.title, year: rec.year },
    { kind: 'added', platform: 'recommendation', at: new Date().toISOString().slice(0, 10) },
  );
}

/** Exported for tests. */
export const _internals = { weightOf, titleKey };
