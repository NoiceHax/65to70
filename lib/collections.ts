import { db } from './db';
import type { Collection, Movie, TitleKey } from './types';

/**
 * Named local lists - "Movies for Dad", "Christmas", "Horror Marathon".
 *
 * A separate table rather than reusing tags, because collections are ordered
 * and get their own UI. Nothing here is shared or uploaded.
 */

export async function createCollection(name: string): Promise<Collection> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('A collection needs a name.');

  const existing = await db.collections.where('name').equals(trimmed).first();
  if (existing) return existing;

  const order = await db.collections.count();
  const id = (await db.collections.add({
    name: trimmed,
    createdAt: Date.now(),
    order,
  })) as number;

  return (await db.collections.get(id))!;
}

export async function renameCollection(id: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length > 0) await db.collections.update(id, { name: trimmed });
}

/** Removes the list, never the titles that were in it. */
export async function deleteCollection(id: number): Promise<void> {
  await db.collectionItems.where('collectionId').equals(id).delete();
  await db.collections.delete(id);
}

export async function addToCollection(
  collectionId: number,
  key: TitleKey,
): Promise<void> {
  const already = await db.collectionItems
    .where('collectionId')
    .equals(collectionId)
    .filter((item) => item.titleKey === key)
    .count();
  if (already > 0) return;

  const order = await db.collectionItems.where('collectionId').equals(collectionId).count();
  await db.collectionItems.add({
    collectionId,
    titleKey: key,
    order,
    addedAt: Date.now(),
  });
}

export async function removeFromCollection(
  collectionId: number,
  key: TitleKey,
): Promise<void> {
  await db.collectionItems
    .where('collectionId')
    .equals(collectionId)
    .filter((item) => item.titleKey === key)
    .delete();
}

export interface CollectionWithItems {
  collection: Collection;
  movies: Movie[];
}

export async function listCollections(): Promise<CollectionWithItems[]> {
  const collections = await db.collections.orderBy('order').toArray();

  const out: CollectionWithItems[] = [];
  for (const collection of collections) {
    const items = await db.collectionItems
      .where('collectionId')
      .equals(collection.id!)
      .sortBy('order');

    const movies: Movie[] = [];
    for (const item of items) {
      const movie = await db.movies.get(item.titleKey);
      if (movie) movies.push(movie);
    }

    out.push({ collection, movies });
  }

  return out;
}
