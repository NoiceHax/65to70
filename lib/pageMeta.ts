import type { DetectionStrategy } from './types';

/**
 * Tier 2 - pulling a title out of an arbitrary page.
 *
 * The premise this relies on: long-tail streaming sites do not strip metadata.
 * They can't afford to. Their traffic comes from ranking for "watch <film>
 * online free", so `og:title`, JSON-LD and the H1 are stuffed with the title by
 * commercial necessity. That's what makes a generic detector viable on sites
 * nobody has written an adapter for.
 *
 * Takes a Document so it can be tested without a browser.
 */

export interface PageMetaResult {
  rawTitle: string;
  strategy: DetectionStrategy;
  /** Structured-data year, when the page provided one. */
  yearHint?: number;
  /**
   * Season and episode, when a source stated them outright.
   *
   * Separate from the title string because they aren't always both knowable.
   * One player names the episode but only the *number of seasons* - so the
   * episode is certain and the season isn't, which a "Show S1E9" string cannot
   * express without inventing the part it doesn't know.
   */
  season?: number;
  episode?: number;
}

const SCHEMA_TYPES = new Set([
  'Movie',
  'TVEpisode',
  'TVSeries',
  'TVSeason',
  'VideoObject',
  'CreativeWork',
]);

function yearFrom(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

/** Walk a JSON-LD blob, which may be a single node, an array, or an @graph. */
function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  out.push(node);
  if ('@graph' in node) collectNodes(node['@graph'], out);
}

function fromJsonLd(doc: Document): PageMetaResult | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');

  for (const script of Array.from(scripts)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue; // Malformed JSON-LD is common; just move on.
    }

    const nodes: Record<string, unknown>[] = [];
    collectNodes(parsed, nodes);

    for (const node of nodes) {
      const rawType = node['@type'];
      const types = Array.isArray(rawType) ? rawType : [rawType];
      if (!types.some((t) => typeof t === 'string' && SCHEMA_TYPES.has(t))) continue;

      const name = node.name ?? node.headline;
      if (typeof name !== 'string' || name.trim().length === 0) continue;

      return {
        rawTitle: name.trim(),
        strategy: 'jsonld',
        yearHint:
          yearFrom(node.datePublished) ??
          yearFrom(node.dateCreated) ??
          yearFrom(node.copyrightYear as string),
      };
    }
  }

  return null;
}

function fromOpenGraph(doc: Document): PageMetaResult | null {
  const el =
    doc.querySelector('meta[property="og:title"]') ??
    doc.querySelector('meta[name="og:title"]') ??
    doc.querySelector('meta[name="twitter:title"]');

  const content = el?.getAttribute('content')?.trim();
  if (!content) return null;
  return { rawTitle: content, strategy: 'og' };
}

function fromHeading(doc: Document): PageMetaResult | null {
  const h1 = doc.querySelector('h1');
  const text = h1?.textContent?.trim();
  if (!text || text.length > 200) return null;
  return { rawTitle: text, strategy: 'h1' };
}

function fromDocumentTitle(doc: Document): PageMetaResult | null {
  const text = doc.title?.trim();
  if (!text) return null;
  return { rawTitle: text, strategy: 'document-title' };
}

function fromBreadcrumb(doc: Document): PageMetaResult | null {
  const items = doc.querySelectorAll(
    '[itemtype*="BreadcrumbList"] [itemprop="name"], nav[aria-label*="readcrumb" i] li',
  );
  const last = items[items.length - 1];
  const text = last?.textContent?.trim();
  if (!text) return null;
  return { rawTitle: text, strategy: 'breadcrumb' };
}

function fromSlug(url: string): PageMetaResult | null {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    // Trailing numeric ids and "watch" segments carry no title information.
    let slug = segments[segments.length - 1];
    if (/^\d+$/.test(slug) && segments.length > 1) slug = segments[segments.length - 2];
    if (/^(watch|player|video|embed)$/i.test(slug) && segments.length > 1) {
      slug = segments[segments.length - 2];
    }

    let text = decodeURIComponent(slug)
      .replace(/\.(html?|php)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim();

    // Many sites glue a catalogue id to the slug ("27205-inception"). Five
    // digits or more, so four-digit titles like "1917" and "2012" survive.
    for (const pattern of [/^\d{5,}\s+/, /\s+\d{5,}$/]) {
      const stripped = text.replace(pattern, '').trim();
      if (stripped.length >= 2) text = stripped;
    }

    if (text.length < 2) return null;
    return { rawTitle: text, strategy: 'slug' };
  } catch {
    return null;
  }
}

/**
 * Best available title for the page, most-structured source first.
 *
 * Returns every candidate rather than just the winner: a single page often has
 * a clean H1 and a keyword-stuffed `og:title`, and which one survives cleaning
 * better isn't knowable here. The resolver scores them all and takes the best.
 */
