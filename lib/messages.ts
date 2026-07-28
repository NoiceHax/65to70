import type { PageMetaResult } from './pageMeta';
import type { UrlIdCandidate } from './urlIds';

/**
 * Content script → background.
 *
 * Content scripts observe and report; the background worker decides what any
 * of it means. That split matters for embedded players: the <video> often lives
 * in a cross-origin iframe while the title lives in the top frame, so neither
 * frame has the whole picture. Both send what they have and the background
 * merges by tab.
 */

export interface PageMetaMessage {
  type: 'page-meta';
  candidates: PageMetaResult[];
  /**
   * Catalogue ids read straight out of the URL. Outrank every text candidate
   * when they verify, and are the only signal on client-rendered sites whose
   * markup carries no usable title.
   */
  urlIds: UrlIdCandidate[];
  url: string;
  hostname: string;
  isTopFrame: boolean;

  /** Whether this frame contains a usable media element. */
  hasVideo: boolean;

  /**
   * Cross-origin iframes on the page.
   *
   * Streaming sites routinely serve the player from a separate domain. Host
   * permissions are per-origin and `allFrames` only injects into frames whose
   * own URL matches a granted pattern — so granting the site the user typed
   * does not reach the frame that actually holds the video. Reporting these
   * lets the popup offer the missing grant instead of silently recording
   * nothing.
   */
  embeddedFrames: EmbeddedFrame[];
}

export interface EmbeddedFrame {
  origin: string;
  /**
   * Whether this looks like the video player rather than an advert.
   *
   * These pages are dense with ad frames, and asking someone to grant an
   * extension access to an unidentified ad network is a bad thing to put in
   * front of them. Size and URL shape separate a player from a banner well
   * enough to make the distinction, and the UI defers to it.
   */
  likelyPlayer: boolean;
}

export interface MediaProgressMessage {
  type: 'media-progress';
  /**
   * Raw playback positions sampled since the last report, in seconds.
   *
   * Positions rather than pre-computed coverage buckets, because the runtime
   * needed to turn one into the other often isn't known in the page. Streaming
   * players report `duration` as NaN with an empty `seekable` range, and the
   * only reliable runtime comes from the catalogue entry the background
   * resolves — so the background is where that conversion belongs.
   */
  samples: number[];
  currentTimeSec: number;
  /** The player's own figure. 0 when it won't say. */
  durationSec: number;
  url: string;
  hostname: string;
  isTopFrame: boolean;
  /** Set when playback stopped, the media changed, or the page is unloading. */
  ended: boolean;
}

/**
 * The overlay asks for a snapshot of the local library.
 *
 * Content scripts can't reach the extension's IndexedDB, so the background
 * hands over a compact, already-normalised list. Scoping the overlay to titles
 * the user already has a relationship with is what makes it tractable —
 * recognising arbitrary film names in arbitrary page text is not.
 */
export interface LibraryRequest {
  type: 'library-request';
}

export interface LibraryEntry {
  /** Normalised title, ready to match against page text. */
  n: string;
  title: string;
  year?: number;
  rating: number | null;
  liked: boolean;
  watched: boolean;
  /** ISO date the title was last confirmed as watched. */
  at?: string;
  /** Streaming services carrying it in the user's region. */
  on?: string[];
}

export interface LibraryResponse {
  entries: LibraryEntry[];
}

/**
 * Background → content script: ask the viewer, in the page, right as it ends.
 *
 * Only sent when the resolver already knows what it was. Asking "is this
 * right?" about a confident guess is a reasonable interruption; asking the user
 * to identify something from scratch mid-page is not — that belongs in the
 * queue.
 */
export interface ConfirmPromptMessage {
  type: 'confirm-prompt';
  pendingId: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
}

/** Content script → background: what the viewer tapped. */
export interface ToastActionMessage {
  type: 'toast-action';
  action: 'confirm' | 'dismiss' | 'ignore';
  pendingId: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  rating: number | null;
}

export type KeeperMessage =
  | PageMetaMessage
  | MediaProgressMessage
  | LibraryRequest
  | ToastActionMessage;
