import { useCallback, useEffect, useState } from 'react';
import { removeFromWatchlist, watchlist, type WatchlistEntry } from '@/lib/watchlist';
import { providersForMany } from '@/lib/providers';
import {
  addToCollection,
  createCollection,
  listCollections,
  type CollectionWithItems,
} from '@/lib/collections';

/**
 * The merged watchlist.
 *
 * Shows provenance rather than hiding it. "Saved on Netflix and Prime" is the
 * information that makes a merged list trustworthy - without it the user has no
 * way to tell why something is here or where it came from.
 */
export default function Watchlist() {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [available, setAvailable] = useState<Map<number, string[]>>(new Map());
  const [collections, setCollections] = useState<CollectionWithItems[]>([]);
  const [filter, setFilter] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const rows = await watchlist();
    setEntries(rows);
    setAvailable(await providersForMany(rows.map((r) => r.movie.tmdbId)));
    setCollections(await listCollections());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (entries.length === 0) {
    return (
      <p className="empty">
        Nothing saved yet. Titles you save on any service show up here as one
        list, with duplicates merged.
      </p>
    );
  }

  const inFilter =
    filter === null
      ? null
      : new Set(
          collections.find((c) => c.collection.id === filter)?.movies.map((m) => m.key) ?? [],
        );

  const visible = inFilter ? entries.filter((e) => inFilter.has(e.movie.key)) : entries;

  const newCollection = async () => {
    const name = prompt('Name this collection');
    if (name?.trim()) {
      await createCollection(name);
      await refresh();
    }
  };

  return (
    <section>
      <h2>Watchlist ({visible.length})</h2>

      <div className="chips">
        <button className={filter === null ? 'chip on' : 'chip'} onClick={() => setFilter(null)}>
          All
        </button>
        {collections.map(({ collection, movies }) => (
          <button
            key={collection.id}
            className={filter === collection.id ? 'chip on' : 'chip'}
            onClick={() => setFilter(filter === collection.id ? null : collection.id!)}
          >
            {collection.name} <span className="dim">{movies.length}</span>
          </button>
        ))}
        <button className="chip add" onClick={() => void newCollection()} title="New collection">
          +
        </button>
      </div>

      <ul className="library">
        {visible.map(({ movie, savedOn, addedAt }) => {
          const where = available.get(movie.tmdbId) ?? [];
          return (
            <li key={movie.key} className="watch-row">
              <div className="watch-main">
                <span className="title">
                  {movie.title}
                  {movie.year ? <span className="year"> {movie.year}</span> : null}
                </span>
                <span className="meta">
                  {savedOn.length > 1 ? `saved on ${savedOn.join(', ')}` : `saved on ${savedOn[0]}`}
                  {addedAt ? ` · ${addedAt.slice(0, 4)}` : ''}
                </span>
                {where.length > 0 && <span className="where">{where.join(' · ')}</span>}
              </div>
              <div className="row-actions">
                {collections.length > 0 && (
                  <select
                    className="add-to"
                    value=""
                    title="Add to a collection"
                    onChange={async (e) => {
                      const id = Number(e.target.value);
                      if (!id) return;
                      await addToCollection(id, movie.key);
                      await refresh();
                    }}
                  >
                    <option value="">+</option>
                    {collections.map(({ collection }) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="mark inline"
                  title="Remove from watchlist"
                  onClick={async () => {
                    await removeFromWatchlist(movie.key);
                    await refresh();
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
