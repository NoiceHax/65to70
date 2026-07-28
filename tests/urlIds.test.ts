import { describe, expect, it } from 'vitest';
import { extractUrlIds, seasonEpisodeFromUrl } from '@/lib/urlIds';

describe('extractUrlIds - bare path ids', () => {
  it('reads the id from a neutral /watch/<id> path', () => {
    // The real failing case: a client-rendered site whose markup carries no
    // usable title, but whose URL is keyed on a TMDB id.
    expect(extractUrlIds('https://cineby.cc/watch/1368337')).toEqual([
      { source: 'tmdb', id: '1368337', mediaType: undefined, season: undefined, episode: undefined, confidence: 'probable' },
    ]);
  });

  it('labels a /movie/<id> path as a movie', () => {
    const [id] = extractUrlIds('https://example.com/movie/27205');
    expect(id).toMatchObject({ source: 'tmdb', id: '27205', mediaType: 'movie' });
  });

  it('reads season and episode from a /tv/<id>/<s>/<e> path', () => {
    const [id] = extractUrlIds('https://example.com/tv/1399/1/1');
    expect(id).toMatchObject({
      source: 'tmdb',
      id: '1399',
      mediaType: 'tv',
      season: 1,
      episode: 1,
    });
  });

  it('infers tv from a season/episode tail even on a neutral segment', () => {
    const [id] = extractUrlIds('https://cineby.cc/watch/1399/2/5');
    expect(id).toMatchObject({ id: '1399', mediaType: 'tv', season: 2, episode: 5 });
  });
});

describe('extractUrlIds - IMDb', () => {
  it('reads an IMDb id from the path and marks it exact', () => {
    const ids = extractUrlIds('https://vidsrc.to/embed/movie/tt1375666');
    expect(ids).toContainEqual(
      expect.objectContaining({ source: 'imdb', id: 'tt1375666', confidence: 'exact' }),
    );
  });

  it('reads an IMDb id from a query string', () => {
    const ids = extractUrlIds('https://example.com/embed?imdb=tt0903747&x=1');
    expect(ids).toContainEqual(expect.objectContaining({ source: 'imdb', id: 'tt0903747' }));
  });
});

describe('extractUrlIds - explicit query parameters', () => {
  it('trusts a named tmdb parameter', () => {
    const [id] = extractUrlIds('https://example.com/embed?tmdb=27205');
    expect(id).toMatchObject({ source: 'tmdb', id: '27205', confidence: 'exact' });
  });

  it('reads season and episode alongside it', () => {
    const [id] = extractUrlIds('https://example.com/embed?tmdb=1399&season=1&episode=2');
    expect(id).toMatchObject({ mediaType: 'tv', season: 1, episode: 2 });
  });
});

describe('seasonEpisodeFromUrl', () => {
  it('reads a spelled-out season and episode path', () => {
    // Hotstar's shape. Without this, every episode of a show resolved to the
    // same title and the episode count never moved off one.
    expect(
      seasonEpisodeFromUrl('https://www.hotstar.com/in/shows/himym/123/season-2/episode-7/watch'),
    ).toEqual({ season: 2, episode: 7 });
  });

  it('reads the compact s01e03 form', () => {
    expect(seasonEpisodeFromUrl('https://example.com/watch/show-s01e03')).toEqual({
      season: 1,
      episode: 3,
    });
  });

  it('reads query parameters', () => {
    expect(seasonEpisodeFromUrl('https://example.com/embed?season=4&episode=12')).toEqual({
      season: 4,
      episode: 12,
    });
  });

  it('returns null when there is nothing to read', () => {
    expect(seasonEpisodeFromUrl('https://example.com/movie/inception')).toBeNull();
  });

  it('rejects out-of-range numbers', () => {
    expect(seasonEpisodeFromUrl('https://example.com/season-99/episode-1')).toBeNull();
  });

  it('fills the episode onto an id found elsewhere in the URL', () => {
    const [id] = extractUrlIds('https://example.com/watch/1399?season=2&episode=5');
    expect(id).toMatchObject({ id: '1399', mediaType: 'tv', season: 2, episode: 5 });
  });
});

describe('extractUrlIds - rejections', () => {
  it('returns nothing for a slug-based URL', () => {
    expect(extractUrlIds('https://example.com/movie/inception-2010')).toEqual([]);
  });

  it('rejects numbers too long to be a catalogue id', () => {
    expect(extractUrlIds('https://example.com/watch/1234567890')).toEqual([]);
  });

  it('ignores numbers that follow an unrelated segment', () => {
    expect(extractUrlIds('https://example.com/user/12345')).toEqual([]);
  });

  it('survives a malformed URL', () => {
    expect(extractUrlIds('not a url')).toEqual([]);
  });

  it('keeps the most informative entry when an id appears twice', () => {
    const ids = extractUrlIds('https://example.com/tv/1399/1/1?tmdb=1399');
    const tmdb = ids.filter((i) => i.source === 'tmdb');
    expect(tmdb).toHaveLength(1);
    expect(tmdb[0]).toMatchObject({ season: 1, episode: 1 });
  });
});
