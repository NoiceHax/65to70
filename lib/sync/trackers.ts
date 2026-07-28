import { db } from '../db';
import { getSettings } from '../settings';
import type { Movie, Session, SyncProvider } from '../types';

/**
 * Pushing confirmed history to Simkl and Trakt.
 *
 * Both use a device/PIN flow rather than a redirect flow. A browser extension
 * is a public client - anything in the bundle is readable by anyone who
 * installs it - so there is nowhere safe to keep a shared secret. Device flow
 * also avoids registering a redirect URL against an extension id that changes
 * between development and the store.
 *
 * Nothing is pushed that the user hasn't confirmed. The sync layer reads the
 * library, and the library is only written by the confirm queue.
 */

export interface DeviceCodeGrant {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  intervalSeconds: number;
  /** Opaque handle the poll step needs. */
  deviceCode: string;
}

export interface HistoryItem {
  title: string;
  year?: number;
  tmdbId: number;
  imdbId?: string;
  mediaType: 'movie' | 'tv';
  watchedAt: string;
  /** Present for series. Both services record episodes, never whole shows. */
  season?: number;
  episode?: number;
}

export class SyncError extends Error {}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Build the history payload from confirmed sessions.
 *
 * One entry per completed session, so a rewatch is two entries with their real
 * dates. Both services accept the same shape here, which is the only reason
 * this can be shared.
 */
export async function buildHistory(): Promise<HistoryItem[]> {
  const movies = await db.movies.where('watched').equals(1).toArray();
  const items: HistoryItem[] = [];

  for (const movie of movies) {
    const sessions = await db.sessions.where('titleKey').equals(movie.key).toArray();
    const complete = sessions
      .filter((s: Session) => s.complete === 1)
      .sort((a, b) => a.startedAt - b.startedAt);

    const base = {
      title: movie.title,
      year: movie.year,
      tmdbId: movie.tmdbId,
      imdbId: movie.imdbId,
      mediaType: movie.mediaType,
    };

    if (complete.length === 0) {
      // Confirmed watched but its sessions were pruned. Only meaningful for a
      // film - an episode with no session has no episode number to send.
      if (movie.mediaType === 'movie') {
        items.push({
          ...base,
          watchedAt: new Date(movie.lastConfirmed ?? Date.now()).toISOString(),
        });
      }
      continue;
    }

    for (const session of complete) {
      items.push({
        ...base,
        watchedAt: new Date(session.stoppedAt ?? session.lastSeenAt).toISOString(),
        season: session.season,
        episode: session.episode,
      });
    }
  }

  return items;
}

/**
 * Both services record *episodes*, never whole shows.
 *
 * Sending a show with only its ids logs nothing useful - it has to carry the
 * season and episode structure, with a watch date on each episode. So episodes
 * are grouped back under their show and season here.
 */
