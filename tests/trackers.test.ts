import { describe, expect, it } from 'vitest';
import { toPayload, type HistoryItem } from '@/lib/sync/trackers';

/**
 * `toPayload` is the one piece of the Simkl/Trakt path that is pure: it takes
 * the flat confirmed history and regroups it into the movies/shows shape both
 * services expect. Everything around it is network, so this is what's worth
 * pinning down.
 */

function item(partial: Partial<HistoryItem> = {}): HistoryItem {
  return {
    title: 'Inception',
    year: 2010,
    tmdbId: 27205,
    imdbId: 'tt1375666',
    mediaType: 'movie',
    watchedAt: '2025-01-02T12:00:00.000Z',
    ...partial,
  };
}

function episode(partial: Partial<HistoryItem> = {}): HistoryItem {
  return item({
    title: 'Severance',
    year: 2022,
    tmdbId: 95396,
    imdbId: 'tt11280740',
    mediaType: 'tv',
    season: 1,
    episode: 1,
    ...partial,
  });
}

describe('toPayload', () => {
  it('carries a film through with both ids and its watch date', () => {
    const { movies, shows } = toPayload([item()]);

    expect(shows).toHaveLength(0);
    expect(movies).toEqual([
      {
        title: 'Inception',
        year: 2010,
        ids: { tmdb: 27205, imdb: 'tt1375666' },
        watched_at: '2025-01-02T12:00:00.000Z',
      },
    ]);
  });

  it('omits the imdb id when the film has none', () => {
    const [movie] = toPayload([item({ imdbId: undefined })]).movies;
    expect(movie.ids).toEqual({ tmdb: 27205 });
  });

  it('separates films from episodes', () => {
    const { movies, shows } = toPayload([item(), episode()]);
    expect(movies).toHaveLength(1);
    expect(shows).toHaveLength(1);
  });

  it('groups every episode of a show under one entry', () => {
    // Two episodes of the same series must not become two shows - that logs
    // the series twice on the service's side.
    const { shows } = toPayload([
      episode({ season: 1, episode: 1 }),
      episode({ season: 1, episode: 2 }),
    ]);

    expect(shows).toHaveLength(1);
    expect(shows[0].ids).toEqual({ tmdb: 95396, imdb: 'tt11280740' });
    expect(shows[0].seasons).toHaveLength(1);
    expect(shows[0].seasons[0].episodes.map((e) => e.number)).toEqual([1, 2]);
  });

  it('splits a show into its seasons', () => {
    const { shows } = toPayload([
      episode({ season: 1, episode: 1 }),
      episode({ season: 2, episode: 1 }),
    ]);

    expect(shows[0].seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(shows[0].seasons).toHaveLength(2);
  });

  it('keeps each episode dated when it was actually seen', () => {
    const { shows } = toPayload([
      episode({ season: 1, episode: 1, watchedAt: '2025-01-02T12:00:00.000Z' }),
      episode({ season: 1, episode: 2, watchedAt: '2025-03-04T12:00:00.000Z' }),
    ]);

    const [ep1, ep2] = shows[0].seasons[0].episodes;
    expect(ep1.watched_at).toBe('2025-01-02T12:00:00.000Z');
    expect(ep2.watched_at).toBe('2025-03-04T12:00:00.000Z');
  });

  it('keeps two different shows apart', () => {
    const { shows } = toPayload([
      episode({ tmdbId: 95396, title: 'Severance' }),
      episode({ tmdbId: 1396, title: 'Breaking Bad', imdbId: 'tt0903747' }),
    ]);

    expect(shows).toHaveLength(2);
    expect(shows.map((s) => s.title).sort()).toEqual(['Breaking Bad', 'Severance']);
  });

  it('drops a tv entry with no episode number', () => {
    // A whole-show entry carries nothing the service can log, so it is left
    // out rather than sent as an empty show.
    const { shows } = toPayload([episode({ season: undefined, episode: undefined })]);
    expect(shows).toHaveLength(0);
  });

  it('returns empty payloads for empty input', () => {
    expect(toPayload([])).toEqual({ movies: [], shows: [] });
  });
});
