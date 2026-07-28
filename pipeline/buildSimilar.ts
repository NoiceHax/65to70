/**
 * Build the offline similarity index.
 *
 *   npx vite-node pipeline/buildSimilar.ts -- 8000
 *
 * The point of doing this offline is that recommendations then cost nothing at
 * runtime and reveal nothing. A recommender that phones home with "here is
 * everything they have watched, what next?" is the one thing this project set
 * out not to build - so the relationships between films are computed here,
 * once, and shipped. Your library never leaves your machine; the model comes
 * to it.
 *
 * TMDB's recommendation lists are themselves derived from what large numbers of
 * people watch together, which is the collaborative signal that content-based
 * similarity alone can't reach. Using them as prepared data gets that quality
 * without collecting anything.
 *
 * Runs on your machine, never in the extension.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmdbApiKey } from '../scripts/env';
import { getJson } from '../scripts/http';

const API = 'https://api.themoviedb.org/3';
const CONCURRENCY = 20;
/** Beyond this the tail adds size without adding useful signal. */
const KEEP_PER_TITLE = 15;

const apiKey = tmdbApiKey();
const limit = Number(process.argv[2] ?? 8000);

if (!apiKey) {
  console.error('No TMDB key. Put TMDB_API_KEY in .env, or set it in the environment.');
  process.exit(1);
}

interface IndexEntry {
  i: number;
  t: string;
  y?: number;
}

/**
 * Seed from the title index, so the two stay aligned and this doesn't
 * re-download the full export.
 */
function seedTitles(): IndexEntry[] {
  const path = resolve(process.cwd(), 'public/data/titles.json');
  if (!existsSync(path)) {
    console.error('Build the title index first - this seeds from it.');
    process.exit(1);
  }

  const stored = JSON.parse(readFileSync(path, 'utf8')) as { entries: IndexEntry[] };
  // The export is already popularity-ordered, so the head is the part worth
  // having relationships for.
  return stored.entries.slice(0, limit);
}

interface Recommendation {
  id: number;
  title: string;
  release_date?: string;
}

/** Requests lost after their retries were spent. Reported, never hidden. */
let dropped = 0;

async function recommendationsFor(id: number): Promise<Recommendation[]> {
  const url = new URL(`${API}/movie/${id}/recommendations`);
  url.searchParams.set('api_key', apiKey!);

  const data = await getJson<{ results?: Recommendation[] }>(url, { retries: 4 });
  if (!data) {
    dropped++;
    return [];
  }

  return (data.results ?? []).slice(0, KEEP_PER_TITLE);
}

async function main(): Promise<void> {
  const seeds = seedTitles();
  console.log(`Fetching relationships for ${seeds.length} titles…`);

  const similar: Record<string, number[]> = {};
  const titles: Record<string, { t: string; y?: number }> = {};

  for (const seed of seeds) {
    titles[String(seed.i)] = { t: seed.t, y: seed.y };
  }

  let done = 0;

  for (let i = 0; i < seeds.length; i += CONCURRENCY) {
    const batch = seeds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (seed) => ({ seed, recs: await recommendationsFor(seed.i) })),
    );

    for (const { seed, recs } of results) {
      if (recs.length === 0) continue;
      similar[String(seed.i)] = recs.map((rec) => rec.id);

      // Keep display details for anything reachable, including titles outside
      // the seed set - otherwise a recommendation arrives with no name.
      for (const rec of recs) {
        const key = String(rec.id);
        if (titles[key]) continue;
        const year = rec.release_date ? Number(rec.release_date.slice(0, 4)) : undefined;
        titles[key] = { t: rec.title, y: Number.isFinite(year) ? year : undefined };
      }
    }

    done += batch.length;
    if (done % 500 < CONCURRENCY) process.stdout.write(`\r  ${done}/${seeds.length}`);
  }

  const outPath = resolve(process.cwd(), 'public/data/similar.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), titles, similar }),
  );

  console.log(
    `\nWrote ${Object.keys(similar).length} relationship lists ` +
      `covering ${Object.keys(titles).length} titles to ${outPath}`,
  );
  if (dropped > 0) console.warn(`${dropped} request(s) failed after retries - re-run to fill the gaps.`);
  console.log('Rebuild the extension (npm run build) - it loads this itself.');
}

await main();
