import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { suggestQueue } from '@/lib/queue';
import { saveAvailabilityIndex, clearAvailabilityIndex } from '@/lib/providers';
import { titleKey, type Movie } from '@/lib/types';

function movie(partial: Partial<Movie> & { tmdbId: number; title: string }): Movie {
  return {
    key: titleKey('movie', partial.tmdbId),
    mediaType: 'movie',
    watched: 0,
    liked: 0,
    rating: null,
    rewatch: 0,
    sources: [{ kind: 'watchlist', platform: 'netflix', at: '2025-06-01' }],
    tags: [],
    ...partial,
  };
}

function isoMonthsAgo(months: number): string {
  const date = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

beforeEach(async () => {
  await db.movies.clear();
  await db.meta.clear();
  await clearAvailabilityIndex('IN');
});

describe('suggestQueue', () => {
  it('returns nothing when the watchlist is empty', async () => {
    expect(await suggestQueue()).toEqual([]);
  });

  it('ranks a streamable title above one that is not', async () => {
    // A suggestion you can't act on is the exact failing of single-service
    // recommenders, so actionability has to dominate.
    await db.movies.bulkPut([
      movie({ tmdbId: 1, title: 'Unavailable' }),
      movie({ tmdbId: 2, title: 'Streamable' }),
    ]);

    await saveAvailabilityIndex({
      region: 'IN',
      generatedAt: '2026-07-01',
      providers: { '8': 'Netflix' },
      providerOrder: ['8'],
      titles: { '2': 1 },
    });

    const queue = await suggestQueue();
    expect(queue[0].movie.title).toBe('Streamable');
    expect(queue[0].reasons).toContain('on Netflix');
  });

  it('excludes anything over the time budget', async () => {
    await db.movies.bulkPut([
      movie({ tmdbId: 1, title: 'Short', runtime: 90 }),
      movie({ tmdbId: 2, title: 'Epic', runtime: 210 }),
    ]);

    const queue = await suggestQueue({ maxRuntimeMinutes: 100 });
    expect(queue.map((s) => s.movie.title)).toEqual(['Short']);
    expect(queue[0].reasons).toContain('runs 90 minutes');
  });

  it('surfaces titles that have been sitting on the list', async () => {
    await db.movies.bulkPut([
      movie({
        tmdbId: 1,
        title: 'Fresh',
        sources: [{ kind: 'watchlist', platform: 'netflix', at: isoMonthsAgo(1) }],
      }),
      movie({
        tmdbId: 2,
        title: 'Ancient',
        sources: [{ kind: 'watchlist', platform: 'netflix', at: isoMonthsAgo(30) }],
      }),
    ]);

    const queue = await suggestQueue();
    expect(queue[0].movie.title).toBe('Ancient');
    expect(queue[0].reasons.some((r) => r.includes('years ago'))).toBe(true);
  });

  it('treats saving on two services as stronger intent', async () => {
    await db.movies.bulkPut([
      movie({ tmdbId: 1, title: 'Once' }),
      movie({
        tmdbId: 2,
        title: 'Twice',
        sources: [
          { kind: 'watchlist', platform: 'netflix', at: '2025-06-01' },
          { kind: 'watchlist', platform: 'prime', at: '2025-06-01' },
        ],
      }),
    ]);

    const queue = await suggestQueue();
    expect(queue[0].movie.title).toBe('Twice');
    expect(queue[0].reasons).toContain('saved on 2 services');
  });

  it('never states a match percentage', async () => {
    // The whole point: reasons are checkable facts, not unfalsifiable scores.
    await db.movies.put(movie({ tmdbId: 1, title: 'Anything', runtime: 100 }));

    const [suggestion] = await suggestQueue({ maxRuntimeMinutes: 120 });
    for (const reason of suggestion.reasons) {
      expect(reason).not.toMatch(/%|match|score/i);
    }
  });

  it('always gives at least one reason', async () => {
    await db.movies.put(movie({ tmdbId: 1, title: 'Plain' }));
    const [suggestion] = await suggestQueue();
    expect(suggestion.reasons.length).toBeGreaterThan(0);
  });

  it('leaves watched titles out', async () => {
    await db.movies.put(movie({ tmdbId: 1, title: 'Seen', watched: 1 }));
    expect(await suggestQueue()).toEqual([]);
  });
});
