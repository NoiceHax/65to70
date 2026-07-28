import type { MediaType } from './types';

/**
 * Turning a page title into something matchable.
 *
 * Real inputs look like:
 *   "Watch Inception (2010) Online Free HD - SiteName"
 *   "Mission: Impossible - Fallout | Watch Online Free"
 *   "Breaking Bad S01E02 - Cat's in the Bag... | SiteName"
 *
 * Two rules do most of the work and are worth stating because they're the
 * non-obvious part:
 *
 *  1. Don't just take the first segment before a separator. "Mission:
 *     Impossible - Fallout" would lose half its title. Instead drop segments
 *     that are *entirely* noise and rejoin what's left.
 *
 *  2. A parenthesised year or an SxxExx marker is a hard boundary - everything
 *     before it is the title. This is far more reliable than word-stripping,
 *     so it runs first when present.
 */

export interface CleanedTitle {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  mediaType: MediaType;
}

/**
 * Noise comes in two strengths, and conflating them breaks real titles.
 *
 * STRONG words never occur at the end of a genuine title, so a trailing run of
 * them can be removed outright.
 *
 * WEAK words are common in page-title padding but also occur in real titles -
 * "The Lego Movie", "Apocalypse Now", "The Final Cut". They're only ever used
 * to decide whether an entire separator-delimited segment is junk; they are
 * never stripped off the end of a title. Losing "Movie" from "The Lego Movie"
 * is a worse failure than leaving "Full Movie" on the end of "Inception",
 * because the fuzzy resolver shrugs off trailing padding but cannot recover a
 * word that was deleted.
 *
 * Nothing is ever stripped from the *front* except an explicit leading "watch",
 * or "Free Guy" and "Full Metal Jacket" would lose their first word.
 */
const STRONG_NOISE = new Set([
  'watch',
  'online',
  'free',
  'hd',
  'stream',
  'streaming',
  'download',
  'subtitles',
  'subtitle',
  'subbed',
  'dubbed',
  'bluray',
  'blueray',
  'brrip',
  'webrip',
  'webdl',
  'hdrip',
  'dvdrip',
  'dvdscr',
  'camrip',
  'quality',
  'dual',
  'audio',
  '1080p',
  '720p',
  '480p',
  '360p',
  '2160p',
  '4k',
  'uhd',
  'x264',
  'x265',
  'hevc',
  'aac',
  'ac3',
  'mkv',
  'mp4',
  'putlocker',
  'putlockers',
  'gomovies',
  'fmovies',
  '123movies',
  'primewire',
  'vidcloud',
  'soap2day',
]);

const WEAK_NOISE = new Set([
  'full',
  'movie',
  'movies',
  'film',
  'sub',
  'cam',
  'print',
  'now',
  'here',
  'and',
  'in',
  'with',
  'on',
  'the',
  'a',
]);

// These dash characters are data, not prose: sites really do write
// "Inception — 2010" in a page title, so the separator has to match them.
const SEPARATOR = /\s+[|–—»·]\s+|\s+-\s+/;

