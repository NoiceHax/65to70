import { useCallback, useEffect, useState } from 'react';
import { activeTracking, type ActiveTracking } from '@/lib/db';

/**
 * What's playing right now.
 *
 * Sits above the tabs and shows on every screen, because "is this thing even
 * working?" was the question that took longest to answer during development —
 * and a user has no logs to fall back on. A live row answers it at a glance.
 *
 * Polls while the popup is open. A popup is short-lived and only visible when
 * someone is actually looking, so a two-second interval costs nothing.
 */
export default function TrackingNow() {
  const [rows, setRows] = useState<ActiveTracking[]>([]);

  const refresh = useCallback(async () => {
    setRows(await activeTracking());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (rows.length === 0) return null;

  return (
    <div className="tracking">
      {rows.map((row) => (
        <div key={row.sessionId} className="tracking-row">
          <span className="dot" aria-hidden />
          <span className="tracking-main">
            <span className="title">
              {row.title}
              {row.season !== undefined && row.episode !== undefined && (
                <span className="year">
                  {' '}
                  S{row.season}E{row.episode}
                </span>
              )}
            </span>
            <span className="meta">
              {/* Percentages only mean something once a runtime is known, which
                  needs the title matched first. */}
              {row.identified ? `${Math.round(row.ratio * 100)}% · ` : 'not yet matched · '}
              {row.site}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
