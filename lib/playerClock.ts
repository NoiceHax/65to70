/**
 * Reading the player's own clock.
 *
 * `video.duration` is frequently NaN on streaming players and `seekable` is
 * often empty - yet the same player is displaying "1:23:45 / 2:14:30" on screen
 * the whole time. The runtime was never actually unavailable; it just wasn't
 * exposed through the API being asked.
 *
 * So this reads what the viewer can see. Two sources, in order of how much they
 * can be trusted:
 *
 *  1. The scrubber's ARIA values. Players expose it as a slider for keyboard
 *     and screen-reader users, and those numbers are the ones driving the UI -
 *     structured, unambiguous, and maintained because accessibility tooling
 *     depends on them.
 *  2. Rendered timestamps. Less reliable, since a page can contain other
 *     time-shaped text, but nearly universal.
 */

export interface PlayerClock {
  positionSec: number;
  durationSec: number;
  source: 'aria' | 'text';
}

/** "1:23:45" → 5025, "23:45" → 1425. Returns null for anything else. */
export function parseClock(text: string): number | null {
  const match = text.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** A runtime that could plausibly be a film or an episode. */
function plausibleRuntime(seconds: number): boolean {
  return seconds >= 300 && seconds <= 60 * 60 * 8;
}

/**
 * The scrubber, read through its accessibility attributes.
 *
 * Preferred because these values are what the control actually reports to
 * assistive technology - they have to be correct for the player to be usable
 * without sight, so they tend to be right even when the media element isn't.
 */
function fromAria(root: ParentNode): PlayerClock | null {
  const sliders = root.querySelectorAll(
    '[role="slider"][aria-valuemax], input[type="range"][max]',
  );

  for (const slider of Array.from(sliders)) {
    const max = Number(
      slider.getAttribute('aria-valuemax') ?? slider.getAttribute('max') ?? NaN,
    );
    const now = Number(
      slider.getAttribute('aria-valuenow') ?? slider.getAttribute('value') ?? NaN,
    );

    if (!Number.isFinite(max) || !Number.isFinite(now)) continue;
    if (!plausibleRuntime(max)) continue;
    if (now < 0 || now > max) continue;

    return { positionSec: now, durationSec: max, source: 'aria' };
  }

  return null;
}

/**
 * Rendered timestamps.
 *
 * Handles both shapes players use: elapsed and total together ("1:23:45 /
 * 2:14:30"), and elapsed alongside a countdown ("1:23:45" and "-0:50:45"),
 * where the runtime is the sum.
 */
function fromText(root: ParentNode): PlayerClock | null {
  const candidates = Array.from(root.querySelectorAll('span, div, time, p'))
    .map((element) => element.textContent?.trim() ?? '')
    // Long strings are prose that happens to contain a colon, not a clock.
    .filter((text) => text.length > 0 && text.length <= 24);

  for (const text of candidates) {
    const pair = text.match(
      /((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[/|·]\s*((?:\d{1,2}:)?\d{1,2}:\d{2})/,
    );
    if (!pair) continue;

    const position = parseClock(pair[1]);
    const duration = parseClock(pair[2]);
    if (position === null || duration === null) continue;
    if (!plausibleRuntime(duration) || position > duration) continue;

    return { positionSec: position, durationSec: duration, source: 'text' };
  }

  // Elapsed plus remaining, shown separately.
  let elapsed: number | null = null;
  let remaining: number | null = null;

  for (const text of candidates) {
    if (text.startsWith('-')) {
      remaining ??= parseClock(text.slice(1));
      continue;
    }
    elapsed ??= parseClock(text);
  }

  if (elapsed !== null && remaining !== null) {
    const duration = elapsed + remaining;
    if (plausibleRuntime(duration)) {
      return { positionSec: elapsed, durationSec: duration, source: 'text' };
    }
  }

  return null;
}

/**
 * What the player is showing the viewer.
 *
 * Returns null when nothing clock-shaped is on screen, which is the honest
 * answer - better than a number invented from a partial reading.
 */
export function readPlayerClock(root: ParentNode): PlayerClock | null {
  return fromAria(root) ?? fromText(root);
}
