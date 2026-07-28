import { browser } from 'wxt/browser';
import { extractPageMeta, looksLikeSeries } from '@/lib/pageMeta';
import { readAdapterMeta } from '@/lib/adapters';
import { PLAYER_URL } from '@/lib/frames';
import { extractUrlIds } from '@/lib/urlIds';
import { effectiveDuration } from '@/lib/progress';
import { readPlayerClock, type PlayerClock } from '@/lib/playerClock';
import { showToast } from '@/lib/toast';
import type {
  ConfirmPromptMessage,
  MediaProgressMessage,
  PageMetaMessage,
  ToastActionMessage,
} from '@/lib/messages';

/**
 * Tier 2 detection - the generic fallback for any granted site.
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
 * Below this, it's an ad, a trailer, or a preview loop - not something anyone
 * is going to want in their diary. The shortest real target is a ~22 minute
 * sitcom episode.
 */
const MIN_DURATION_SEC = 300;
/** Elapsed playback that stands in for runtime when the player won't report it. */
const MIN_PLAYBACK_SEC = 60;
/** A duration change beyond this means the player switched media (or an ad ran). */
const DURATION_EPSILON_SEC = 5;

const isTopFrame = window.top === window;

let media: HTMLVideoElement | null = null;
let trackedDuration = 0;
let lastSampleAt = 0;
let pendingSamples: number[] = [];
let reportTimer: ReturnType<typeof setInterval> | null = null;

let lastMetaSignature = '';
let lastMetaCheckAt = 0;
let metaDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether this script still belongs to a live extension.
 *
 * Reloading the extension leaves the previous content script running in every
 * open page, attached to an extension that no longer exists. Sending from that
 * state throws "Extension context invalidated" - and throws *synchronously*, so
 * a `.catch()` on the returned promise never sees it, which is why those errors
 * were uncaught and repeating.
 */
let alive = true;

function send(message: PageMetaMessage | MediaProgressMessage): void {
  if (!alive) return;

  try {
    // The worker may also simply be asleep; neither case is worth surfacing.
    browser.runtime.sendMessage(message)?.catch(() => {});
  } catch {
    // The extension went away. Stop trying, and stop everything else too.
    alive = false;
  }
}

/**
 * The player's on-screen clock, including inside shadow roots.
 *
 * Worth reading because the media element and the visible UI disagree
 * constantly on these sites: `duration` comes back NaN while the player renders
 * "1:23:45 / 2:14:30" a few pixels away. The runtime was never unavailable -
 * it just wasn't exposed through the API being asked.
 */
function clockFromPage(): PlayerClock | null {
  const direct = readPlayerClock(document);
  if (direct) return direct;

  for (const element of Array.from(document.querySelectorAll('*'))) {
    const shadow = (element as HTMLElement).shadowRoot;
    if (!shadow) continue;

    const found = readPlayerClock(shadow);
    if (found) return found;
  }

  return null;
}

/**
 * Runtime in seconds, from whichever source will say.
 *
 * The media element first, then the scrubber. Preferring the element is only
 * because it's cheaper to read, not because it's more trustworthy - on these
 * players it frequently knows less than the interface it drives.
 */
function mediaDuration(el: HTMLVideoElement): number {
  const known = effectiveDuration(el);
  if (known > 0) return known;
  return clockFromPage()?.durationSec ?? 0;
}

/**
 * Whether this element is the feature rather than an advert or a preview.
 *
 * Runtime is the obvious test, and when no source can supply one, sustained
 * playback stands in for it. Adverts and preview loops are short; a minute of
 * actual elapsed playback is a strong signal this is the thing being watched.
 * The background discards it later if the title never resolves.
 */
function looksLikeContent(el: HTMLVideoElement): boolean {
  const known = mediaDuration(el);
  if (known >= MIN_DURATION_SEC) return true;
  if (known === 0 && el.currentTime >= MIN_PLAYBACK_SEC) return true;
  return false;
}

/**
 * Record where playback currently is.
 *
 * Just the position - no coverage maths here. Turning positions into coverage
 * needs the runtime, and on these players the runtime often isn't knowable in
 * the page at all. The background has the resolved catalogue entry, so it has
 * the runtime, so it does the conversion.
 */
function recordSample(el: HTMLVideoElement, now: number): void {
  pendingSamples.push(el.currentTime);
  lastSampleAt = now;
}

