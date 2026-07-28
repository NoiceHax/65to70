import { db } from './db';
import { normalizeTitle } from './match';

/**
 * Titles the user has already said aren't films.
 *
 * Without this, site chrome comes back every single visit: a homepage headline
 * or a utility frame's title is stable, so dismissing it once fixes nothing and
 * the same entry reappears tomorrow. Being asked the same question repeatedly,
 * after having answered it, is worse than not being asked at all.
 *
 * Keyed by host as well as title, because a string that's junk on one site can
 * be a real film on another.
 */

const META_KEY = 'dismissedTitles';

type DismissedMap = Record<string, string[]>;

function signature(title: string): string {
  return normalizeTitle(title);
}

async function load(): Promise<DismissedMap> {
  const entry = await db.meta.get(META_KEY);
  return (entry?.value as DismissedMap) ?? {};
}

export async function rememberDismissed(hostname: string, title: string): Promise<void> {
  const key = signature(title);
  if (key.length === 0) return;

  const map = await load();
  const existing = map[hostname] ?? [];
  if (existing.includes(key)) return;

  // Bounded so a noisy site can't grow this without limit.
  map[hostname] = [...existing, key].slice(-200);
  await db.meta.put({ key: META_KEY, value: map });
}

export async function wasDismissed(hostname: string, title: string): Promise<boolean> {
  const key = signature(title);
  if (key.length === 0) return false;

  const map = await load();
  return (map[hostname] ?? []).includes(key);
}

export async function forgetDismissals(): Promise<void> {
  await db.meta.delete(META_KEY);
}
