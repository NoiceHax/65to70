/**
 * Fetching that survives a long run.
 *
 * These scripts make tens of thousands of requests, and TMDB drops connections
 * intermittently - an ECONNRESET is normal at that volume, not exceptional.
 * Left unhandled, a single dropped socket rejected a `Promise.all` and threw
 * away forty minutes of completed work.
 *
 * So: transport errors are retried like rate limits, and exhausting the
 * retries returns null rather than throwing. One title missing from an index
 * of forty thousand costs nothing; the run failing costs everything.
 */

const BASE_DELAY_MS = 500;

export interface FetchOptions {
  retries?: number;
  /** Called when a request is retried, for progress reporting. */
  onRetry?: (attempt: number, reason: string) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET and parse JSON, retrying transient failures.
 *
 * Returns null for a genuine 404 - a question answered, not a failure - and
 * for anything still failing after the retries are spent.
 */
export async function getJson<T>(
  url: string | URL,
  options: FetchOptions = {},
): Promise<T | null> {
  const { retries = 4, onRetry } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);

      if (response.status === 404) return null;

      // Rate limiting and server trouble are both worth waiting out.
      if (response.status === 429 || response.status >= 500) {
        if (attempt === retries) return null;
        onRetry?.(attempt + 1, `HTTP ${response.status}`);
        await delay(BASE_DELAY_MS * 2 ** attempt * 4);
        continue;
      }

      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch (error) {
      // Dropped socket, DNS blip, TLS reset. Ordinary at this volume.
      if (attempt === retries) return null;
      onRetry?.(attempt + 1, (error as Error).message);
      await delay(BASE_DELAY_MS * 2 ** attempt);
    }
  }

  return null;
}
