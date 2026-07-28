import { useCallback, useEffect, useState } from 'react';
import { continueWatching, db } from '@/lib/db';
import type { Movie } from '@/lib/types';

interface ResumeRow {
  movie: Movie;
  ratio: number;
  lastSeenAt: number;
}

export default function Library() {
  const [resuming, setResuming] = useState<ResumeRow[]>([]);
  const [watched, setWatched] = useState<Movie[]>([]);

  const refresh = useCallback(async () => {
    const rows = await continueWatching(5);
    setResuming(
      rows.map(({ movie, session, ratio }) => ({
        movie,
        ratio,
        lastSeenAt: session.lastSeenAt,
      })),
    );

    const all = await db.movies.where('watched').equals(1).toArray();
    all.sort((a, b) => (b.lastConfirmed ?? 0) - (a.lastConfirmed ?? 0));
    setWatched(all.slice(0, 30));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleLiked = async (movie: Movie) => {
    await db.movies.update(movie.key, { liked: movie.liked === 1 ? 0 : 1 });
    await refresh();
  };

  return (
    <>
      {resuming.length > 0 && (
        <section>
          <h2>Continue watching</h2>
          <ul className="resume">
            {resuming.map(({ movie, ratio, lastSeenAt }) => (
              <li key={movie.key}>
                <span className="title">
                  {movie.title}
                  {movie.year ? <span className="year"> {movie.year}</span> : null}
                </span>
                <span className="meta">
                  {Math.round(ratio * 100)}% · {relativeDay(lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Watched</h2>
        {watched.length === 0 ? (
          <p className="empty">
            Nothing recorded yet. Finished films appear here once you confirm
            them.
          </p>
        ) : (
          <ul className="library">
            {watched.map((movie) => (
              <li key={movie.key}>
                <span className="title">
                  {movie.title}
                  {movie.year ? <span className="year"> {movie.year}</span> : null}
                  {/* A series accumulates rather than being finished, so it
                      reports episodes seen instead of a rewatch multiplier. */}
                  {movie.mediaType === 'tv' && movie.episodesWatched ? (
                    <span className="badge">
                      {movie.episodesWatched} ep{movie.episodesWatched === 1 ? '' : 's'}
                    </span>
                  ) : movie.rewatch > 0 ? (
                    <span className="badge">×{movie.rewatch + 1}</span>
                  ) : null}
                </span>
                <span className="meta">
                  {movie.rating !== null && <span className="rating">{movie.rating}★</span>}
                  <button
                    className={movie.liked === 1 ? 'mark on inline' : 'mark inline'}
                    onClick={() => void toggleLiked(movie)}
                    title={movie.liked === 1 ? 'Liked' : 'Not liked'}
                  >
                    {movie.liked === 1 ? '♥' : '♡'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
