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
   * Origins of cross-origin iframes on the page.
   *
   * Streaming sites routinely serve the player from a separate domain. Host
   * permissions are per-origin and `allFrames` only injects into frames whose
   * own URL matches a granted pattern — so granting the site the user typed
   * does not reach the frame that actually holds the video. Reporting these
   * lets the popup offer the missing grant instead of silently recording
   * nothing.
   */
  embeddedOrigins: string[];
}

export interface MediaProgressMessage {
  type: 'media-progress';
  /** Coverage bucket indices newly played since the last report. */
  buckets: number[];
  currentTimeSec: number;
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
