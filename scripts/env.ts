import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load local secrets from `.env` so scripts don't need the key pasted in every
 * time. An explicit environment variable still wins, which keeps CI and
 * one-off overrides working without editing the file.
 *
 * `.env` is git-ignored. Nothing here is bundled into the extension - the
 * pipeline runs on your machine only.
 */
export function loadEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;

  try {
    process.loadEnvFile(path);
  } catch {
    // Malformed file shouldn't take the script down; the caller reports a
    // missing key with a useful message anyway.
  }
}

/** The TMDB key, from the environment or `.env`. */
export function tmdbApiKey(): string | undefined {
  loadEnv();
  return process.env.TMDB_API_KEY;
}