function flush(ended: boolean): void {
  if (!media) return;
  if (pendingSamples.length === 0 && !ended) return;

  const message: MediaProgressMessage = {
    type: 'media-progress',
    samples: pendingSamples,
    currentTimeSec: media.currentTime,
    durationSec: trackedDuration || 0,
    url: location.href,
    hostname: location.hostname,
    isTopFrame,
    ended,
  };

  pendingSamples = [];
  send(message);
}

function onTimeUpdate(): void {
  if (!media || !looksLikeContent(media)) return;

  // An ad break or a switch to the next episode replaces the media on the same
  // element. Close out the old session rather than merging two films.
  //
  // The threshold is relative, not a flat few seconds. A seekable range grows
  // as a stream buffers, and a fixed epsilon would read that ordinary growth as
  // a new film - tearing down and restarting the session over and over, losing
  // all coverage each time. A genuine ad-to-feature switch changes the duration
  // by an order of magnitude, so it still trips this easily.
  const changeThreshold = Math.max(DURATION_EPSILON_SEC, trackedDuration * 0.2);
  if (Math.abs(mediaDuration(media) - trackedDuration) > changeThreshold) {
    flush(true);
    trackedDuration = mediaDuration(media);
    lastSampleAt = 0;
  }

  const now = Date.now();
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
  recordSample(media, now);
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
  lastSampleAt = 0;
}

function attach(el: HTMLVideoElement): void {
  if (media === el) return;
  detach();

  media = el;
  trackedDuration = mediaDuration(el);
  lastSampleAt = 0;

  el.addEventListener('timeupdate', onTimeUpdate);
  el.addEventListener('pause', onPause);
  el.addEventListener('ended', onEnded);

  if (!reportTimer) {
    reportTimer = setInterval(() => flush(false), REPORT_INTERVAL_MS);
  }
}

/**
 * Every video element in the frame, including inside shadow roots.
 *
 * `querySelectorAll` does not cross a shadow boundary, and several embed
 * players render their player into one. To a plain query those pages contain no
 * video at all - indistinguishable from a page that genuinely has none, which
 * is the least useful way for this to fail.
 *
 * Closed shadow roots stay unreachable; nothing can be done about those.
 */
function findVideos(root: Document | ShadowRoot = document): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = Array.from(root.querySelectorAll('video'));

  for (const element of Array.from(root.querySelectorAll('*'))) {
    const shadow = (element as HTMLElement).shadowRoot;
    if (shadow) found.push(...findVideos(shadow));
  }

  return found;
}

/** Prefer a video that's actually playing; fall back to the longest one. */
function pickVideo(): HTMLVideoElement | null {
  const videos = findVideos().filter(looksLikeContent);
  if (videos.length === 0) return null;

  const playing = videos.filter((v) => !v.paused && !v.ended);
  const pool = playing.length > 0 ? playing : videos;

  return pool.reduce((best, v) => (v.duration > best.duration ? v : best));
}

/** Where in the pipeline this frame currently is, printed once per change. */
let lastReported = '';

function reportState(): void {
  const all = findVideos().length;
  const usable = findVideos().filter(looksLikeContent).length;
  const frames = embeddedFrames();

  const state = `${all}:${usable}:${frames.map((f) => f.origin).join(',')}:${media ? 'attached' : 'none'}`;
  if (state === lastReported) return;
  lastReported = state;

  if (media) {
    console.log(
      `[keeper] tracking on ${location.hostname}`,
      `- ${Math.round(trackedDuration / 60)} min`,
      isTopFrame ? '(top frame)' : '(iframe)',
    );
    return;
  }

  if (all > 0 && usable === 0) {
    // Print the raw values. "None usable" hides the difference between an ad
    // (short but valid), a stream whose manifest hasn't parsed yet (NaN), and
    // an unbounded stream (Infinity) - which need completely different fixes.
    const seen = findVideos()
      .map((el) => `duration=${el.duration} effective=${effectiveDuration(el)}`)
      .join('; ');

    console.log(
      `[keeper] ${location.hostname}: ${all} video element(s), none over ${MIN_DURATION_SEC}s -`,
      seen,
    );
    return;
  }

  if (all === 0 && frames.length > 0) {
    /*
     * Only worth saying on a page that looks like somewhere you watch things.
     *
     * Every page has iframes. Saying "no video here" on a search results page,
     * a chat client or a social feed is noise that buries the one message that
     * matters, and it was `console.warn`, so all of it landed in the browser's
     * error list as though something had broken.
     */
    const players = frames.filter((f) => f.likelyPlayer).map((f) => f.origin);
    if (players.length === 0 && !/[/?&](watch|play|movie|episode)\b/i.test(location.href)) {
      return;
    }

    console.log(
      `[keeper] ${location.hostname}: no video here.`,
      players.length > 0
        ? `Player looks like ${players.join(', ')} - grant it in the popup.`
        : 'No player-shaped frame found.',
    );
    return;
  }

  if (all === 0) {
    console.log(
      `[keeper] ${location.hostname}: no video yet`,
      isTopFrame ? '(top frame)' : '(iframe)',
    );
  }
}

