import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings, type Settings } from '@/lib/settings';
import { db } from '@/lib/db';
import './App.css';

const REGIONS = ['IN', 'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'BR', 'SG'];

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [counts, setCounts] = useState({ movies: 0, sessions: 0, pending: 0 });

  const refresh = useCallback(async () => {
    setSettings(await getSettings());
    setCounts({
      movies: await db.movies.count(),
      sessions: await db.sessions.count(),
      pending: await db.pending.count(),
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = async (patch: Partial<Settings>) => {
    setSettings(await saveSettings(patch));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const exportAll = async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      movies: await db.movies.toArray(),
      // Bitmaps don't survive JSON, so coverage becomes a plain array.
      sessions: (await db.sessions.toArray()).map((s) => ({
        ...s,
        coverage: Array.from(s.coverage),
      })),
      collections: await db.collections.toArray(),
      collectionItems: await db.collectionItems.toArray(),
      pending: await db.pending.toArray(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `keeper-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!settings) return <main>Loading…</main>;

  return (
    <main>
      <h1>Keeper</h1>
      <p className="lede">
        Your watch history, watchlist and ratings are stored on this machine and
        are never uploaded. The only outbound requests Keeper makes are the ones
        described below.
      </p>

      <section>
        <h2>Identifying titles</h2>
        <p className="note">
          Keeper tracks what you watch entirely offline. Turning a title into a
          canonical entry — which is what syncing and availability need — takes a
          free TMDB API key.
        </p>

        <label className="field">
          <span>TMDB API key</span>
          <input
            type="password"
            value={settings.tmdbApiKey ?? ''}
            placeholder="Paste your v3 API key"
            onChange={(e) => void update({ tmdbApiKey: e.target.value.trim() })}
          />
        </label>
        <p className="hint">
          Get one free at themoviedb.org → Settings → API. The key is stored
          locally and sent only to TMDB.
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={settings.allowNetworkResolve}
            onChange={(e) => void update({ allowNetworkResolve: e.target.checked })}
          />
          <span>
            <strong>Look up titles by name</strong>
            <em>
              When a page has no catalogue id, search TMDB for the title text.
              This tells TMDB that someone searched that title — not who, and not
              that it was watched. Off by default; ids found in the page URL are
              always resolved without this.
            </em>
          </span>
        </label>

        <label className="field">
          <span>Region</span>
          <select
            value={settings.region}
            onChange={(e) => void update({ region: e.target.value })}
          >
            {REGIONS.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <h2>Your data</h2>
        <p className="note">
          {counts.movies} titles · {counts.sessions} sessions · {counts.pending} awaiting
          confirmation
        </p>
        <button onClick={() => void exportAll()}>Export everything as JSON</button>
      </section>

      {saved && <div className="toast">Saved</div>}
    </main>
  );
}

export default App;
