import { useCallback, useEffect, useState } from 'react';
import { db } from '@/lib/db';
import ConfirmQueue from './views/ConfirmQueue';
import Library from './views/Library';
import Watchlist from './views/Watchlist';
import Sites from './views/Sites';
import './App.css';

type Tab = 'queue' | 'watchlist' | 'library' | 'sites';

function App() {
  const [tab, setTab] = useState<Tab>('sites');
  const [pendingCount, setPendingCount] = useState(0);
  const [watchedCount, setWatchedCount] = useState(0);
  const [version, setVersion] = useState(0);
  const [landed, setLanded] = useState(false);

  const refresh = useCallback(async () => {
    const pending = await db.pending.where('status').equals('awaiting').count();
    const watched = await db.movies.where('watched').equals(1).count();
    setPendingCount(pending);
    setWatchedCount(watched);

    // Open on whichever screen has something to act on, but only once —
    // afterwards which tab is showing is the user's business.
    if (!landed) {
      setTab(pending > 0 ? 'queue' : watched > 0 ? 'library' : 'sites');
      setLanded(true);
    }
  }, [landed]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <main>
      <header>
        <h1>Keeper</h1>
        <p className="tagline">Nothing leaves this machine.</p>
      </header>

      <nav>
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
          Confirm
          {pendingCount > 0 && <span className="count">{pendingCount}</span>}
        </button>
        <button className={tab === 'watchlist' ? 'on' : ''} onClick={() => setTab('watchlist')}>
          Watchlist
        </button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>
          Watched
        </button>
        <button className={tab === 'sites' ? 'on' : ''} onClick={() => setTab('sites')}>
          Sites
        </button>
      </nav>

      {tab === 'queue' && <ConfirmQueue key={version} onChange={bump} />}
      {tab === 'watchlist' && <Watchlist key={version} />}
      {tab === 'library' && <Library key={version} />}
      {tab === 'sites' && <Sites onChange={bump} />}

      <footer>
        <span>{watchedCount} watched</span>
        {pendingCount > 0 && <span>{pendingCount} to confirm</span>}
      </footer>
    </main>
  );
}

export default App;