function scanForMedia(): void {
  const found = pickVideo();
  if (found) attach(found);
  else if (media && !document.contains(media)) detach();
  reportState();
}

/**
 * Report page metadata whenever it actually changes.
 *
 * Keying this on the URL alone was a bug. A client-rendered site sets its real
 * title well after first paint without ever changing the URL, so the first -
 * wrong - snapshot was captured and never revisited. Comparing a signature of
 * the extracted values catches the late update instead; re-sending is harmless
 * because the background merges by tab.
 */
/**
 * Cross-origin iframes on this page.
 *
 * Reading an iframe's `src` attribute is just a DOM read - it needs no access
 * to the frame's contents, so this works even though the frame itself is off
 * limits. That's what makes it possible to name the origin that's missing
 * rather than leaving a site that records nothing and explains nothing.
 *
 * Runs in every frame, not only the top one. These sites chain their embeds -
 * the page loads a player host, which loads the actual stream host - so
 * reporting only from the top frame stops one link short of the video.
 */
function embeddedFrames(): { origin: string; likelyPlayer: boolean }[] {
  const found = new Map<string, boolean>();

  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const src = frame.getAttribute('src');
    if (!src) continue;

    try {
      const { origin, protocol, href, hostname } = new URL(src, location.href);
      if (protocol !== 'http:' && protocol !== 'https:') continue;
      if (origin === location.origin) continue;

      // A malformed src like "//undefined/..." parses cleanly into an origin of
      // "https://undefined", which is nothing and cannot be granted. Requiring a
      // dot in the hostname discards those without discarding anything real.
      if (!hostname.includes('.')) continue;

      // A player is big. Standard ad units are 300x250 or 728x90, so requiring
      // both a wide and a tall box excludes them without excluding a real
      // embed, and a player-shaped URL vouches for frames not yet laid out.
      const rect = frame.getBoundingClientRect();
      const bigEnough = rect.width >= 480 && rect.height >= 270;
      const likelyPlayer = PLAYER_URL.test(href) || bigEnough;

      found.set(origin, (found.get(origin) ?? false) || likelyPlayer);
    } catch {
      // Relative or malformed src; nothing to grant.
    }
  }

  return [...found].map(([origin, likelyPlayer]) => ({ origin, likelyPlayer }));
}

function reportPageMeta(): void {
  const now = Date.now();
  if (now - lastMetaCheckAt < META_THROTTLE_MS) return;
  lastMetaCheckAt = now;

  // Tier 1 first. On the premium services this is the only source that works -
  // their document titles say nothing, because they have no reason to court
  // search engines for content they own.
  const adapterMeta = readAdapterMeta(document, location.href, location.hostname);
  const candidates = [
    ...(adapterMeta ? [adapterMeta] : []),
    ...extractPageMeta(document, location.href),
  ];

  const urlIds = extractUrlIds(location.href);
  const embedded = embeddedFrames();
  const hasVideo = pickVideo() !== null;

  // Still report when nothing was identifiable: knowing a page had a player in
  // an un-granted iframe is exactly the diagnosis the popup needs to show.
  if (candidates.length === 0 && urlIds.length === 0 && embedded.length === 0) return;

  const signature = JSON.stringify([
    location.href,
    candidates.map((c) => `${c.strategy}:${c.rawTitle}`),
    looksLikeSeries(document),
    urlIds.map((i) => `${i.source}:${i.id}:${i.season ?? ''}:${i.episode ?? ''}`),
    embedded,
    hasVideo,
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
    hasVideo,
    isSeriesPage: looksLikeSeries(document),
    embeddedFrames: embedded,
  });
}