function toPayload(items: HistoryItem[]) {
  const movies = items
    .filter((item) => item.mediaType === 'movie')
    .map((item) => ({
      title: item.title,
      year: item.year,
      ids: { tmdb: item.tmdbId, ...(item.imdbId ? { imdb: item.imdbId } : {}) },
      watched_at: item.watchedAt,
    }));

  const episodes = items.filter(
    (item) => item.mediaType === 'tv' && item.season !== undefined && item.episode !== undefined,
  );

  const shows = new Map<
    number,
    {
      title: string;
      year?: number;
      ids: { tmdb: number; imdb?: string };
      seasons: Map<number, { number: number; watched_at: string }[]>;
    }
  >();

  for (const item of episodes) {
    let show = shows.get(item.tmdbId);
    if (!show) {
      show = {
        title: item.title,
        year: item.year,
        ids: { tmdb: item.tmdbId, ...(item.imdbId ? { imdb: item.imdbId } : {}) },
        seasons: new Map(),
      };
      shows.set(item.tmdbId, show);
    }

    const season = show.seasons.get(item.season!) ?? [];
    season.push({ number: item.episode!, watched_at: item.watchedAt });
    show.seasons.set(item.season!, season);
  }

  return {
    movies,
    shows: [...shows.values()].map((show) => ({
      title: show.title,
      year: show.year,
      ids: show.ids,
      seasons: [...show.seasons].map(([number, eps]) => ({ number, episodes: eps })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Simkl - PIN flow
// ---------------------------------------------------------------------------

const SIMKL = 'https://api.simkl.com';

export async function simklRequestCode(): Promise<DeviceCodeGrant> {
  const { simklClientId } = await getSettings();
  if (!simklClientId) throw new SyncError('Add a Simkl client id in settings first.');

  const response = await fetch(`${SIMKL}/oauth/pin?client_id=${simklClientId}`);
  if (!response.ok) throw new SyncError(`Simkl refused the request (${response.status}).`);

  const data = (await response.json()) as {
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };

  return {
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresIn: data.expires_in,
    intervalSeconds: data.interval,
    deviceCode: data.user_code,
  };
}

/** Returns an access token once the user has approved, or null while waiting. */
export async function simklPoll(userCode: string): Promise<string | null> {
  const { simklClientId } = await getSettings();
  const response = await fetch(`${SIMKL}/oauth/pin/${userCode}?client_id=${simklClientId}`);
  if (!response.ok) return null;

  const data = (await response.json()) as { result: string; access_token?: string };
  return data.result === 'OK' && data.access_token ? data.access_token : null;
}

async function simklPush(items: HistoryItem[]): Promise<number> {
  const settings = await getSettings();
  const state = await db.syncState.get('simkl');
  if (!state?.accessToken) throw new SyncError('Not connected to Simkl.');

  const response = await fetch(`${SIMKL}/sync/history`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.accessToken}`,
      'simkl-api-key': settings.simklClientId ?? '',
    },
    body: JSON.stringify(toPayload(items)),
  });

  if (response.status === 401) throw new SyncError('Simkl rejected the token. Reconnect.');
  if (!response.ok) throw new SyncError(`Simkl sync failed (${response.status}).`);
  return items.length;
}

// ---------------------------------------------------------------------------
// Trakt - device flow
// ---------------------------------------------------------------------------

const TRAKT = 'https://api.trakt.tv';

export async function traktRequestCode(): Promise<DeviceCodeGrant> {
  const { traktClientId } = await getSettings();
  if (!traktClientId) throw new SyncError('Add a Trakt client id in settings first.');

  const response = await fetch(`${TRAKT}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: traktClientId }),
  });
  if (!response.ok) throw new SyncError(`Trakt refused the request (${response.status}).`);

  const data = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };

  return {
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresIn: data.expires_in,
    intervalSeconds: data.interval,
    deviceCode: data.device_code,
  };
}

export async function traktPoll(deviceCode: string): Promise<string | null> {
  const { traktClientId, traktClientSecret } = await getSettings();
  if (!traktClientSecret) {
    throw new SyncError('Trakt needs a client secret for the device flow.');
  }

  const response = await fetch(`${TRAKT}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: deviceCode,
      client_id: traktClientId,
      client_secret: traktClientSecret,
    }),
  });

  // 400 is "still waiting" in this flow, not a failure.
  if (response.status === 400) return null;
  if (response.status === 409) throw new SyncError('That code was already used.');
  if (response.status === 410) throw new SyncError('The code expired. Start again.');
  if (!response.ok) return null;

  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function traktPush(items: HistoryItem[]): Promise<number> {
  const settings = await getSettings();
  const state = await db.syncState.get('trakt');
  if (!state?.accessToken) throw new SyncError('Not connected to Trakt.');

  const response = await fetch(`${TRAKT}/sync/history`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.accessToken}`,
      'trakt-api-version': '2',
      'trakt-api-key': settings.traktClientId ?? '',
    },
    body: JSON.stringify(toPayload(items)),
  });

  if (response.status === 401) throw new SyncError('Trakt rejected the token. Reconnect.');
  if (!response.ok) throw new SyncError(`Trakt sync failed (${response.status}).`);
  return items.length;
}

// ---------------------------------------------------------------------------
// Shared entry points
// ---------------------------------------------------------------------------

export async function saveToken(provider: SyncProvider, accessToken: string): Promise<void> {
  await db.syncState.put({ provider, accessToken });
}

export async function disconnect(provider: SyncProvider): Promise<void> {
  await db.syncState.delete(provider);
}

export async function isConnected(provider: SyncProvider): Promise<boolean> {
  const state = await db.syncState.get(provider);
  return Boolean(state?.accessToken);
}

/**
 * Push everything confirmed since the last successful sync.
 *
 * Both services de-duplicate on their side, but sending only what's new keeps
 * a large library from being re-uploaded on every run.
 */
export async function syncTo(provider: SyncProvider): Promise<number> {
  const state = await db.syncState.get(provider);
  const since = state?.lastSyncAt ?? 0;

  const all = await buildHistory();
  const fresh = all.filter((item) => new Date(item.watchedAt).getTime() > since);
  if (fresh.length === 0) return 0;

  const pushed = provider === 'simkl' ? await simklPush(fresh) : await traktPush(fresh);

  await db.syncState.put({ ...state, provider, lastSyncAt: Date.now() });
  return pushed;
}

export async function requestCode(provider: SyncProvider): Promise<DeviceCodeGrant> {
  return provider === 'simkl' ? simklRequestCode() : traktRequestCode();
}

export async function poll(
  provider: SyncProvider,
  deviceCode: string,
): Promise<string | null> {
  return provider === 'simkl' ? simklPoll(deviceCode) : traktPoll(deviceCode);
}