const SE_PATTERNS: RegExp[] = [
  /\bS(\d{1,2})\s*[·:]?\s*E(\d{1,3})\b/i,
  /\bSeason\s+(\d{1,2})\s*(?:,|-|–|:)?\s*Episode\s+(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/,
];

const YEAR_IN_PARENS = /[([](\d{4})[)\]]/;
const BARE_YEAR = /\b(19\d{2}|20\d{2})\b/;

const MIN_YEAR = 1888;
const MAX_YEAR = new Date().getFullYear() + 2;

/**
 * Unicode-aware on purpose. Stripping to `[a-z0-9]` would reduce any
 * non-Latin title - Devanagari, Tamil, Japanese - to an empty string, which
 * the noise checks below would then read as pure padding and discard. Regional
 * titles are a first-class case, not an edge case.
 */
function normalizeWord(word: string): string {
  // \p{M} is kept for the same reason as in lib/match.ts: Indic vowel signs are
  // combining marks, and dropping them mangles the word rather than tidying it.
  return word.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

function isStrongNoise(word: string): boolean {
  const w = normalizeWord(word);
  return w.length === 0 || STRONG_NOISE.has(w);
}

function isAnyNoise(word: string): boolean {
  const w = normalizeWord(word);
  return w.length === 0 || STRONG_NOISE.has(w) || WEAK_NOISE.has(w);
}

/** A segment is dropped only when every one of its words is noise of some kind. */
function isNoiseSegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every(isAnyNoise);
}

function validYear(n: number): boolean {
  return n >= MIN_YEAR && n <= MAX_YEAR;
}

/**
 * Remove a trailing run of STRONG noise. Stops at the first word that could
 * plausibly belong to the title - including weak-noise words, which is what
 * keeps "The Lego Movie" and "Apocalypse Now" intact.
 */
function stripTrailingNoise(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  while (words.length > 1 && isStrongNoise(words[words.length - 1])) {
    words.pop();
  }
  return words.join(' ');
}

function tidy(text: string): string {
  return text
    .replace(/[[({][^\])}]*[\])}]/g, ' ') // leftover bracketed junk
    .replace(/[\s.\-–—_:|,]+$/g, '')
    .replace(/^[\s.\-–—_:|,]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function cleanTitle(raw: string): CleanedTitle {
  const input = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!input) return { title: '', mediaType: 'movie' };

  // 1. Drop segments that are entirely noise, keep the rest in order.
  const segments = input.split(SEPARATOR).filter((s) => s.trim().length > 0);
  const kept = segments.filter((s) => !isNoiseSegment(s));
  let text = (kept.length > 0 ? kept : segments).join(' - ');

  let season: number | undefined;
  let episode: number | undefined;
  let year: number | undefined;

  // 2. An SxxExx marker is a hard boundary: the show name precedes it, and
  //    whatever follows is the episode title, which we don't want.
  for (const pattern of SE_PATTERNS) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;

    const s = Number(match[1]);
    const e = Number(match[2]);
    // Guard against matching a resolution like "4x1080".
    if (s < 1 || s > 50 || e < 1 || e > 999) continue;

    season = s;
    episode = e;
    text = text.slice(0, match.index);
    break;
  }

  // 3. A parenthesised year is the other hard boundary.
  const parenYear = text.match(YEAR_IN_PARENS);
  if (parenYear && parenYear.index !== undefined && validYear(Number(parenYear[1]))) {
    year = Number(parenYear[1]);
    text = text.slice(0, parenYear.index);
  }

  // 4. Leading "watch" is the one front-of-string strip that's always safe.
  text = text.replace(/^\s*watch\s+/i, '');

  text = tidy(text);

  // 5. Only now consider a bare year, and only if it isn't the whole title
  //    (e.g. the films "1917" and "2012" must survive).
  if (year === undefined) {
    const bare = text.match(BARE_YEAR);
    if (bare && bare.index !== undefined && validYear(Number(bare[1]))) {
      const withoutYear = tidy(text.replace(bare[0], ' '));
      if (withoutYear.length > 0) {
        year = Number(bare[1]);
        text = withoutYear;
      }
    }
  }

  text = tidy(stripTrailingNoise(text));

  return {
    title: text,
    year,
    season,
    episode,
    mediaType: season !== undefined ? 'tv' : 'movie',
  };
}

/**
 * Whether a cleaned title is worth acting on at all. Guards against pages
 * whose title is just the site name ("Netflix", "Home").
 */
export function isUsableTitle(cleaned: CleanedTitle): boolean {
  const t = cleaned.title;
  if (t.length < 2) return false;
  if (/^(home|index|watch|player|video|login|sign in|browse|search)$/i.test(t)) return false;

  /*
   * Marketing taglines, not titles.
   *
   * A landing page announces itself with a list - "Watch TV Shows, Movies,
   * Specials, Live Cricket & Football". Three or more commas is the giveaway:
   * real titles almost never reach that. Two is deliberately allowed, because
   * films like "Sex, Lies, and Videotape" exist and losing one is worse than
   * letting the odd tagline through to the resolver, which rejects it anyway.
   */
  if ((t.match(/,/g) ?? []).length >= 3) return false;
  if (t.length > 90) return false;

  // Whatever survived cleaning is still just padding - e.g. "Watch Now"
  // reduces to "Now", which is a real film but not a real detection here.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.every(isAnyNoise)) return false;

  return true;
}
