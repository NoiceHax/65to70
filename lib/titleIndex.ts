import { db } from './db';
import { normalizeTitle } from './match';
import type { TmdbTitle } from './tmdb';

/**
 * Offline title lookup.
 *
 * The point of this index is that the common case never leaves the machine. A
 * naive resolver asks TMDB for every detection, which hands them the title of
 * everything you watch. With the index loaded, popular titles resolve locally
 * and the network is only touched for the long tail - and only with consent.
 *
 * Aliases matter more than they look: sites serve titles in the viewer's
 * language, so a Hindi or Tamil rendering of a film is an ordinary input here.
 * The index carries alternative and localised titles for exactly that reason.
 */

interface IndexEntry {
  i: number;
  t: string;
  y?: number;
  r?: number;
  a?: string[];
}

interface StoredIndex {
  generatedAt: string;
  entries: IndexEntry[];
}

const META_KEY = 'titleIndex';

/** Built lazily and kept for the worker's lifetime. */
let lookup: Map<string, IndexEntry[]> | null = null;
let loadedAt: string | null = null;

function addKey(map: Map<string, IndexEntry[]>, title: string, entry: IndexEntry): void {
  const key = normalizeTitle(title);
  if (key.length === 0) return;

  const bucket = map.get(key);
  if (bucket) bucket.push(entry);
  else map.set(key, [entry]);
}

function build(stored: StoredIndex): Map<string, IndexEntry[]> {
  const map = new Map<string, IndexEntry[]>();
  for (const entry of stored.entries) {
    addKey(map, entry.t, entry);
    for (const alias of entry.a ?? []) addKey(map, alias, entry);
  }
  return map;
}

export async function saveTitleIndex(stored: StoredIndex): Promise<number> {
  await db.meta.put({ key: META_KEY, value: stored });
  lookup = build(stored);
  loadedAt = stored.generatedAt;
  byId = null; // Rebuilt lazily against the new data.
  return stored.entries.length;
}

export async function clearTitleIndex(): Promise<void> {
  await db.meta.delete(META_KEY);
  lookup = null;
  loadedAt = null;
  byId = null;
}

async function ensureLoaded(): Promise<Map<string, IndexEntry[]> | null> {
  if (lookup) return lookup;

  const entry = await db.meta.get(META_KEY);
  if (!entry) return null;

  const stored = entry.value as StoredIndex;
  lookup = build(stored);
  loadedAt = stored.generatedAt;
  return lookup;
}

export async function titleIndexStatus(): Promise<{
  loaded: boolean;
  titles: number;
  generatedAt?: string;
}> {
  const entry = await db.meta.get(META_KEY);
  if (!entry) return { loaded: false, titles: 0 };

  const stored = entry.value as StoredIndex;
  return { loaded: true, titles: stored.entries.length, generatedAt: stored.generatedAt };
}

function toTmdbTitle(entry: IndexEntry): TmdbTitle {
  return {
    tmdbId: entry.i,
    mediaType: 'movie',
    title: entry.t,
    year: entry.y,
    runtime: entry.r,
  };
}

/**
 * Exact-title lookup against the local index.
 *
 * Deliberately exact rather than fuzzy. Fuzzy matching over a 40,000-entry map
 * on every detection is slow, and the caller already runs a proper scorer over
 * whatever comes back - so this only has to be a fast, cheap way to get
 * plausible candidates without the network.
 */
export async function lookupLocal(title: string): Promise<TmdbTitle[]> {
  const map = await ensureLoaded();
  if (!map) return [];

  const key = normalizeTitle(title);
  const hits = map.get(key);
  if (!hits) return [];

  return hits.map(toTmdbTitle);
}

export function indexGeneratedAt(): string | null {
  return loadedAt;
}

/** Built alongside the title map, so lookups by id cost nothing extra. */
let byId: Map<number, IndexEntry> | null = null;

/**
 * Look a title up by its TMDB id.
 *
 * Needed so confirming a detection works with no API key. Everything else had
 * been made to run offline, but confirming still called TMDB for details -
 * which meant the bundled index resolved a title and then refused to record
 * it, for want of a key nobody should have needed.
 */
export async function lookupLocalById(tmdbId: number): Promise<TmdbTitle | null> {
  if (!byId) {
    const entry = await db.meta.get(META_KEY);
    if (!entry) return null;

    const stored = entry.value as StoredIndex;
    byId = new Map(stored.entries.map((item) => [item.i, item]));
  }

  const found = byId.get(tmdbId);
  return found ? toTmdbTitle(found) : null;
}
