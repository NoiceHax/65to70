import { useCallback, useEffect, useState } from 'react';
import { removeFromWatchlist, watchlist, type WatchlistEntry } from '@/lib/watchlist';
import { providersForMany } from '@/lib/providers';

/**
 * The merged watchlist.
 *
 * Shows provenance rather than hiding it. "Saved on Netflix and Prime" is the
 * information that makes a merged list trustworthy — without it the user has no
 * way to tell why something is here or where it came from.
 */
export default function Watchlist() {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [available, setAvailable] = useState<Map<number, string[]>>(new Map());

  const refresh = useCallback(async () => {
    const rows = await watchlist();
    setEntries(rows);
    setAvailable(await providersForMany(rows.map((r) => r.movie.tmdbId)));
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

  return (
    <section>
      <h2>Watchlist ({entries.length})</h2>
      <ul className="library">
        {entries.map(({ movie, savedOn, addedAt }) => {
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}
