/**
 * Run the Tier 2 detection pipeline against a live URL.
 *
 *   npm run probe -- https://example.com/watch/some-film
 *
 * Exists because the assumption M1 rests on - that long-tail streaming sites
 * leave their titles in the page markup because their traffic depends on it -
 * is an empirical claim about sites, not something unit tests can settle.
 * Point this at whatever sites you actually use and see what comes back.
 *
 * It fetches server-rendered HTML only. Sites that render titles client-side
 * will look emptier here than they do in a real browser, so a poor result is a
 * reason to check in the extension, not a verdict.
 */
import { Window } from 'happy-dom';
import { extractPageMeta, rankCandidates } from '../lib/pageMeta';
import { extractUrlIds } from '../lib/urlIds';
import { cleanTitle, isUsableTitle } from '../lib/titleClean';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probe(url: string): Promise<void> {
  console.log(`\n\x1b[1m${url}\x1b[0m`);

  // URL ids need no network, so they're reported before anything can fail.
  // On client-rendered sites they're often the only signal that survives.
  const urlIds = extractUrlIds(url);
  for (const id of urlIds) {
    const extra = id.season !== undefined ? ` S${id.season}E${id.episode}` : '';
    console.log(
      `  \x1b[36m${'url-id'.padEnd(15)} ${id.source}:${id.id}${extra}` +
        `  (${id.confidence}${id.mediaType ? `, ${id.mediaType}` : ''})\x1b[0m`,
    );
  }

  let html: string;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!response.ok) {
      console.log(`  page fetch failed: HTTP ${response.status}`);
      return;
    }
    html = await response.text();
  } catch (error) {
    console.log(`  page fetch failed: ${(error as Error).message}`);
    return;
  }

  const window = new Window({ url });
  window.document.documentElement.innerHTML = html;

  const hostname = new URL(url).hostname;
  const candidates = rankCandidates(
    extractPageMeta(window.document as unknown as Document, url),
    hostname,
  );

  if (candidates.length === 0 && urlIds.length === 0) {
    console.log('  nothing identifiable - Tier 3 would ask the user');
    return;
  }

  let best: string | null = null;

  for (const candidate of candidates) {
    const cleaned = cleanTitle(candidate.rawTitle);
    const usable = isUsableTitle(cleaned);
    if (usable && best === null) best = cleaned.title;

    const parts = [
      cleaned.title || '(empty)',
      cleaned.year ? `year=${cleaned.year}` : null,
      cleaned.season !== undefined ? `S${cleaned.season}E${cleaned.episode}` : null,
      usable ? null : '\x1b[2m(unusable)\x1b[0m',
    ].filter(Boolean);

    console.log(`  ${candidate.strategy.padEnd(15)} ${parts.join('  ')}`);
    console.log(`  ${''.padEnd(15)} \x1b[2mraw: ${candidate.rawTitle.slice(0, 90)}\x1b[0m`);
  }

  // A URL-borne id settles the match on its own once the resolver verifies it,
  // so it wins even when a plausible title is also present.
  const viaId = urlIds[0] ? `${urlIds[0].source}:${urlIds[0].id} (needs verifying)` : null;
  console.log(`  \x1b[32m→ would resolve via: ${viaId ?? best ?? '(nothing usable)'}\x1b[0m`);
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: npm run probe -- <url> [url...]');
  process.exit(1);
}

for (const url of urls) await probe(url);
