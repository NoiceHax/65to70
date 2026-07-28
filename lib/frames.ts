import { browser } from 'wxt/browser';
import type { EmbeddedFrame } from './messages';

/**
 * Working out which origin actually holds the player.
 *
 * The obvious approach — reading iframe `src` attributes from the page — is
 * wrong in the case that matters. Embed hosts redirect: the markup says
 * `player.videasy.net`, the frame lands on `player.videasy.to`, and a
 * permission granted for the first never reaches the second. The page can't
 * see through that, because a cross-origin frame's real location is off limits
 * to it.
 *
 * `webNavigation.getAllFrames` reports where each frame currently *is*, after
 * every redirect, for the whole tree. That makes it the only reliable source
 * for "which origin do we still need", so it takes priority over anything the
 * content script reports.
 */

/** URL shapes that identify a video embed rather than an advert. */
export const PLAYER_URL =
  /player|embed|stream|video|watch|vidsrc|videasy|megacloud|filemoon|vidlink|autoembed/i;

/**
 * Cross-origin frames currently loaded in a tab.
 *
 * Returns an empty list rather than throwing when the permission is missing or
 * the tab is gone — this feeds a diagnostics panel, and a diagnostic that
 * breaks when things go wrong is worthless.
 */
export async function liveFramesForTab(tabId: number): Promise<EmbeddedFrame[]> {
  let frames: { frameId: number; parentFrameId: number; url: string }[];
  try {
    frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
  } catch {
    return [];
  }

  const top = frames.find((frame) => frame.frameId === 0);
  if (!top) return [];

  let topOrigin: string;
  try {
    topOrigin = new URL(top.url).origin;
  } catch {
    return [];
  }

  const found = new Map<string, boolean>();

  for (const frame of frames) {
    if (frame.frameId === 0) continue;

    try {
      const { origin, protocol, href } = new URL(frame.url);
      if (protocol !== 'http:' && protocol !== 'https:') continue;
      if (origin === topOrigin) continue;

      const likelyPlayer = PLAYER_URL.test(href);
      found.set(origin, (found.get(origin) ?? false) || likelyPlayer);
    } catch {
      // about:blank and friends carry nothing to grant.
    }
  }

  return [...found].map(([origin, likelyPlayer]) => ({ origin, likelyPlayer }));
}
