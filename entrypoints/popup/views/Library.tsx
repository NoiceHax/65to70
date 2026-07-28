import { useCallback, useEffect, useState } from 'react';
import {
  clearManualProgress,
  continueWatching,
  db,
  setManualProgress,
  titleProgress,
} from '@/lib/db';
import type { Movie } from '@/lib/types';

interface Row {
  movie: Movie;
  progress: number;
  lastSeenAt?: number;
}

export default function Library() {
  const [resuming, setResuming] = useState<Row[]>([]);
  const [watched, setWatched] = useState<Row[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * The slider's value while it's being dragged.
   *
   * Writing on every pointer move re-sorted the list underneath the cursor —
   * crossing the completion threshold moves a row from "Continue watching" to
   * "Watched" — so the thing being dragged jumped away mid-drag. The value is
   * held here until the drag ends, and only then committed.
   */
  const [draft, setDraft] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const inProgress = await continueWatching(8);
    setResuming(
      await Promise.all(
        inProgress.map(async ({ movie, session }) => ({
          movie,
          progress: await titleProgress(movie.key),
          lastSeenAt: session.lastSeenAt,
        })),
      ),
    );

    const done = await db.movies.where('watched').equals(1).toArray();
    done.sort((a, b) => (b.lastConfirmed ?? 0) - (a.lastConfirmed ?? 0));
    setWatched(
      await Promise.all(
        done.slice(0, 30).map(async (movie) => ({
          movie,
          progress: await titleProgress(movie.key),
        })),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const adjust = async (key: string, ratio: number) => {
    await setManualProgress(key, ratio);
    setDraft(null);
    await refresh();
  };

  /** Commit whatever the slider was left on, if anything. */
  const commitDraft = async (key: string) => {
    if (draft === null) return;
    await adjust(key, draft / 100);
  };

  const renderRow = ({ movie, progress, lastSeenAt }: Row) => (
    <li key={movie.key} className="lib-row">
      <div className="lib-main">
        <span className="title">
          {movie.title}
          {movie.year ? <span className="year"> {movie.year}</span> : null}
          {movie.mediaType === 'tv' && movie.episodesWatched ? (
            <span className="badge">
              {movie.episodesWatched} ep{movie.episodesWatched === 1 ? '' : 's'}
            </span>
          ) : movie.rewatch > 0 ? (
            <span className="badge">×{movie.rewatch + 1}</span>
          ) : null}
        </span>
        <span className="meta">
          {/* Clicking the figure is what opens the override. Measurement is a
              guess — padded streams, different cuts, reloads splitting a
              viewing — and the person watching knows better than it does. */}
          <button
            className="pct"
            title="Adjust progress"
            onClick={() => {
              // A draft belongs to one row's slider; switching rows discards it.
              setDraft(null);
              setEditing(editing === movie.key ? null : movie.key);
            }}
          >
            {Math.round(progress * 100)}%
            {movie.manualProgress !== undefined && <span className="manual"> set</span>}
          </button>
          {lastSeenAt ? ` · ${relativeDay(lastSeenAt)}` : ''}
          {movie.rating !== null && <span className="rating"> {movie.rating}★</span>}
          <button
            className={movie.liked === 1 ? 'mark on inline' : 'mark inline'}
            title={movie.liked === 1 ? 'Liked' : 'Not liked'}
            onClick={async () => {
              await db.movies.update(movie.key, { liked: movie.liked === 1 ? 0 : 1 });
              await refresh();
            }}
          >
            {movie.liked === 1 ? '♥' : '♡'}
          </button>
        </span>

        {editing === movie.key && (
          <div className="adjust">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={draft ?? Math.round(progress * 100)}
              // Dragging only moves the handle. Nothing is written, and so
              // nothing re-sorts, until the drag ends.
              onChange={(e) => setDraft(Number(e.target.value))}
              onPointerUp={() => void commitDraft(movie.key)}
              onKeyUp={() => void commitDraft(movie.key)}
              onBlur={() => void commitDraft(movie.key)}
            />
            <div className="adjust-actions">
              <button onClick={() => void adjust(movie.key, 1)}>Finished</button>
              {movie.manualProgress !== undefined && (
                <button
                  onClick={async () => {
                    await clearManualProgress(movie.key);
                    await refresh();
                  }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );

  return (
    <>
      {resuming.length > 0 && (
        <section>
          <h2>Continue watching</h2>
          <ul className="library">{resuming.map(renderRow)}</ul>
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
          <ul className="library">{watched.map(renderRow)}</ul>
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
