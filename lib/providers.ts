import { db } from './db';
import { getSettings } from './settings';

/**
 * Where a title can actually be watched.
 *
 * TMDB publishes no bulk export of watch-provider data, so this index is built
 * offline by paging `/discover` per provider (see pipeline/buildAvailability.ts)
 * and loaded here as a prepared file.
 *
 * Two consequences worth spelling out:
 *
 *  - It is stored per region and only the user's own region is ever loaded.
 *    Availability is regional, so a global index would be mostly dead weight.
 *  - It is loaded at runtime rather than bundled. Bundling would mean every
 *    weekly data refresh needs a store re-review, and would put the whole
 *    catalogue on disk for people who only care about one country.
 */

export interface AvailabilityIndex {
  region: string;
  generatedAt: string;
  /** Provider id → display name, e.g. { "8": "Netflix" }. */
  providers: Record<string, string>;
  /**
   * TMDB id → bitmask over `providerOrder`. A bitmask rather than a list keeps
   * a 50k-title index small enough to hold in memory comfortably.
   */
  titles: Record<string, number>;
  /** Provider ids in bit order, least significant bit first. */
  providerOrder: string[];
}

const metaKey = (region: string) => `availability:${region}`;

let cached: AvailabilityIndex | null = null;

export async function saveAvailabilityIndex(index: AvailabilityIndex): Promise<void> {
  await db.meta.put({ key: metaKey(index.region), value: index });
  cached = index;
}

export async function loadAvailabilityIndex(): Promise<AvailabilityIndex | null> {
  const { region } = await getSettings();
  if (cached?.region === region) return cached;

  const entry = await db.meta.get(metaKey(region));
  cached = (entry?.value as AvailabilityIndex) ?? null;
  return cached;
}

export async function clearAvailabilityIndex(region: string): Promise<void> {
  await db.meta.delete(metaKey(region));
  if (cached?.region === region) cached = null;
}

/** Streaming services carrying this title in the user's region. */
export async function providersFor(tmdbId: number): Promise<string[]> {
  const index = await loadAvailabilityIndex();
  if (!index) return [];

  const mask = index.titles[String(tmdbId)];
  if (!mask) return [];

  const names: string[] = [];
  index.providerOrder.forEach((providerId, bit) => {
    if (mask & (1 << bit)) names.push(index.providers[providerId] ?? providerId);
  });
  return names;
}

/** Batch lookup, so a list view doesn't re-read the index per row. */
export async function providersForMany(
  tmdbIds: number[],
): Promise<Map<number, string[]>> {
  const index = await loadAvailabilityIndex();
  const out = new Map<number, string[]>();
  if (!index) return out;

  for (const tmdbId of tmdbIds) {
    const mask = index.titles[String(tmdbId)];
    if (!mask) continue;

    const names: string[] = [];
    index.providerOrder.forEach((providerId, bit) => {
      if (mask & (1 << bit)) names.push(index.providers[providerId] ?? providerId);
    });
    if (names.length > 0) out.set(tmdbId, names);
  }

  return out;
}

export async function availabilityStatus(): Promise<{
  loaded: boolean;
  region: string;
  titles: number;
  generatedAt?: string;
}> {
  const { region } = await getSettings();
  const index = await loadAvailabilityIndex();

  return {
    loaded: index !== null,
    region,
    titles: index ? Object.keys(index.titles).length : 0,
    generatedAt: index?.generatedAt,
  };
}
