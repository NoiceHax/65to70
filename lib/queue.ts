import { providersForMany } from './providers';
import { watchlist } from './watchlist';
import type { Movie } from './types';

/**
 * "What should I watch next?"
 *
 * Deliberately not a recommender. It orders titles the user already chose,
 * which sidesteps the cold-start problem entirely and - more importantly -
 * can't really be wrong: every candidate is something they put on the list
 * themselves.
 *
 * Every reason is a checkable fact about the title or the list. There are no
 * match percentages, because a number like "94% match" is unfalsifiable when
 * it's right and looks foolish when it's wrong, and it tells the user nothing
 * they can act on either way.
 *
 * Signals are limited to what Keeper actually knows. It does not model taste,
 * so it does not claim to.
 */

export interface QueueSuggestion {
  movie: Movie;
  /** Human-readable facts, in the order they contributed to the ranking. */
  reasons: string[];
  availableOn: string[];
  runtimeMinutes?: number;
}

export interface QueueOptions {
  /**
   * Minutes available. A real constraint people apply constantly, and a plain
   * numeric filter rather than a mood.
   */
  maxRuntimeMinutes?: number;
  limit?: number;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function monthsSince(iso?: string): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / MONTH_MS));
}

export async function suggestQueue(
  options: QueueOptions = {},
): Promise<QueueSuggestion[]> {
  const { maxRuntimeMinutes, limit = 10 } = options;

  const entries = await watchlist();
  if (entries.length === 0) return [];

  const providers = await providersForMany(entries.map((e) => e.movie.tmdbId));

  const scored = entries.map(({ movie, savedOn, addedAt }) => {
    const availableOn = providers.get(movie.tmdbId) ?? [];
    const reasons: string[] = [];
    let score = 0;
    // An explicit flag rather than a large negative score. A sentinel value can
    // be cancelled out by later bonuses - the age bonus did exactly that, and a
    // three-hour film came back inside a ninety-minute budget.
    let excluded = false;

    // Actionability first. A suggestion you can't act on is the exact problem
    // single-service recommenders have, and reproducing it here would be
    // self-defeating.
    if (availableOn.length > 0) {
      score += 40;
      reasons.push(`on ${availableOn.slice(0, 2).join(' and ')}`);
    }

    if (maxRuntimeMinutes !== undefined && movie.runtime) {
      if (movie.runtime <= maxRuntimeMinutes) {
        score += 25;
        reasons.push(`runs ${movie.runtime} minutes`);
      } else {
        excluded = true;
      }
    }

    const age = monthsSince(addedAt);
    if (age >= 6) {
      score += Math.min(20, age);
      reasons.push(`saved ${age >= 12 ? `${Math.floor(age / 12)} years` : `${age} months`} ago`);
    }

    // Saving the same title on two services is a stronger statement of intent
    // than saving it once.
    if (savedOn.length > 1) {
      score += 10;
      reasons.push(`saved on ${savedOn.length} services`);
    }

    if (reasons.length === 0) reasons.push('on your watchlist');

    return {
      suggestion: {
        movie,
        reasons,
        availableOn,
        runtimeMinutes: movie.runtime,
      },
      score,
      excluded,
    };
  });

  return scored
    .filter((entry) => !entry.excluded)
    .sort((a, b) => b.score - a.score || a.suggestion.movie.title.localeCompare(b.suggestion.movie.title))
    .slice(0, limit)
    .map((entry) => entry.suggestion);
}
