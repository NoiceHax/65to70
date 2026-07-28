import { db } from './db';
import { titleKey } from './types';
import { lookupLocal } from './titleIndex';
import { getSettings } from './settings';
import { getById, search, type TmdbTitle } from './tmdb';
import { isDecisive, rankMatches } from './match';
import { addToWatchlist, isOnWatchlist } from './watchlist';
import type { SearchQueryResponse } from './messages';

/**
 * Turning a search query into a watchlist offer.
 *
 * Searching for a film is a statement of interest, and the moment straight
 * after is the cheapest time to save it - far cheaper than remembering to add
 * it later, which is the step everyone skips.
 *
 * Held to a higher bar than watch detection. A wrong entry appearing in a
 * watchlist unprompted is more irritating than a missed one, and a search box
 * contains far more noise than a film page: navigation queries, half-typed
 * words, things that merely resemble a title. So only a decisive match offers
 * anything at all.
 */

/** Query strings that are obviously not a title. */
const NOT_A_TITLE = /^(https?:|www\.|\w+\.(com|net|org|io)\b)|^\s*$/i;

/**
 * Save a searched title to the watchlist.
 *
 * Goes straight there rather than through the confirm queue: the user picked
 * this one deliberately, so asking again would be asking twice. Details are
 * enriched from TMDB when a key is configured, but the save doesn't depend on
 * it - the title and year carried from the search are enough.
 */
export async function addFromSearch(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  title: string,
  year?: number,
): Promise<void> {
  const settings = await getSettings();
  let found: TmdbTitle = { tmdbId, mediaType, title, year };

  if (settings.tmdbApiKey) {
    try {
      const detailed = await getById(tmdbId, mediaType, {
        apiKey: settings.tmdbApiKey,
        language: settings.language,
      });
      if (detailed) found = detailed;
    } catch {
      // Network trouble shouldn't lose the save.
    }
  }

  await addToWatchlist(found, {
    kind: 'added',
    platform: 'search',
    at: new Date().toISOString().slice(0, 10),
  });
}

export async function offerFromSearch(query: string): Promise<SearchQueryResponse> {
  const trimmed = query.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return {};
  if (NOT_A_TITLE.test(trimmed)) return {};

  const settings = await getSettings();

  // Local index first, exactly as watch detection does - a search shouldn't be
  // the thing that starts sending queries to TMDB.
  let candidates = await lookupLocal(trimmed);

  if (candidates.length === 0 && settings.tmdbApiKey && settings.allowNetworkResolve) {
    candidates = await search(trimmed, 'movie', undefined, {
      apiKey: settings.tmdbApiKey,
      language: settings.language,
    });
  }

  if (candidates.length === 0) return {};

  const ranked = rankMatches({ title: trimmed }, candidates);
  if (!isDecisive(ranked)) return {};

  const best = ranked[0].candidate;
  const key = titleKey(best.mediaType, best.tmdbId);

  // Nothing to offer if it's already watched or already saved.
  const existing = await db.movies.get(key);
  if (existing && (existing.watched === 1 || isOnWatchlist(existing))) return {};

  return {
    match: {
      tmdbId: best.tmdbId,
      mediaType: best.mediaType,
      title: best.title,
      year: best.year,
    },
  };
}
