import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { isOnWatchlist, removeFromWatchlist, watchlist } from '@/lib/watchlist';
import { titleKey, type Movie, type Source } from '@/lib/types';

function movie(partial: Partial<Movie> & { tmdbId: number; title: string }): Movie {
  return {
    key: titleKey('movie', partial.tmdbId),
    mediaType: 'movie',
    watched: 0,
    liked: 0,
    rating: null,
    rewatch: 0,
    sources: [],
    tags: [],
    ...partial,
  };
}

const saved = (platform: string, at = '2025-01-01'): Source => ({
  kind: 'watchlist',
  platform,
  at,
});

beforeEach(async () => {
  await db.movies.clear();
});

describe('watchlist', () => {
  it('merges one title saved on two services into a single row', async () => {
    await db.movies.put(
      movie({
        tmdbId: 438631,
        title: 'Dune',
        sources: [saved('netflix', '2024-03-02'), saved('prime', '2025-01-11')],
      }),
    );

    const entries = await watchlist();
    expect(entries).toHaveLength(1);
    // Provenance survives the merge - that's what makes the list trustworthy.
    expect(entries[0].savedOn).toEqual(['netflix', 'prime']);
    expect(entries[0].addedAt).toBe('2024-03-02');
  });

  it('excludes titles that have already been watched', async () => {
    await db.movies.put(
      movie({ tmdbId: 1, title: 'Seen It', watched: 1, sources: [saved('netflix')] }),
    );
    expect(await watchlist()).toHaveLength(0);
  });

  it('ignores titles that were only ever detected, never saved', async () => {
    await db.movies.put(
      movie({ tmdbId: 2, title: 'Just Played', sources: [{ kind: 'detected', platform: 'x.cc', at: '2025-01-01' }] }),
    );
    expect(await watchlist()).toHaveLength(0);
  });
});

describe('removeFromWatchlist', () => {
  it('deletes a row that has nothing else invested in it', async () => {
    const key = titleKey('movie', 3);
    await db.movies.put(movie({ tmdbId: 3, title: 'Passing Interest', sources: [saved('netflix')] }));

    await removeFromWatchlist(key);
    expect(await db.movies.get(key)).toBeUndefined();
  });

  it('keeps a rated title, dropping only its watchlist provenance', async () => {
    // Removing something from a list must not destroy a rating the user gave it.
    const key = titleKey('movie', 4);
    await db.movies.put(
      movie({ tmdbId: 4, title: 'Rated', rating: 4, sources: [saved('netflix')] }),
    );

    await removeFromWatchlist(key);

    const kept = await db.movies.get(key);
    expect(kept?.rating).toBe(4);
    expect(kept && isOnWatchlist(kept)).toBe(false);
  });

  it('keeps a watched title', async () => {
    const key = titleKey('movie', 5);
    await db.movies.put(
      movie({ tmdbId: 5, title: 'Watched', watched: 1, sources: [saved('prime')] }),
    );

    await removeFromWatchlist(key);
    expect(await db.movies.get(key)).toBeDefined();
  });
});
