/**
 * A snapshot of what a page offers, gathered without devtools.
 *
 * Some sites fight inspection — they detect the devtools panel by window
 * geometry or `debugger` timing and blank the page, freeze, or navigate away.
 * That makes the ordinary way of working out which selector holds the title
 * unavailable exactly where it's most needed.
 *
 * This sidesteps the argument. The collector runs through `scripting.execute
 * Script`, which needs no panel open, and reports what it found. Paste the
 * result somewhere useful and an adapter can be written from it.
 *
 * The function below is injected verbatim into the page, so it must be entirely
 * self-contained — no imports, no closure over anything in this module.
 */

export interface FrameReport {
  url: string;
  isTop: boolean;
  documentTitle: string;
  metaTitles: { source: string; value: string }[];
  headings: string[];
  /** Elements whose class, id or data hints they hold a title. */
  titleish: { selector: string; text: string }[];
  videos: { duration: number; currentTime: number; seekableEnd: number | null }[];
  /** Anything clock-shaped, which is where a runtime often hides. */
  clocks: { selector: string; text: string }[];
  sliders: { valueNow: string | null; valueMax: string | null }[];
  iframes: string[];
  shadowRoots: number;
}

/**
 * Collected inside the page. Deliberately verbose — the point is to see what
 * exists, not to guess in advance which part matters.
 */
export function collectFrameReport(): FrameReport {
  const trim = (value: string | null | undefined, max = 120): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className
        ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '';
    return `${tag}${id}${cls}`.slice(0, 80);
  };

  // Walk shadow roots too: a player that hides its video there hides its
  // controls and title there as well.
  const roots: (Document | ShadowRoot)[] = [document];
  let shadowRoots = 0;

  for (const el of Array.from(document.querySelectorAll('*'))) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) {
      roots.push(shadow);
      shadowRoots++;
    }
  }

  const all = (selector: string): Element[] =>
    roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));

  const metaTitles: { source: string; value: string }[] = [];
  for (const name of ['og:title', 'twitter:title', 'title']) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`);
    const value = trim(el?.getAttribute('content'));
    if (value) metaTitles.push({ source: name, value });
  }

  const titleish = all('[class*="title" i], [id*="title" i], [data-title], [aria-label]')
    .map((el) => ({
      selector: describe(el),
      text: trim(el.getAttribute('aria-label') || el.textContent, 100),
    }))
    .filter((entry) => entry.text.length > 1 && entry.text.length < 100)
    .slice(0, 25);

  const clockPattern = /(?:\d{1,2}:)?\d{1,2}:\d{2}/;
  const clocks = all('span, div, time, p')
    .map((el) => ({ selector: describe(el), text: trim(el.textContent, 40) }))
    .filter((entry) => entry.text.length <= 30 && clockPattern.test(entry.text))
    .slice(0, 15);

  const sliders = all('[role="slider"], input[type="range"]')
    .map((el) => ({
      valueNow: el.getAttribute('aria-valuenow') ?? el.getAttribute('value'),
      valueMax: el.getAttribute('aria-valuemax') ?? el.getAttribute('max'),
    }))
    .slice(0, 10);

  const videos = (all('video') as HTMLVideoElement[]).map((el) => ({
    duration: el.duration,
    currentTime: el.currentTime,
    seekableEnd: el.seekable?.length ? el.seekable.end(el.seekable.length - 1) : null,
  }));

  const iframes = Array.from(document.querySelectorAll('iframe'))
    .map((frame) => trim(frame.getAttribute('src'), 120))
    .filter(Boolean)
    .slice(0, 15);

  return {
    url: location.href.slice(0, 200),
    isTop: window.top === window,
    documentTitle: trim(document.title),
    metaTitles,
    headings: all('h1, h2')
      .map((el) => trim(el.textContent, 100))
      .filter(Boolean)
      .slice(0, 10),
    titleish,
    videos,
    clocks,
    sliders,
    iframes,
    shadowRoots,
  };
}

/** Render reports as something readable that can be pasted elsewhere. */
export function formatReports(reports: FrameReport[]): string {
  const lines: string[] = [];

  for (const report of reports) {
    lines.push(`── ${report.isTop ? 'TOP FRAME' : 'IFRAME'}: ${report.url}`);
    lines.push(`   document.title: ${report.documentTitle || '(empty)'}`);

    for (const meta of report.metaTitles) lines.push(`   ${meta.source}: ${meta.value}`);
    for (const heading of report.headings) lines.push(`   heading: ${heading}`);

    for (const video of report.videos) {
      lines.push(
        `   video: duration=${video.duration} currentTime=${video.currentTime}` +
          ` seekableEnd=${video.seekableEnd}`,
      );
    }

    for (const slider of report.sliders) {
      lines.push(`   slider: now=${slider.valueNow} max=${slider.valueMax}`);
    }
    for (const clock of report.clocks) lines.push(`   clock ${clock.selector}: ${clock.text}`);
    for (const entry of report.titleish) {
      lines.push(`   titleish ${entry.selector}: ${entry.text}`);
    }
    for (const frame of report.iframes) lines.push(`   iframe: ${frame}`);

    if (report.shadowRoots > 0) lines.push(`   shadow roots: ${report.shadowRoots}`);
    lines.push('');
  }

  return lines.join('\n');
}
