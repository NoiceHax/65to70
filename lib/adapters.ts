import type { PageMetaResult } from './pageMeta';
import { seasonEpisodeFromUrl } from './urlIds';

/**
 * Tier 1 — per-platform readers.
 *
 * The premium services are the one place Tier 2 genuinely can't work. Netflix's
 * document title is just "Netflix" on every page, and Prime's is close to
 * useless, because neither has any reason to court search engines for content
 * they own. The title is in the player chrome instead.
 *
 * Each adapter emits an ordinary `PageMetaResult` with the `manual` strategy,
 * which outranks every generic source. Crucially it emits a *string* in a shape
 * the existing cleaner already understands ("Breaking Bad S1E2") rather than a
 * bespoke structure — so season and episode parsing, ranking and matching all
 * carry over unchanged.
 *
 * An adapter that returns null costs nothing: the generic cascade runs anyway.
 * That's the intended failure mode when a site redesigns.
 */

export interface SiteAdapter {
  id: string;
  matches(hostname: string): boolean;
  read(doc: Document, url: string): PageMetaResult | null;
}

function text(doc: Document, selector: string): string | null {
  const value = doc.querySelector(selector)?.textContent?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * An "S3 E12" label somewhere in the player chrome.
 *
 * Checked element by element rather than against the whole page's text.
 * Concatenated text nodes run together — "How I Met Your MotherS3 E12" — and a
 * word-boundary match then fails on the very case it was written for. Looking
 * at each element's own text sidesteps that and is more precise besides:
 * matching only short, label-shaped strings avoids picking a number out of a
 * synopsis.
 */
function findEpisodeMarker(doc: Document): { season: number; episode: number } | null {
  const pattern = /^S\s?(\d{1,2})\s*[·:•|-]?\s*E\s?(\d{1,3})\b/i;

  for (const element of Array.from(doc.querySelectorAll('span, div, p, h1, h2, h3'))) {
    const text = element.textContent?.trim();
    if (!text || text.length > 24) continue;

    const match = text.match(pattern);
    if (!match) continue;

    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (season >= 1 && season <= 50 && episode >= 1) return { season, episode };
  }

  return null;
}

/** Fold structured season/episode into the form cleanTitle already parses. */
function withEpisode(title: string, season?: number, episode?: number): string {
  if (season === undefined || episode === undefined) return title;
  return `${title} S${season}E${episode}`;
}

// ---------------------------------------------------------------------------
// Netflix
// ---------------------------------------------------------------------------

const netflix: SiteAdapter = {
  id: 'netflix',
  matches: (hostname) => /(^|\.)netflix\.com$/.test(hostname),

  read(doc, url) {
    // Only meaningful during playback; the browse pages have no single title.
    if (!/\/watch\/\d+/.test(url)) return null;

    const container = doc.querySelector('[data-uia="video-title"]');
    if (!container) return null;

    // Films render a bare title. Series render the show in an <h4> with the
    // season/episode and episode name in following spans.
    const series = container.querySelector('h4')?.textContent?.trim();
    const parts = Array.from(container.querySelectorAll('span'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);

    if (!series) {
      const film = container.textContent?.trim();
      return film ? { rawTitle: film, strategy: 'manual' } : null;
    }

    const marker = parts.find((part) => /^S\d+\s*:\s*E\d+/i.test(part));
    const match = marker?.match(/^S(\d+)\s*:\s*E(\d+)/i);

    return {
      rawTitle: withEpisode(
        series,
        match ? Number(match[1]) : undefined,
        match ? Number(match[2]) : undefined,
      ),
      strategy: 'manual',
    };
  },
};

// ---------------------------------------------------------------------------
// Prime Video
// ---------------------------------------------------------------------------

const primeVideo: SiteAdapter = {
  id: 'prime',
  matches: (hostname) =>
    /(^|\.)primevideo\.com$/.test(hostname) || /(^|\.)amazon\.[a-z.]+$/.test(hostname),

  read(doc) {
    const title =
      text(doc, '.atvwebplayersdk-title-text') ??
      text(doc, '[data-automation-id="title"]');
    if (!title) return null;

    // Series carry a subtitle like "S1 E2 - Episode Name".
    const subtitle = text(doc, '.atvwebplayersdk-subtitle-text');
    const match = subtitle?.match(/S(\d+)\s*[·:]?\s*E(\d+)/i);

    return {
      rawTitle: withEpisode(
        title,
        match ? Number(match[1]) : undefined,
        match ? Number(match[2]) : undefined,
      ),
      strategy: 'manual',
    };
  },
};

// ---------------------------------------------------------------------------
// JioHotstar
// ---------------------------------------------------------------------------

const hotstar: SiteAdapter = {
  id: 'hotstar',
  matches: (hostname) => /(^|\.)hotstar\.com$/.test(hostname),

  read(doc, url) {
    // Hotstar's watch URLs carry a readable slug, which survives even when the
    // player chrome hasn't rendered yet:
    //   /in/movies/inception/1260022016/watch
    const slugMatch = url.match(
      /\/(?:movies|shows|sports)\/([^/]+)\/\d+(?:\/\d+)*(?:\/watch)?/i,
    );

    const fromPlayer = text(doc, '.player-title') ?? text(doc, '[class*="title"]');
    const fromSlug = slugMatch
      ? decodeURIComponent(slugMatch[1]).replace(/[-_]+/g, ' ').trim()
      : null;

    const title = fromPlayer ?? fromSlug;
    if (!title || title.length < 2) return null;

    /*
     * Series need their episode, and this adapter never read one — so every
     * episode of a show resolved to the same title and the count never moved
     * off one.
     *
     * The URL is checked first because it survives the player chrome not having
     * rendered. Failing that, the page is scanned for an "S1 E3" marker, which
     * is how the player labels episodes.
     */
    const fromUrl = seasonEpisodeFromUrl(url);
    const marker = fromUrl ? null : findEpisodeMarker(doc);

    const season = fromUrl?.season ?? marker?.season;
    const episode = fromUrl?.episode ?? marker?.episode;

    return { rawTitle: withEpisode(title, season, episode), strategy: 'manual' };
  },
};

// ---------------------------------------------------------------------------
// JW Player
// ---------------------------------------------------------------------------

/**
 * Parse the player's secondary line — "2024 U/A 13+ 1h 46m".
 *
 * Carries the year and runtime, and for a series the episode, all in one
 * string. Worth reading properly: the runtime is authoritative where the media
 * element's is not, and the year separates a remake from its original.
 */
export function parseJwSecondary(text: string): {
  year?: number;
  runtimeMinutes?: number;
  season?: number;
  episode?: number;
} {
  const out: { year?: number; runtimeMinutes?: number; season?: number; episode?: number } = {};

  const year = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (year) out.year = Number(year[1]);

  const hoursAndMinutes = text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
  const minutesOnly = text.match(/\b(\d+)\s*m(?:in)?\b/i);

  if (hoursAndMinutes) {
    out.runtimeMinutes = Number(hoursAndMinutes[1]) * 60 + Number(hoursAndMinutes[2]);
  } else if (minutesOnly) {
    out.runtimeMinutes = Number(minutesOnly[1]);
  }

  /*
   * Several shapes, because the real one isn't known.
   *
   * The only sample available was a film, where this line reads "2024 U/A 13+
   * 1h 46m" and carries no episode at all. Rather than guess one format and
   * silently fail on the others, all the plausible ones are accepted — they're
   * distinctive enough not to collide with each other or with a runtime.
   */
  const episodePatterns = [
    /\bS(\d{1,2})\s*[·:•|-]?\s*E(\d{1,3})\b/i,
    /\bSeason\s+(\d{1,2})\s*[·:•|,-]?\s*Episode\s+(\d{1,3})\b/i,
    /\b(\d{1,2})\s*x\s*(\d{2,3})\b/,
  ];

  for (const pattern of episodePatterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (season < 1 || season > 50 || episode < 1) continue;

    out.season = season;
    out.episode = episode;
    break;
  }

  return out;
}

/**
 * JW Player, matched by its own DOM rather than by hostname.
 *
 * This is the most useful adapter in the set precisely because it isn't
 * site-specific. JW Player is a commercial player embedded across a great many
 * streaming sites, and its class names are stable and documented — so one
 * adapter covers every site that uses it, including ones nobody has looked at.
 *
 * It also solves the case that host adapters cannot: a single-page app that
 * never changes its URL, where the top frame only ever shows the home page and
 * the only truthful description of what's playing is inside the player.
 */
const jwPlayer: SiteAdapter = {
  id: 'jwplayer',
  // Presence is decided by the DOM in `read`, not the hostname.
  matches: () => true,

  read(doc) {
    const title = text(doc, '.jw-title-primary');
    if (!title) return null;

    const secondary = text(doc, '.jw-title-secondary');
    const parsed = secondary ? parseJwSecondary(secondary) : {};

    return {
      rawTitle: withEpisode(title, parsed.season, parsed.episode),
      strategy: 'manual',
      yearHint: parsed.year,
    };
  },
};

/**
 * Host adapters first, then player adapters.
 *
 * A host adapter knows the specific service and can be precise about it. A
 * player adapter is the fallback that generalises — it recognises the software
 * rather than the site, which is what makes it work on sites never seen before.
 */
const ADAPTERS: SiteAdapter[] = [netflix, primeVideo, hotstar];
const PLAYER_ADAPTERS: SiteAdapter[] = [jwPlayer];

export function adapterFor(hostname: string): SiteAdapter | null {
  return ADAPTERS.find((adapter) => adapter.matches(hostname)) ?? null;
}

function tryRead(adapter: SiteAdapter, doc: Document, url: string): PageMetaResult | null {
  try {
    return adapter.read(doc, url);
  } catch {
    // A site redesign must never take the extension down with it.
    return null;
  }
}

/** Read a Tier 1 title for this page, or null to fall through to Tier 2. */
export function readAdapterMeta(
  doc: Document,
  url: string,
  hostname: string,
): PageMetaResult | null {
  const host = adapterFor(hostname);
  if (host) {
    const found = tryRead(host, doc, url);
    if (found) return found;
  }

  // Then by player. Recognising the software rather than the site is what makes
  // this work on sites nobody has written an adapter for — and it is the only
  // thing that works when the page never changes its URL and the top frame
  // shows nothing but a home page.
  for (const adapter of PLAYER_ADAPTERS) {
    const found = tryRead(adapter, doc, url);
    if (found) return found;
  }

  return null;
}
