import { db } from './db';

/**
 * The shipped relationship index.
 *
 * Loaded like the title and availability indexes: built offline, downloaded or
 * loaded once, queried entirely on-device. Recommendations never involve
 * sending a library anywhere.
 */

export interface SimilarIndex {
  generatedAt: string;
  /** Display details for every title reachable from a relationship list. */
  titles: Record<string, { t: string; y?: number }>;
  /** TMDB id → related TMDB ids, strongest first. */
  similar: Record<string, number[]>;
}

const META_KEY = 'similarIndex';

let cached: SimilarIndex | null = null;

export async function saveSimilarIndex(index: SimilarIndex): Promise<number> {
  await db.meta.put({ key: META_KEY, value: index });
  cached = index;
  return Object.keys(index.similar).length;
}

export async function clearSimilarIndex(): Promise<void> {
  await db.meta.delete(META_KEY);
  cached = null;
}

export async function loadSimilarIndex(): Promise<SimilarIndex | null> {
  if (cached) return cached;

  const entry = await db.meta.get(META_KEY);
  cached = (entry?.value as SimilarIndex) ?? null;
  return cached;
}

export async function similarIndexStatus(): Promise<{
  loaded: boolean;
  titles: number;
  generatedAt?: string;
}> {
  const index = await loadSimilarIndex();
  if (!index) return { loaded: false, titles: 0 };

  return {
    loaded: true,
    titles: Object.keys(index.similar).length,
    generatedAt: index.generatedAt,
  };
}
