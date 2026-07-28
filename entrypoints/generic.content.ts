import { browser } from 'wxt/browser';
import { extractPageMeta } from '@/lib/pageMeta';
import { readAdapterMeta } from '@/lib/adapters';
import { extractUrlIds } from '@/lib/urlIds';
import { bucketIndex, bucketsCovered } from '@/lib/progress';
import type { MediaProgressMessage, PageMetaMessage } from '@/lib/messages';

/**
 * Tier 2 detection — the generic fallback for any granted site.
 *
 * Registered at runtime only, never in the manifest, so it can only ever run on
 * origins the user explicitly granted. See lib/permissions.ts.
 *
 * Runs in every frame. The frame holding the <video> reports progress; the top
 * frame reports the page title. For embedded players those are different
 * frames, so both send independently and the background merges them.
 */

/** How often playback position is sampled. */
const SAMPLE_INTERVAL_MS = 5_000;
/** How often accumulated buckets are flushed to the background. */
const REPORT_INTERVAL_MS = 15_000;
/** Floor on re-reading page metadata, which involves parsing any JSON-LD. */
const META_THROTTLE_MS = 1_000;
/** Backstop for client-rendered titles that appear well after first paint. */
const META_POLL_MS = 3_000;
/**
 * Below this, it's an ad, a trailer, or a preview loop — not something anyone
 * is going to want in their diary. The shortest real target is a ~22 minute
 * sitcom episode.
 */
const MIN_DURATION_SEC = 300;
/** A duration change beyond this means the player switched media (or an ad ran). */
const DURATION_EPSILON_SEC = 5;

const isTopFrame = window.top === window;

let media: HTMLVideoElement | null = null;
let trackedDuration = 0;
let lastSampleAt = 0;
let lastSampleBucket = -1;
let pendingBuckets = new Set<number>();
let reportTimer: ReturnType<typeof setInterval> | null = null;

let lastMetaSignature = '';
let lastMetaCheckAt = 0;
let metaDebounce: ReturnType<typeof setTimeout> | null = null;

function send(message: PageMetaMessage | MediaProgressMessage): void {
  // The worker may be asleep or the extension reloading; neither is worth
  // surfacing to the page.
  browser.runtime.sendMessage(message).catch(() => {});
}

function usableDuration(el: HTMLVideoElement): boolean {
  return Number.isFinite(el.duration) && el.duration >= MIN_DURATION_SEC;
}

function recordCoverage(el: HTMLVideoElement, now: number): void {
  const bucket = bucketIndex(el.currentTime, el.duration);
  const covered = bucketsCovered(
    lastSampleBucket >= 0 ? lastSampleBucket : null,
    bucket,
    now - lastSampleAt,
    SAMPLE_INTERVAL_MS,
  );

  for (const index of covered) pendingBuckets.add(index);

  lastSampleBucket = bucket;
  lastSampleAt = now;
}

function flush(ended: boolean): void {
  if (!media) return;
  if (pendingBuckets.size === 0 && !ended) return;

  const message: MediaProgressMessage = {
    type: 'media-progress',
    buckets: Array.from(pendingBuckets),
    currentTimeSec: media.currentTime,
    durationSec: trackedDuration || media.duration,
    url: location.href,
    hostname: location.hostname,
    isTopFrame,
    ended,
  };

  pendingBuckets = new Set();
  send(message);
}

function onTimeUpdate(): void {
  if (!media || !usableDuration(media)) return;

  // An ad break or a switch to the next episode replaces the media on the same
  // element. Close out the old session rather than merging two films.
  if (Math.abs(media.duration - trackedDuration) > DURATION_EPSILON_SEC) {
    flush(true);
    trackedDuration = media.duration;
    lastSampleBucket = -1;
    lastSampleAt = 0;
  }

  const now = Date.now();
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
  recordCoverage(media, now);
}

function onPause(): void {
  flush(false);
}

function onEnded(): void {
  flush(true);
}

function detach(): void {
  if (!media) return;
  flush(true);
  media.removeEventListener('timeupdate', onTimeUpdate);
  media.removeEventListener('pause', onPause);
  media.removeEventListener('ended', onEnded);
  media = null;
  trackedDuration = 0;
  lastSampleBucket = -1;
  lastSampleAt = 0;
}

function attach(el: HTMLVideoElement): void {
  if (media === el) return;
  detach();

  media = el;
  trackedDuration = el.duration;
  lastSampleBucket = -1;
  lastSampleAt = 0;

  el.addEventListener('timeupdate', onTimeUpdate);
  el.addEventListener('pause', onPause);
  el.addEventListener('ended', onEnded);

  if (!reportTimer) {
    reportTimer = setInterval(() => flush(false), REPORT_INTERVAL_MS);
  }
}

/** Prefer a video that's actually playing; fall back to the longest one. */
function pickVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video')).filter(usableDuration);
  if (videos.length === 0) return null;

  const playing = videos.filter((v) => !v.paused && !v.ended);
  const pool = playing.length > 0 ? playing : videos;

  return pool.reduce((best, v) => (v.duration > best.duration ? v : best));
}

function scanForMedia(): void {
  const found = pickVideo();
  if (found) attach(found);
  else if (media && !document.contains(media)) detach();
}

/**
 * Report page metadata whenever it actually changes.
 *
 * Keying this on the URL alone was a bug. A client-rendered site sets its real
 * title well after first paint without ever changing the URL, so the first —
 * wrong — snapshot was captured and never revisited. Comparing a signature of
 * the extracted values catches the late update instead; re-sending is harmless
 * because the background merges by tab.
 */
function reportPageMeta(): void {
  const now = Date.now();
  if (now - lastMetaCheckAt < META_THROTTLE_MS) return;
  lastMetaCheckAt = now;

  // Tier 1 first. On the premium services this is the only source that works —
  // their document titles say nothing, because they have no reason to court
  // search engines for content they own.
  const adapterMeta = readAdapterMeta(document, location.href, location.hostname);
  const candidates = [
    ...(adapterMeta ? [adapterMeta] : []),
    ...extractPageMeta(document, location.href),
  ];

  const urlIds = extractUrlIds(location.href);
  if (candidates.length === 0 && urlIds.length === 0) return;

  const signature = JSON.stringify([
    location.href,
    candidates.map((c) => `${c.strategy}:${c.rawTitle}`),
    urlIds.map((i) => `${i.source}:${i.id}:${i.season ?? ''}:${i.episode ?? ''}`),
  ]);
  if (signature === lastMetaSignature) return;
  lastMetaSignature = signature;

  send({
    type: 'page-meta',
    candidates,
    urlIds,
    url: location.href,
    hostname: location.hostname,
    isTopFrame,
  });
}

export default defineContentScript({
  registration: 'runtime',
  main() {
    reportPageMeta();
    scanForMedia();

    // Players are injected late and swapped on SPA navigation, so neither a
    // one-shot scan nor a load listener is enough. Debounced because video
    // pages mutate the DOM constantly and re-parsing JSON-LD each time isn't
    // free.
    const observer = new MutationObserver(() => {
      if (metaDebounce) clearTimeout(metaDebounce);
      metaDebounce = setTimeout(() => {
        reportPageMeta();
        scanForMedia();
      }, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Backstop for titles set without a DOM mutation we can observe.
    setInterval(reportPageMeta, META_POLL_MS);

    // Last chance to persist progress before the frame goes away.
    window.addEventListener('pagehide', () => flush(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(false);
    });
  },
});
