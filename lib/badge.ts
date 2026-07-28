import { browser } from 'wxt/browser';
import { db } from './db';

/**
 * Toolbar badge showing how many detections are waiting.
 *
 * The quiet counterpart to the in-page prompt: it never interrupts, and it is
 * the only signal for anything the resolver could not identify confidently
 * enough to ask about in the page.
 */
export async function refreshBadge(): Promise<void> {
  try {
    const count = await db.pending.where('status').equals('awaiting').count();
    await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  } catch {
    // Badge APIs are unavailable in some contexts; never worth failing over.
  }
}
