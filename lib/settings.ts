import { browser } from 'wxt/browser';

/**
 * User settings.
 *
 * Kept in `storage.local` rather than the database so the options page and the
 * background worker can both reach them without opening Dexie.
 */

export interface Settings {
  /**
   * TMDB API key (v3). Optional.
   *
   * Without it Keeper still tracks everything locally - detection, coverage,
   * sessions and the confirm queue all work offline. What it can't do is turn a
   * title into a canonical id, which is what sync and availability need.
   */
  tmdbApiKey?: string;

  /**
   * Whether titles may be sent to TMDB when local resolution fails.
   *
   * This is the one place the privacy promise has a seam, so it is off by
   * default and stated plainly in the options page. A lookup reveals to TMDB
   * that someone searched a title - not who, and not that it was watched.
   */
  allowNetworkResolve: boolean;

  /**
   * Origins never to run on, whatever else is granted.
   *
   * Tracking everything means tracking everything, and some of what people
   * watch they would not want named in a popup, listed in a queue, or sitting
   * in an export. Filtering after the fact is not good enough, because by then
   * the title has been read and shown.
   *
   * These are passed to the content script registration as exclusions, so
   * nothing of ours ever runs on them. There is no title to leak because none
   * is ever read.
   */
  excludedOrigins: string[];

  /**
   * Stop tracking entirely, without revoking anything.
   *
   * A quick switch for the times someone wants nothing recorded at all. Faster
   * and more obvious than un-ticking sites one at a time, and reversible.
   */
  trackingPaused: boolean;

  /** ISO country code, used for availability lookups. */
  region: string;

  /** ISO language for titles, so regional titles come back the way they appear. */
  language: string;

  /**
   * Tracker application credentials.
   *
   * Supplied by the user from their own registered app rather than baked into
   * the bundle. An extension is a public client - anything shipped inside it is
   * readable by anyone who installs it, so a shared secret would not be secret.
   * Trakt's device flow requires a secret at token exchange, which is why it
   * needs both fields; Simkl's PIN flow needs only the id.
   */
  simklClientId?: string;
  traktClientId?: string;
  traktClientSecret?: string;
}

const DEFAULTS: Settings = {
  allowNetworkResolve: false,
  excludedOrigins: [],
  trackingPaused: false,
  region: 'IN',
  language: 'en-US',
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return { ...DEFAULTS, ...((stored[KEY] as Partial<Settings>) ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export async function canResolveOnline(): Promise<boolean> {
  const settings = await getSettings();
  return Boolean(settings.tmdbApiKey) && settings.allowNetworkResolve;
}
