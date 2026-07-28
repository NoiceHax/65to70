/**
 * Build the per-region availability index.
 *
 *   TMDB_API_KEY=xxx npx vite-node pipeline/buildAvailability.ts -- IN
 *
 * TMDB publishes no bulk export of watch-provider data — the only route is to
 * ask `/discover` which titles each provider carries, one provider at a time.
 *
 * The awkward part is that `/discover` refuses to page past 500, so a provider
 * with more than 10,000 titles silently truncates. Sharding the query by
 * release year keeps every shard under the ceiling; any shard that still hits
 * it is reported rather than quietly dropped, because a truncated index looks
 * exactly like a complete one at runtime.
 *
 * Runs on your machine, never in the extension. The output is loaded through
 * the options page.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmdbApiKey } from '../scripts/env';

const API = 'https://api.themoviedb.org/3';
const MAX_PAGE = 500;
const FIRST_YEAR = 1950;
const LAST_YEAR = new Date().getFullYear() + 1;

const apiKey = tmdbApiKey();
const region = (process.argv[2] ?? 'IN').toUpperCase();

if (!apiKey) {
  console.error('No TMDB key. Put TMDB_API_KEY in .env, or set it in the environment.');
  process.exit(1);
}

interface ProviderInfo {
  provider_id: number;
  provider_name: string;
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('api_key', apiKey!);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url);
    if (response.status === 429) {
      // TMDB asks for a breather rather than refusing outright.
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
    return (await response.json()) as T;
  }
  throw new Error(`${path} → gave up after repeated rate limiting`);
}

async function flatrateProviders(): Promise<ProviderInfo[]> {
  const data = await getJson<{ results: ProviderInfo[] }>('/watch/providers/movie', {
    watch_region: region,
  });
  return data.results;
}

/** Every movie id one provider carries, sharded by year to dodge the page cap. */
async function idsForProvider(providerId: number): Promise<{ ids: number[]; truncated: number[] }> {
  const ids = new Set<number>();
  const truncated: number[] = [];

  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    let page = 1;
    let totalPages = 1;

    do {
      const data = await getJson<{
        page: number;
        total_pages: number;
        results: { id: number }[];
      }>('/discover/movie', {
        with_watch_providers: String(providerId),
        watch_region: region,
        watch_monetization_types: 'flatrate',
        primary_release_year: String(year),
        page: String(page),
      });

      for (const result of data.results) ids.add(result.id);
      totalPages = Math.min(data.total_pages, MAX_PAGE);

      if (data.total_pages > MAX_PAGE) {
        // One year on one provider exceeding 10,000 titles would need a finer
        // shard key. Report it — never let it pass as complete.
        if (!truncated.includes(year)) truncated.push(year);
      }
      page++;
    } while (page <= totalPages);
  }

  return { ids: [...ids], truncated };
}

async function main(): Promise<void> {
  console.log(`Building availability index for ${region}…`);

  const providers = await flatrateProviders();
  console.log(`  ${providers.length} providers in ${region}`);

  // A bitmask has 31 usable bits, so only the largest services get a slot.
  // Beyond that the tail is long and mostly irrelevant to any one viewer.
  const selected = providers.slice(0, 31);
  const providerOrder = selected.map((p) => String(p.provider_id));
  const titles: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [bit, provider] of selected.entries()) {
    process.stdout.write(`  ${provider.provider_name}… `);
    const { ids, truncated } = await idsForProvider(provider.provider_id);

    for (const id of ids) {
      titles[String(id)] = (titles[String(id)] ?? 0) | (1 << bit);
    }

    console.log(`${ids.length} titles`);
    if (truncated.length > 0) {
      warnings.push(`${provider.provider_name}: years ${truncated.join(', ')} hit the page cap`);
    }
  }

  const index = {
    region,
    generatedAt: new Date().toISOString(),
    providers: Object.fromEntries(selected.map((p) => [String(p.provider_id), p.provider_name])),
    providerOrder,
    titles,
  };

  const outPath = resolve(process.cwd(), `public/data/availability-${region}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index));

  console.log(`\nWrote ${Object.keys(titles).length} titles to ${outPath}`);
  if (warnings.length > 0) {
    console.warn('\nIncomplete coverage:');
    for (const warning of warnings) console.warn(`  ${warning}`);
  }
  console.log('\nLoad it through the extension options page.');
}

await main();
