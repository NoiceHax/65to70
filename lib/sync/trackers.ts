import { db } from '../db';
import { getSettings } from '../settings';
import type { Movie, Session, SyncProvider } from '../types';

/**
 * Pushing confirmed history to Simkl and Trakt.
 *
 * Both use a device/PIN flow rather than a redirect flow. A browser extension
 * is a public client — anything in the bundle is readable by anyone who
 * installs it — so there is nowhere safe to keep a shared secret. Device flow
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

    const dates =
      complete.length > 0
        ? complete.map((s) => new Date(s.stoppedAt ?? s.lastSeenAt).toISOString())
        : [new Date(movie.lastConfirmed ?? Date.now()).toISOString()];

    for (const watchedAt of dates) {
      items.push({
        title: movie.title,
        year: movie.year,
        tmdbId: movie.tmdbId,
        imdbId: movie.imdbId,
        mediaType: movie.mediaType,
        watchedAt,
      });
    }
  }

  return items;
}

function toPayload(items: HistoryItem[]) {
  const entry = (item: HistoryItem) => ({
    title: item.title,
    year: item.year,
    ids: { tmdb: item.tmdbId, ...(item.imdbId ? { imdb: item.imdbId } : {}) },
    watched_at: item.watchedAt,
  });

  return {
    movies: items.filter((i) => i.mediaType === 'movie').map(entry),
    shows: items.filter((i) => i.mediaType === 'tv').map(entry),
  };
}

// ---------------------------------------------------------------------------
// Simkl — PIN flow
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
// Trakt — device flow
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