export function extractPageMeta(doc: Document, url: string): PageMetaResult[] {
  const candidates = [
    fromJsonLd(doc),
    fromOpenGraph(doc),
    fromHeading(doc),
    fromDocumentTitle(doc),
    fromBreadcrumb(doc),
    fromSlug(url),
  ];

  const seen = new Set<string>();
  const out: PageMetaResult[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.rawTitle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How much each source is worth before penalties.
 *
 * `document-title` outranks `og:title`, which is the opposite of what the
 * discovery order suggests, and it's deliberate. On a client-rendered site the
 * `og:title` is baked into the shell at build time and never updates - it says
 * "Cineby" on every page - while `document.title` is rewritten by the app to
 * the actual title. On server-rendered sites the two are usually identical, so
 * promoting `document.title` costs nothing there and rescues the SPA case.
 */
const STRATEGY_WEIGHT: Record<DetectionStrategy, number> = {
  manual: 120,
  jsonld: 100,
  'document-title': 80,
  og: 78,
  h1: 60,
  breadcrumb: 40,
  slug: 30,
};

const GENERIC_DOMAIN_PARTS = new Set([
  'www', 'com', 'net', 'org', 'co', 'io', 'tv', 'me', 'to', 'cc', 'xyz', 'so',
  'app', 'site', 'online', 'stream', 'watch', 'movies', 'ru', 'in', 'uk', 'is',
]);

/**
 * Whether the page is showing something episodic.
 *
 * Controls give it away long before any title does: an episode list, a next
 * episode button, a season picker. A film page has none of them, so their
 * presence is a strong signal on its own - and it is available even when the
 * URL carries no id and the title says nothing about seasons.
 *
 * Worth having because the alternative is guessing, and guessing film when
 * something is a series is how one id resolved to an entirely unrelated title.
 */
const SERIES_CONTROL = /^(episodes?|next episode|episode list|episode selector|seasons?)$/i;

export function looksLikeSeries(root: ParentNode): boolean {
  const controls = root.querySelectorAll(
    'button, a, [role="button"], [role="tab"], h2, h3, span, div',
  );

  for (const control of Array.from(controls)) {
    const label = control.getAttribute('aria-label') ?? control.textContent ?? '';
    const text = label.trim();
    // Short strings only: a synopsis mentioning episodes is not a control.
    if (text.length > 0 && text.length <= 20 && SERIES_CONTROL.test(text)) return true;
  }

  return false;
}

/** Same separators the cleaner splits on, so both agree what a segment is. */
const SEGMENT = /\s+[|–—»·]\s+|\s+-\s+/;

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Brand words derived from the hostname - "cineby.cc" yields {cineby}. */
export function brandTokens(hostname: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of hostname.toLowerCase().split('.')) {
    if (!part || GENERIC_DOMAIN_PARTS.has(part)) continue;
    tokens.add(part);
  }
  return tokens;
}

/**
 * Remove the site's own name from a page title.
 *
 * Almost every site appends it - "Adarsh Baal Vidyalaya - Cineby" - and
 * carrying it into matching costs accuracy for no benefit, since a catalogue
 * has never heard of the site. Ranking already rejects a title that is nothing
 * but the brand; this handles the far more common case where the brand is one
 * segment alongside the real answer.
 *
 * Only whole segments are removed, never words inside one, so a film whose
 * title happens to contain the site's name survives intact.
 */
export function stripBrand(rawTitle: string, hostname: string): string {
  const brands = brandTokens(hostname);
  if (brands.size === 0) return rawTitle;

  const segments = rawTitle.split(SEGMENT).filter((segment) => segment.trim().length > 0);
  if (segments.length < 2) return rawTitle;

  const kept = segments.filter((segment) => {
    const normalized = normalizeForCompare(segment);
    for (const brand of brands) {
      if (normalized === brand) return false;
      // "Prime Video" against the brand "primevideo", or "Cineby.cc" against
      // "cineby": a segment that is the brand plus a little decoration.
      if (normalized.includes(brand) && normalized.length <= brand.length + 6) return false;
    }
    return true;
  });

  return kept.length > 0 ? kept.join(' - ') : rawTitle;
}

function scoreCandidate(candidate: PageMetaResult, brands: Set<string>): number {
  let score = STRATEGY_WEIGHT[candidate.strategy] ?? 0;
  const normalized = normalizeForCompare(candidate.rawTitle);

  // The site's own name is never what's playing. This is what made a
  // client-rendered site report "Cineby" as the film.
  if (brands.has(normalized)) return -1000;
  for (const brand of brands) {
    if (brand.length < 4) continue;

    if (normalized.length <= brand.length + 4 && normalized.includes(brand)) {
      score -= 500;
      continue;
    }

    // A title that opens with the site's own name is the landing page
    // announcing itself - "JioHotstar - Watch TV Shows, Movies, ...". Heavily
    // penalised rather than rejected outright, since a show can legitimately
    // carry a service's name ("Hotstar Specials: ...").
    if (normalized.startsWith(brand)) score -= 400;
  }

  if (/\b(19\d{2}|20\d{2})\b/.test(candidate.rawTitle)) score += 15;
  if (/\bS\d{1,2}\s*E\d{1,3}\b/i.test(candidate.rawTitle)) score += 10;
  if (candidate.yearHint !== undefined) score += 10;
  if (normalized.length < 3) score -= 50;

  return score;
}

/**
 * Order candidates by how likely they are to be the thing being watched.
 *
 * Ranking rather than taking the first hit matters because the most structured
 * source isn't always the most truthful one.
 */
export function rankCandidates(
  candidates: PageMetaResult[],
  hostname: string,
): PageMetaResult[] {
  const brands = brandTokens(hostname);
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(candidate, brands) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}
