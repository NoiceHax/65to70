import { useCallback, useEffect, useState } from 'react';
import {
  recommend,
  recommendationReadiness,
  saveRecommendation,
  type Recommendation,
} from '@/lib/recommend';

/**
 * Recommendations.
 *
 * Computed on this machine from a prepared relationship index. Nothing about
 * what you watch is sent anywhere to produce these.
 *
 * Every row states why it's here in checkable terms — "Because you watched
 * Inception and Interstellar" — and never as a match percentage.
 */
export default function Discover() {
  const [rows, setRows] = useState<Recommendation[]>([]);
  const [readiness, setReadiness] = useState<{ hasIndex: boolean; usableTitles: number } | null>(
    null,
  );
  const [availableOnly, setAvailableOnly] = useState(false);
  const [saved, setSaved] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    setReadiness(await recommendationReadiness());
    setRows(await recommend({ limit: 12, availableOnly }));
  }, [availableOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!readiness) return null;

  {
    /*
     * Two different problems, and neither is the user's to diagnose.
     *
     * This previously named a script and told them to load a file — a build
     * step described in a popup, as though the extension shipping without its
     * own data were something they had done wrong.
     */
  }
  if (!readiness.hasIndex) {
    return (
      <section>
        <h2>For you</h2>
        <p className="empty">
          Suggestions aren&apos;t available in this build. Once they are, they
          run entirely on this machine — nothing about what you watch is sent
          anywhere to produce them.
        </p>
      </section>
    );
  }

  if (readiness.usableTitles === 0) {
    return (
      <section>
        <h2>For you</h2>
        <p className="empty">
          Nothing to go on yet. Confirm a few films you&apos;ve watched — or like
          or rate some — and suggestions build from there.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>For you</h2>

      <div className="chips">
        <button
          className={availableOnly ? 'chip on' : 'chip'}
          onClick={() => setAvailableOnly(!availableOnly)}
        >
          Streaming now
        </button>
        <span className="meta">from {readiness.usableTitles} titles</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">
          {availableOnly
            ? 'Nothing suggested is streaming in your region right now.'
            : 'Nothing to suggest yet — a few more watched titles will help.'}
        </p>
      ) : (
        <ul className="library">
          {rows.map((rec) => (
            <li key={rec.tmdbId} className="lib-row">
              <div className="lib-main">
                <span className="title">
                  {rec.title}
                  {rec.year ? <span className="year"> {rec.year}</span> : null}
                </span>
                <span className="meta">Because you watched {rec.because.join(' and ')}</span>
                {rec.availableOn.length > 0 && (
                  <span className="where">{rec.availableOn.slice(0, 3).join(' · ')}</span>
                )}
              </div>
              <button
                className="mark inline"
                title="Save to watchlist"
                disabled={saved.has(rec.tmdbId)}
                onClick={async () => {
                  await saveRecommendation(rec);
                  setSaved(new Set([...saved, rec.tmdbId]));
                }}
              >
                {saved.has(rec.tmdbId) ? '✓' : '+'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
