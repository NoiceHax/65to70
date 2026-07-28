import type { MediaType } from './types';

/**
 * Pulling catalogue ids straight out of the URL.
 *
 * This tier didn't exist in the original design and it should have. A large
 * share of streaming sites - cineby, vidsrc, 2embed and the rest - key their
 * pages on TMDB or IMDb ids rather than slugs, because they pull their
 * artwork and metadata from those same APIs:
 *
 *   https://cineby.cc/watch/1368337
 *   https://vidsrc.to/embed/movie/tt1375666
 *   https://example.com/tv/1399/1/1
 *
 * When that's true the canonical id is sitting in plain sight, which beats
 * every text-based method: no cleaning, no fuzzy matching, no ambiguity between
 * remakes. It also rescues client-rendered sites whose markup carries no usable
 * title at all - which is exactly where Tier 2 was failing.
 *
 * Numeric ids are reported as `probable` rather than `exact`, because a bare
 * number in a path could equally be a site-internal id. The resolver verifies
 * them against TMDB and falls back to the text candidates if they don't check
 * out, so a wrong guess costs nothing.
 */

export interface UrlIdCandidate {
  source: 'imdb' | 'tmdb';
  id: string;
  mediaType?: MediaType;
  season?: number;
  episode?: number;
  /** `exact` - an unambiguous marker. `probable` - a bare id needing verification. */
  confidence: 'exact' | 'probable';
}

/** IMDb ids are self-identifying, so they can be trusted wherever they appear. */
const IMDB_ID = /\b(tt\d{7,9})\b/;

/** Query params that name their scheme outright. */
const TMDB_PARAMS = ['tmdb', 'tmdbid', 'tmdb_id', 'themoviedb'];

const MOVIE_SEGMENTS = new Set(['movie', 'movies', 'film', 'films']);
const TV_SEGMENTS = new Set(['tv', 'series', 'show', 'shows', 'anime']);
/** Segments that precede an id without saying what kind of thing it is. */
const NEUTRAL_SEGMENTS = new Set(['watch', 'embed', 'player', 'video', 'play', 'title']);

/** TMDB ids are well past 1,000,000; anything longer than 8 digits isn't one. */
function isPlausibleId(value: string): boolean {
  return /^\d{1,8}$/.test(value) && Number(value) > 0;
}

function isPlausibleSeasonEpisode(value: string): boolean {
  return /^\d{1,3}$/.test(value);
}

/**
 * Season and episode numbers written into a URL.
 *
 * Services spell this out in the path - `/season-1/episode-3/`, `/s01e03/`,
 * `?season=1&episode=3` - even when the page itself only shows the series name.
 * Without reading it, every episode of a show resolves to the same thing and
 * the episode count never moves off one.
 */
export function seasonEpisodeFromUrl(
  url: string,
): { season: number; episode: number } | null {
  const patterns = [
    /season[-_/](\d{1,2})[-_/]+episode[-_/](\d{1,3})/i,
    /[/-]s(\d{1,2})[/-]?e(\d{1,3})\b/i,
    /\bs(\d{1,2})e(\d{1,3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (!match) continue;

    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (season >= 1 && season <= 50 && episode >= 1 && episode <= 999) {
      return { season, episode };
    }
  }

  try {
    const params = new URL(url).searchParams;

    // Both the spelled-out names and the short pair. `s` and `e` alone are far
    // too generic to read, so they only count when they appear together, which
    // is unambiguous in practice.
    const season = Number(params.get('season') ?? params.get('s'));
    const episode = Number(params.get('episode') ?? params.get('e'));

    if (season >= 1 && season <= 50 && episode >= 1) return { season, episode };
  } catch {
    // Not a URL we can parse; the patterns above already had their chance.
  }

  return null;
}

export function extractUrlIds(url: string): UrlIdCandidate[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const out: UrlIdCandidate[] = [];

  // 1. IMDb ids anywhere in the URL, path or query.
  const imdb = url.match(IMDB_ID);
  if (imdb) {
    out.push({ source: 'imdb', id: imdb[1], confidence: 'exact' });
  }

  // 2. Query parameters that name TMDB explicitly.
  for (const [key, value] of parsed.searchParams) {
    if (!TMDB_PARAMS.includes(key.toLowerCase())) continue;
    if (!isPlausibleId(value)) continue;

    const season = parsed.searchParams.get('season') ?? parsed.searchParams.get('s');
    const episode = parsed.searchParams.get('episode') ?? parsed.searchParams.get('e');

    out.push({
      source: 'tmdb',
      id: value,
      mediaType: season ? 'tv' : undefined,
      season: season && isPlausibleSeasonEpisode(season) ? Number(season) : undefined,
      episode: episode && isPlausibleSeasonEpisode(episode) ? Number(episode) : undefined,
      confidence: 'exact',
    });
  }

  // 3. Ids embedded in the path, optionally followed by season and episode.
  const segments = parsed.pathname.split('/').filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    const marker = segments[i].toLowerCase();

    const isMovie = MOVIE_SEGMENTS.has(marker);
    const isTv = TV_SEGMENTS.has(marker);
    const isNeutral = NEUTRAL_SEGMENTS.has(marker);
    if (!isMovie && !isTv && !isNeutral) continue;

    const idSegment = segments[i + 1];
    if (!idSegment || !isPlausibleId(idSegment)) continue;

    const seasonSegment = segments[i + 2];
    const episodeSegment = segments[i + 3];
    const hasEpisode =
      seasonSegment !== undefined &&
      episodeSegment !== undefined &&
      isPlausibleSeasonEpisode(seasonSegment) &&
      isPlausibleSeasonEpisode(episodeSegment);

    let mediaType: MediaType | undefined;
    if (isTv || hasEpisode) mediaType = 'tv';
    else if (isMovie) mediaType = 'movie';

    out.push({
      source: 'tmdb',
      id: idSegment,
      mediaType,
      season: hasEpisode ? Number(seasonSegment) : undefined,
      episode: hasEpisode ? Number(episodeSegment) : undefined,
      // A labelled segment is a stronger signal than a bare /watch/<id>, but
      // neither is self-identifying the way an IMDb id is.
      confidence: 'probable',
    });
  }

  // Keep the most informative entry per id.
  const best = new Map<string, UrlIdCandidate>();
  for (const candidate of out) {
    const key = `${candidate.source}:${candidate.id}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, candidate);
      continue;
    }
    const better =
      (candidate.confidence === 'exact' && existing.confidence !== 'exact') ||
      (candidate.mediaType !== undefined && existing.mediaType === undefined) ||
      (candidate.season !== undefined && existing.season === undefined);
    if (better) best.set(key, candidate);
  }

  // Fill in episode numbers written elsewhere in the URL. A path like
  // /watch/1399?season=2&episode=5 gives the id in one place and the episode
  // in another, and taking only the first identifies the show but never the
  // episode.
  const spelledOut = seasonEpisodeFromUrl(url);
  if (spelledOut) {
    for (const candidate of best.values()) {
      if (candidate.season !== undefined) continue;
      candidate.season = spelledOut.season;
      candidate.episode = spelledOut.episode;
      candidate.mediaType = 'tv';
    }
  }

  return [...best.values()];
}
