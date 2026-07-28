import type { MediaType } from './types';

/**
 * Minimal TMDB v3 client.
 *
 * Only the endpoints the extension actually needs. Every call takes an explicit
 * api key rather than reading settings itself, so callers have to decide
 * consciously that a network request is allowed.
 */

const BASE = 'https://api.themoviedb.org/3';

export interface TmdbTitle {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string;
  year?: number;
  runtime?: number;
  poster?: string;
  imdbId?: string;
}

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

interface RequestOptions {
  apiKey: string;
  language?: string;
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  params: Record<string, string | undefined>,
  options: RequestOptions,
): Promise<T | null> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', options.apiKey);
  if (options.language) url.searchParams.set('language', options.language);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, { signal: options.signal });

  // 404 is a normal answer to "does this id exist?", not a failure.
  if (response.status === 404) return null;
  if (response.status === 401) {
    throw new TmdbError('TMDB rejected the API key', 401);
  }
  if (response.status === 429) {
    throw new TmdbError('TMDB rate limit reached', 429);
  }
  if (!response.ok) {
    throw new TmdbError(`TMDB request failed (${response.status})`, response.status);
  }

  return (await response.json()) as T;
}

function yearOf(date: unknown): number | undefined {
  if (typeof date !== 'string' || date.length < 4) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

interface MovieDetail {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  runtime?: number;
  poster_path?: string | null;
  imdb_id?: string | null;
}

interface TvDetail {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  poster_path?: string | null;
}

function fromMovie(detail: MovieDetail): TmdbTitle {
  return {
    tmdbId: detail.id,
    mediaType: 'movie',
    title: detail.title,
    originalTitle: detail.original_title,
    year: yearOf(detail.release_date),
    runtime: detail.runtime,
    poster: detail.poster_path ?? undefined,
    imdbId: detail.imdb_id ?? undefined,
  };
}

function fromTv(detail: TvDetail): TmdbTitle {
  return {
    tmdbId: detail.id,
    mediaType: 'tv',
    title: detail.name,
    originalTitle: detail.original_name,
    year: yearOf(detail.first_air_date),
    runtime: detail.episode_run_time?.[0],
    poster: detail.poster_path ?? undefined,
  };
}

/** Fetch a title by id. Returns null when the id doesn't exist for that type. */
export async function getById(
  tmdbId: number,
  mediaType: MediaType,
  options: RequestOptions,
): Promise<TmdbTitle | null> {
  if (mediaType === 'movie') {
    const detail = await request<MovieDetail>(`/movie/${tmdbId}`, {}, options);
    return detail ? fromMovie(detail) : null;
  }
  const detail = await request<TvDetail>(`/tv/${tmdbId}`, {}, options);
  return detail ? fromTv(detail) : null;
}

/**
 * Confirm a bare numeric id lifted from a URL.
 *
 * The id could belong to either collection, and a site-internal id belongs to
 * neither. Trying movie first and falling back to tv is what turns a `probable`
 * candidate into a verified match - or discards it.
 */
export async function verifyId(
  tmdbId: number,
  hint: MediaType | undefined,
  options: RequestOptions,
): Promise<TmdbTitle | null> {
  // With a hint there is nothing to guess: check only what was asked for.
  if (hint) return getById(tmdbId, hint, options);

  const found = await findAllById(tmdbId, options);
  return found.length === 1 ? found[0] : null;
}

/**
 * Everything that exists under this id, in either collection.
 *
 * Films and series occupy separate id spaces, so the same number is very often
 * a valid entry in both and they are entirely unrelated. Checking one first and
 * taking the answer looks decisive and is arbitrary - it identified a 2015 film
 * as the series someone was actually watching, purely because films were tried
 * first.
 *
 * So both are checked and the caller decides. One hit settles it. Two mean the
 * id alone cannot say which, and something else has to.
 */
export async function findAllById(
  tmdbId: number,
  options: RequestOptions,
): Promise<TmdbTitle[]> {
  const [movie, tv] = await Promise.all([
    getById(tmdbId, 'movie', options),
    getById(tmdbId, 'tv', options),
  ]);

  return [movie, tv].filter((found): found is TmdbTitle => found !== null);
}

interface FindResponse {
  movie_results: MovieDetail[];
  tv_results: TvDetail[];
}

/** Resolve an IMDb id. These are self-identifying, so a hit is unambiguous. */
export async function findByImdbId(
  imdbId: string,
  options: RequestOptions,
): Promise<TmdbTitle | null> {
  const found = await request<FindResponse>(
    `/find/${imdbId}`,
    { external_source: 'imdb_id' },
    options,
  );
  if (!found) return null;

  if (found.movie_results?.length) return fromMovie(found.movie_results[0]);
  if (found.tv_results?.length) return fromTv(found.tv_results[0]);
  return null;
}

interface SearchResponse<T> {
  results: T[];
}

/**
 * Search by title.
 *
 * TMDB matches against localised and alternative titles as well as the
 * original, which matters more than it first appears: sites serve titles in the
 * viewer's language, so a regional title is a normal input here, not an edge
 * case.
 */
export async function search(
  query: string,
  mediaType: MediaType,
  year: number | undefined,
  options: RequestOptions,
): Promise<TmdbTitle[]> {
  if (mediaType === 'movie') {
    const found = await request<SearchResponse<MovieDetail>>(
      '/search/movie',
      { query, year: year?.toString(), include_adult: 'false' },
      options,
    );
    return (found?.results ?? []).slice(0, 10).map(fromMovie);
  }

  const found = await request<SearchResponse<TvDetail>>(
    '/search/tv',
    { query, first_air_date_year: year?.toString(), include_adult: 'false' },
    options,
  );
  return (found?.results ?? []).slice(0, 10).map(fromTv);
}
