import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { coverageRatio, db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { titleIndexStatus } from '@/lib/titleIndex';
import {
  confirmCandidate,
  dismissAllPending,
  dismissPending,
  resolvePending,
  searchManually,
} from '@/lib/resolver';
import type { MediaType, PendingDetection } from '@/lib/types';
import type { TmdbTitle } from '@/lib/tmdb';

/**
 * The confirm queue.
 *
 * The one rule this screen exists to enforce: nothing reaches the library, a
 * diary or a sync target without the user saying so. A missing entry is a minor
 * annoyance; a wrong entry in a curated diary is not.
 */

interface Row {
  pending: PendingDetection;
  coverage: number;
  site: string;
}

export default function ConfirmQueue({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  /** Whether anything exists to resolve titles against at all. */
  const [ready, setReady] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    const [settings, index] = await Promise.all([getSettings(), titleIndexStatus()]);
    setReady(index.loaded || Boolean(settings.tmdbApiKey));

    const pending = await db.pending
      .where('status')
      .equals('awaiting')
      .reverse()
      .sortBy('detectedAt');

    const built: Row[] = [];
    for (const item of pending) {
      const session = await db.sessions.get(item.sessionId);
      built.push({
        pending: item,
        coverage: session ? coverageRatio(session.coverage) : 0,
        site: session?.site ?? item.hostname,
      });
    }
    setRows(built);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const after = async () => {
    await refresh();
    onChange();
  };

  if (rows.length === 0) {
    return (
      <p className="empty">
        Nothing waiting. Finished films show up here for you to confirm before
        anything is recorded.
      </p>
    );
  }

  return (
    <>
      <div className="queue-head-bar">
        <span className="meta">{rows.length} waiting</span>
        {/* Bulk escape hatch. Each one is also remembered as not-a-film for
            its site, so clearing the queue actually stays cleared. */}
        <button
          className="link"
          onClick={async () => {
            await dismissAllPending();
            await after();
          }}
        >
          Dismiss all
        </button>
      </div>

      <ul className="queue">
        {rows.map((row) => (
          <QueueItem
            key={row.pending.id}
            row={row}
            busy={busy === row.pending.id}
            setBusy={setBusy}
            onDone={after}
            ready={ready}
          />
        ))}
      </ul>
    </>
  );
}

function QueueItem({
  row,
  busy,
  setBusy,
  onDone,
  ready,
}: {
  row: Row;
  busy: boolean;
  setBusy: (id: number | null) => void;
  onDone: () => Promise<void>;
  /** Null while still being checked; false when no resolver is configured. */
  ready: boolean | null;
}) {
  const { pending } = row;
  const id = pending.id!;

  const [selected, setSelected] = useState<number | null>(
    pending.candidates[0]?.tmdbId ?? null,
  );
  const [liked, setLiked] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [query, setQuery] = useState(pending.cleanedTitle);
  const [manual, setManual] = useState<TmdbTitle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaType: MediaType = pending.season !== undefined ? 'tv' : 'movie';
  const candidates = manual
    ? manual.map((m) => ({
        tmdbId: m.tmdbId,
        mediaType: m.mediaType,
        title: m.title,
        year: m.year,
        score: 0,
      }))
    : pending.candidates;

  const confirm = async () => {
    if (selected === null) return;
    setBusy(id);
    setError(null);

    const chosen = candidates.find((c) => c.tmdbId === selected);
    const movie = await confirmCandidate(id, selected, chosen?.mediaType ?? mediaType, {
      liked,
      rating,
    });

    setBusy(null);
    if (!movie) {
      setError('Could not fetch details. Check your TMDB key in options.');
      return;
    }
    await onDone();
  };

  const retry = async () => {
    setBusy(id);
    const outcome = await resolvePending(id);
    setBusy(null);
    if (outcome.message) setError(outcome.message);
    await onDone();
  };

  const runSearch = async () => {
    setBusy(id);
    const results = await searchManually(query, mediaType);
    setBusy(null);
    setManual(results);
    setSelected(results[0]?.tmdbId ?? null);
    if (results.length === 0) setError('No matches. Try a different spelling.');
  };

  return (
    <li className="queue-item">
      <div className="queue-head">
        <strong>{pending.cleanedTitle || '(no title read)'}</strong>
        <span className="meta">
          {Math.round(row.coverage * 100)}% · {row.site}
        </span>
      </div>

      {pending.season !== undefined && (
        <div className="meta">
          Season {pending.season}, episode {pending.episode}
        </div>
      )}

      {candidates.length === 0 ? (
        // "No match found" is true but points at the wrong problem when the
        // real cause is that nothing has been configured to match against.
        <p className="meta">
          {ready === false ? (
            <>
              Nothing to match against yet — load a title index or add a TMDB
              key.{' '}
              <button
                className="link"
                onClick={() => void browser.runtime.openOptionsPage()}
              >
                Open settings
              </button>
            </>
          ) : (
            <>
              No match found.{' '}
              <button className="link" onClick={() => void retry()} disabled={busy}>
                Try again
              </button>
            </>
          )}
        </p>
      ) : (
        <ul className="candidates">
          {candidates.map((candidate) => (
            <li key={`${candidate.mediaType}:${candidate.tmdbId}`}>
              <label>
                <input
                  type="radio"
                  name={`pending-${id}`}
                  checked={selected === candidate.tmdbId}
                  onChange={() => setSelected(candidate.tmdbId)}
                />
                <span>
                  {candidate.title}
                  {candidate.year ? <span className="year"> {candidate.year}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="search-row">
        <input
          value={query}
          placeholder="Search by title"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
        />
        <button onClick={() => void runSearch()} disabled={busy}>
          Search
        </button>
      </div>

      {/* Optional on purpose. Most people never rate anything, and a film that
          is watched and liked with no stars is a real state, not a gap. */}
      <div className="marks">
        <button
          className={liked ? 'mark on' : 'mark'}
          onClick={() => setLiked(!liked)}
          title="Liked"
        >
          {liked ? '♥' : '♡'} Liked
        </button>
        <div className="stars">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              className={rating !== null && rating >= star ? 'star on' : 'star'}
              onClick={() => setRating(rating === star ? null : star)}
              title={`${star} star${star > 1 ? 's' : ''}`}
            >
              ★
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button className="primary" onClick={() => void confirm()} disabled={busy || selected === null}>
          {busy ? 'Saving…' : 'Confirm'}
        </button>
        <button
          onClick={async () => {
            setBusy(id);
            await dismissPending(id);
            setBusy(null);
            await onDone();
          }}
          disabled={busy}
        >
          Not me
        </button>
      </div>
    </li>
  );
}
