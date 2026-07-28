import type { PageMetaResult } from './pageMeta';

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
  url: string;
  hostname: string;
  isTopFrame: boolean;
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

export type KeeperMessage = PageMetaMessage | MediaProgressMessage;
