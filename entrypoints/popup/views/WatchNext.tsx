import { useCallback, useEffect, useState } from 'react';
import { suggestQueue, type QueueSuggestion } from '@/lib/queue';

/**
 * "Watch next."
 *
 * Orders the list the user already built rather than proposing new titles, so
 * there's no cold start and nothing to be wrong about. Every line states a
 * checkable fact — never a match percentage.
 */

const BUDGETS = [
  { label: 'Any length', minutes: undefined },
  { label: 'Under 90m', minutes: 90 },
  { label: 'Under 2h', minutes: 120 },
];

export default function WatchNext() {
  const [budget, setBudget] = useState<number | undefined>(undefined);
  const [suggestions, setSuggestions] = useState<QueueSuggestion[]>([]);

  const refresh = useCallback(async () => {
    setSuggestions(await suggestQueue({ maxRuntimeMinutes: budget, limit: 8 }));
  }, [budget]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section>
      <h2>Watch next</h2>

      <div className="chips">
        {BUDGETS.map((option) => (
          <button
            key={option.label}
            className={budget === option.minutes ? 'chip on' : 'chip'}
            onClick={() => setBudget(option.minutes)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {suggestions.length === 0 ? (
        <p className="empty">
          {budget
            ? 'Nothing on your watchlist fits that time.'
            : 'Save something to your watchlist and it will be ordered here.'}
        </p>
      ) : (
        <ol className="next">
          {suggestions.map(({ movie, reasons }) => (
            <li key={movie.key}>
              <span className="title">
                {movie.title}
                {movie.year ? <span className="year"> {movie.year}</span> : null}
              </span>
              <span className="meta">{reasons.join(' · ')}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
