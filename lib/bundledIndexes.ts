import { browser } from 'wxt/browser';
import { saveTitleIndex, titleIndexStatus } from './titleIndex';
import { saveAvailabilityIndex, availabilityStatus, type AvailabilityIndex } from './providers';
import { saveSimilarIndex, similarIndexStatus, type SimilarIndex } from './similar';
import { getSettings } from './settings';

/**
 * Load prepared indexes that ship inside the extension.
 *
 * These were originally something the user had to build and then hand-feed to
 * the extension through a file picker — a developer's workflow wearing a user
 * interface. Anything that arrives in the build should already be in place by
 * the time anyone opens the settings page.
 *
 * Bundling was ruled out earlier on the grounds that a data refresh would then
 * need a store review. That reasoning applies to a store-distributed
 * extension, not one loaded unpacked, where a refresh is just another build.
 *
 * Files are read from the extension's own package, so this is not a network
 * request and nothing leaves the machine. Missing files are normal — they
 * simply haven't been built — and are skipped without complaint.
 */

async function readBundled<T>(path: string): Promise<T | null> {
  try {
    // WXT types getURL against the files it can see in public/ when types are
    // generated. These are built by the pipeline and git-ignored, so they're
    // never in that union — the cast says "generated at build time, not
    // checked in", which is exactly the situation.
    const response = await fetch(browser.runtime.getURL(path as never));
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Not built, or malformed. Neither is worth an error the user can't act on.
    return null;
  }
}

export interface BundleReport {
  titles: number;
  availability: number;
  similar: number;
}

/**
 * Seed anything not already in the database.
 *
 * Existing data wins: a file loaded by hand, or a newer index already
 * imported, isn't overwritten by whatever happened to ship in the build.
 */
export async function loadBundledIndexes(): Promise<BundleReport> {
  const report: BundleReport = { titles: 0, availability: 0, similar: 0 };

  if (!(await titleIndexStatus()).loaded) {
    const stored = await readBundled<{ generatedAt: string; entries: unknown[] }>(
      'data/titles.json',
    );
    if (stored?.entries?.length) {
      report.titles = await saveTitleIndex(stored as never);
    }
  }

  const { region } = await getSettings();
  if (!(await availabilityStatus()).loaded) {
    const index = await readBundled<AvailabilityIndex>(`data/availability-${region}.json`);
    if (index?.titles) {
      await saveAvailabilityIndex(index);
      report.availability = Object.keys(index.titles).length;
    }
  }

  if (!(await similarIndexStatus()).loaded) {
    const index = await readBundled<SimilarIndex>('data/similar.json');
    if (index?.similar) {
      report.similar = await saveSimilarIndex(index);
    }
  }

  return report;
}
