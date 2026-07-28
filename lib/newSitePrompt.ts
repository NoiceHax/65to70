import { browser } from 'wxt/browser';
import { grantedOrigins, hasAllSites, originPatternFor } from './permissions';

/**
 * Noticing a streaming site that Keeper is not allowed to run on.
 *
 * This cannot be an in-page prompt. If a site has not been granted then no
 * content script of ours runs there, so there is nothing of ours in the page to
 * draw with. The background can still see the tab's address through the `tabs`
 * permission, which is enough to notice and say so.
 *
 * A system notification is the only surface available, and it lands in the same
 * corner as the in-page prompt on Windows, so the two read as one thing.
 */

/** Paths that suggest something is being watched rather than browsed. */
const WATCH_PATH = /\/(watch|movie|movies|film|tv|series|show|episode|play|embed)(\/|\?|$)/i;

/** Prompted origins, so a site is mentioned once and then left alone. */
const PROMPTED_KEY = 'promptedOrigins';

async function alreadyPrompted(origin: string): Promise<boolean> {
  const stored = await browser.storage.session.get(PROMPTED_KEY);
  return ((stored[PROMPTED_KEY] as string[]) ?? []).includes(origin);
}

async function rememberPrompted(origin: string): Promise<void> {
  const stored = await browser.storage.session.get(PROMPTED_KEY);
  const seen = (stored[PROMPTED_KEY] as string[]) ?? [];
  await browser.storage.session.set({ [PROMPTED_KEY]: [...seen, origin].slice(-50) });
}

function looksLikeStreaming(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (WATCH_PATH.test(parsed.pathname)) return true;
    return parsed.searchParams.has('play') || parsed.searchParams.has('v');
  } catch {
    return false;
  }
}

/**
 * Offer to start tracking a site, once.
 *
 * Deliberately quiet. It only speaks for a page that looks like playback, only
 * for a site not already granted, and only the first time that site is seen in
 * a browser session. Prompting on every navigation would train the user to
 * dismiss it without reading, which is how unwanted permissions get granted.
 */
export async function maybePromptForSite(url: string): Promise<void> {
  if (!looksLikeStreaming(url)) return;

  // Nothing to ask for when everything is already covered.
  if (await hasAllSites()) return;

  const origin = originPatternFor(url);
  if (!origin) return;

  const granted = await grantedOrigins();
  if (granted.includes(origin)) return;
  if (await alreadyPrompted(origin)) return;

  await rememberPrompted(origin);

  let hostname = origin;
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* keep the pattern as a fallback */
  }

  try {
    await browser.notifications.create(`keeper-site:${origin}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: `Not tracking ${hostname}`,
      message: 'Open Keeper and turn this site on to track what you watch here.',
      priority: 0,
    });
  } catch {
    // Notifications can be disabled at the OS level. The badge below still
    // carries the signal, so this is not worth surfacing as an error.
  }

  // A quiet marker for anyone who has notifications switched off.
  try {
    await browser.action.setBadgeText({ text: '?' });
    await browser.action.setBadgeBackgroundColor({ color: '#f5a623' });
  } catch {
    /* badge APIs are unavailable in some contexts */
  }
}
