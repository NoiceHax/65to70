import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, emptyCoverage, recomputeWatchState, watchedEpisodes } from '@/lib/db';
import { titleKey, type MediaType, type Movie, type Session } from '@/lib/types';

const SHOW = titleKey('tv', 1399);
const FILM = titleKey('movie', 27205);

function record(mediaType: MediaType, tmdbId: number, title: string): Movie {
  return {
    key: titleKey(mediaType, tmdbId),
    tmdbId,
    mediaType,
    title,
    watched: 0,
    liked: 0,
    rating: null,
    rewatch: 0,
    sources: [],
    tags: [],
  };
}

/** A session covering buckets [from, to]. */
function session(
  key: string,
  from: number,
  to: number,
  episode?: { season: number; episode: number },
): Session {
  const coverage = emptyCoverage();
  for (let i = from; i <= to; i++) coverage[i] = 1;

  return {
    titleKey: key,
    mediaType: episode ? 'tv' : 'movie',
    season: episode?.season,
    episode: episode?.episode,
    startedAt: Date.now(),
    lastSeenAt: Date.now(),
    coverage,
    site: 'example.com',
    complete: to - from + 1 >= 80 ? 1 : 0,
  };
}

beforeEach(async () => {
  await db.movies.clear();
  await db.sessions.clear();
});

describe('series watch state', () => {
  it('does not mark a show watched from two half-seen episodes', async () => {
    // The bug this replaced: coverage was unioned across the whole series, so
    // opposite halves of two different episodes added up to "complete".
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.bulkAdd([
      session(SHOW, 0, 49, { season: 1, episode: 1 }),
      session(SHOW, 50, 99, { season: 1, episode: 2 }),
    ]);

    await recomputeWatchState(SHOW);

    const show = await db.movies.get(SHOW);
    expect(show?.watched).toBe(0);
    expect(show?.episodesWatched).toBe(0);
  });

  it('counts one finished episode', async () => {
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.add(session(SHOW, 0, 84, { season: 1, episode: 1 }));

    await recomputeWatchState(SHOW);

    const show = await db.movies.get(SHOW);
    expect(show?.watched).toBe(1);
    expect(show?.episodesWatched).toBe(1);
  });

  it('counts distinct episodes, not sessions', async () => {
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.bulkAdd([
      session(SHOW, 0, 84, { season: 1, episode: 1 }),
      session(SHOW, 0, 84, { season: 1, episode: 2 }),
      session(SHOW, 0, 84, { season: 2, episode: 1 }),
    ]);

    await recomputeWatchState(SHOW);
    expect((await db.movies.get(SHOW))?.episodesWatched).toBe(3);
  });

  it('unions coverage within one episode across sittings', async () => {
    // Half on Monday, half on Friday — same episode, so it counts once.
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.bulkAdd([
      session(SHOW, 0, 44, { season: 1, episode: 1 }),
      session(SHOW, 40, 89, { season: 1, episode: 1 }),
    ]);

    await recomputeWatchState(SHOW);
    expect((await db.movies.get(SHOW))?.episodesWatched).toBe(1);
  });

  it('treats a second viewing of one episode as a rewatch, not a new episode', async () => {
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.bulkAdd([
      session(SHOW, 0, 84, { season: 1, episode: 1 }),
      session(SHOW, 0, 84, { season: 1, episode: 1 }),
    ]);

    await recomputeWatchState(SHOW);

    const show = await db.movies.get(SHOW);
    expect(show?.episodesWatched).toBe(1);
    expect(show?.rewatch).toBe(1);
  });
});

describe('watchedEpisodes', () => {
  it('lists finished episodes newest first', async () => {
    await db.movies.put(record('tv', 1399, 'Game of Thrones'));
    await db.sessions.bulkAdd([
      session(SHOW, 0, 84, { season: 1, episode: 1 }),
      session(SHOW, 0, 84, { season: 2, episode: 3 }),
      session(SHOW, 0, 10, { season: 3, episode: 1 }), // unfinished
    ]);

    const episodes = await watchedEpisodes(SHOW);
    expect(episodes.map((e) => `S${e.season}E${e.episode}`)).toEqual(['S2E3', 'S1E1']);
  });
});

describe('films are unaffected', () => {
  it('still completes from unioned coverage', async () => {
    await db.movies.put(record('movie', 27205, 'Inception'));
    await db.sessions.bulkAdd([session(FILM, 0, 44), session(FILM, 40, 89)]);

    await recomputeWatchState(FILM);

    const film = await db.movies.get(FILM);
    expect(film?.watched).toBe(1);
    expect(film?.episodesWatched).toBeUndefined();
  });

  it('does not complete from partial coverage', async () => {
    await db.movies.put(record('movie', 27205, 'Inception'));
    await db.sessions.add(session(FILM, 0, 40));

    await recomputeWatchState(FILM);
    expect((await db.movies.get(FILM))?.watched).toBe(0);
  });
});
