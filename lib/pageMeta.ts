import type { DetectionStrategy } from './types';

/**
 * Tier 2 — pulling a title out of an arbitrary page.
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
