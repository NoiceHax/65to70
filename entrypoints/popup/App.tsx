import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  SUGGESTED_SITES,
  grantedOrigins,
  originPatternFor,
  requestSite,
  revokeSite,
} from '@/lib/permissions';
import { continueWatching, db } from '@/lib/db';
import type { Movie } from '@/lib/types';
import './App.css';

interface ContinueRow {
  movie: Movie;
  ratio: number;
  lastSeenAt: number;
}

function App() {
  const [origins, setOrigins] = useState<string[]>([]);
  const [tabOrigin, setTabOrigin] = useState<string | null>(null);
  const [tabHost, setTabHost] = useState<string | null>(null);
  const [resuming, setResuming] = useState<ContinueRow[]>([]);
  const [watchedCount, setWatchedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  const refresh = useCallback(async () => {
    setOrigins(await grantedOrigins());
    setWatchedCount(await db.movies.where('watched').equals(1).count());
    setPendingCount(await db.pending.where('status').equals('awaiting').count());

    const rows = await continueWatching(5);
    setResuming(
      rows.map(({ movie, session, ratio }) => ({
        movie,
        ratio,
        lastSeenAt: session.lastSeenAt,
      })),
    );
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;
      setTabOrigin(originPatternFor(tab.url));
      try {
        setTabHost(new URL(tab.url).hostname);
      } catch {
        /* non-web tab */
      }
    })();
  }, [refresh]);

  const isGranted = (origin: string) => origins.includes(origin);

  const toggle = async (origin: string) => {
    if (isGranted(origin)) await revokeSite(origin);
    else await requestSite(origin);
    await refresh();
  };

  return (
    <main>
      <header>
        <h1>Keeper</h1>
        <p className="tagline">Nothing leaves this machine.</p>
      </header>

      <section>
        <h2>Continue watching</h2>
        {resuming.length === 0 ? (
          <p className="empty">
            Nothing in progress. Add a site below, then play something.
          </p>
        ) : (
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
        )}
      </section>

      <section>
        <h2>Watched sites</h2>
        <p className="note">
          Keeper only runs on sites you turn on here. Nothing is requested at
          install.
        </p>

        {tabOrigin && !isGranted(tabOrigin) && (
          <button className="primary" onClick={() => void toggle(tabOrigin)}>
            Watch {tabHost}
          </button>
        )}

        <ul className="sites">
          {SUGGESTED_SITES.map((site) => (
            <li key={site.origin}>
              <label>
                <input
                  type="checkbox"
                  checked={isGranted(site.origin)}
                  onChange={() => void toggle(site.origin)}
                />
                {site.label}
              </label>
            </li>
          ))}
          {origins
            .filter((o) => !SUGGESTED_SITES.some((s) => s.origin === o))
            .map((origin) => (
              <li key={origin}>
                <label>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => void toggle(origin)}
                  />
                  {origin.replace('*://', '').replace('/*', '')}
                </label>
              </li>
            ))}
        </ul>
      </section>

      <footer>
        <span>{watchedCount} watched</span>
        {pendingCount > 0 && <span>{pendingCount} to confirm</span>}
      </footer>
    </main>
  );
}

function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export default App;