/**
 * Show the end-of-film prompt.
 *
 * Only the top frame does this. An embedded player would otherwise render the
 * toast inside its own iframe, where it may be clipped, tiny, or invisible.
 */
function handleConfirmPrompt(msg: ConfirmPromptMessage): void {
  /*
   * Work out which frame should draw it, and where.
   *
   * While anything is fullscreen the browser renders only the fullscreen
   * element and its descendants. A toast attached to the document root then
   * exists and is never drawn - which looks exactly like a prompt that never
   * fired, and is almost certainly what happens while watching a film.
   *
   * The message goes to every frame, so each one decides for itself:
   *
   *  - Fullscreen on an iframe means the player frame is the one on screen.
   *    The parent stands down and lets the child draw it.
   *  - Any other fullscreen element is the thing being rendered, so the toast
   *    goes inside it.
   *  - With nothing fullscreen, only the top frame draws, or an embedded
   *    player would produce a second toast inside itself.
   */
  const fullscreen = document.fullscreenElement;

  if (fullscreen?.tagName === 'IFRAME') return;
  if (!fullscreen && !isTopFrame) return;

  const container = fullscreen ?? document.documentElement;

  const reply = (action: ToastActionMessage['action'], rating: number | null) => {
    const message: ToastActionMessage = {
      type: 'toast-action',
      action,
      pendingId: msg.pendingId,
      tmdbId: msg.tmdbId,
      mediaType: msg.mediaType,
      rating,
    };
    browser.runtime.sendMessage(message).catch(() => {});
  };

  // Nothing to confirm against when the title was read but not matched. Say
  // what was seen rather than offering a button that cannot do anything.
  const matched = msg.tmdbId !== undefined;

  showToast({
    container,
    title: msg.title,
    year: msg.year,
    prompt: matched
      ? 'Tracking this, is that right?'
      : 'Tracking this. Not in the catalogue yet, so pick it in Keeper when you can.',
    confirmLabel: matched ? 'Yes, track it' : 'OK',
    showStars: matched,
    onConfirm: (rating) => (matched ? reply('confirm', rating) : reply('ignore', null)),
    onDismiss: () => reply('dismiss', null),
    // Ignoring is not rejecting: the detection stays in the confirm queue.
    onIgnore: () => reply('ignore', null),
  });
}

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    /*
     * Tie every timer and listener to the script's lifetime.
     *
     * Reloading the extension leaves this script running in every open page,
     * attached to an extension that no longer exists, and raw intervals kept
     * firing into it forever - which is where the repeating "Extension context
     * invalidated" errors came from. `ctx` clears its own timers when that
     * happens.
     */
    ctx.onInvalidated(() => {
      alive = false;
    });

    browser.runtime.onMessage.addListener((message) => {
      const msg = message as ConfirmPromptMessage;
      if (msg?.type === 'confirm-prompt') handleConfirmPrompt(msg);
    });

    console.log(
      `[keeper] content script live on ${location.hostname}`,
      isTopFrame ? '(top frame)' : '(iframe)',
    );

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

    /*
     * Media readiness is not a DOM mutation, and this is what broke detection
     * on a real site.
     *
     * A streaming player inserts its <video> long before it knows the runtime:
     * with Media Source Extensions the duration is NaN until the manifest is
     * parsed. The observer above fires on the insertion, sees NaN, rejects the
     * element as too short - and then never looks again, because the duration
     * arriving later changes no markup at all.
     *
     * These events are the signal that the answer has changed. Captured at the
     * document, since the element is usually replaced rather than reused.
     */
    for (const event of ['loadedmetadata', 'durationchange', 'canplay', 'playing']) {
      document.addEventListener(event, scanForMedia, { capture: true });
    }

    // Backstop for titles set without a DOM mutation we can observe, and for
    // players that populate seekable without firing anything useful.
    ctx.setInterval(() => {
      reportPageMeta();
      scanForMedia();
    }, META_POLL_MS);

    // Last chance to persist progress before the frame goes away.
    window.addEventListener('pagehide', () => flush(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(false);
    });
  },
});
