import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  SEARCH_SITES,
  SUGGESTED_SITES,
  grantedOrigins,
  originPatternFor,
  requestSite,
  revokeSite,
} from '@/lib/permissions';

/**
 * Per-site permissions.
 *
 * Keeper asks for nothing at install and is inert until a site is turned on
 * here. That is the whole privacy argument, so this screen states it plainly
 * rather than burying it.
 */
export default function Sites({ onChange }: { onChange: () => void }) {
  const [origins, setOrigins] = useState<string[]>([]);
  const [tabOrigin, setTabOrigin] = useState<string | null>(null);
  const [tabHost, setTabHost] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOrigins(await grantedOrigins());
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;
      setTabOrigin(originPatternFor(tab.url));
      try {
        setTabHost(new URL(tab.url).hostname);
      } catch {
        /* not a web page */
      }
    })();
  }, [refresh]);

  const isGranted = (origin: string) => origins.includes(origin);

  const toggle = async (origin: string) => {
    if (isGranted(origin)) await revokeSite(origin);
    else await requestSite(origin);
    await refresh();
    onChange();
  };

  const known = [
    ...SUGGESTED_SITES.map((s) => s.origin as string),
    ...SEARCH_SITES.map((s) => s.origin as string),
  ];
  const custom = origins.filter((o) => !known.includes(o));

  return (
    <section>
      <h2>Watched sites</h2>
      <p className="note">
        Keeper only runs on sites you turn on here. Nothing is requested at
        install.
      </p>

      {tabOrigin && !isGranted(tabOrigin) && (
        <button className="primary" onClick={() => void toggle(tabOrigin)}>
          Watch {tabHost}
        </button>
      )}

      <ul className="sites">
        {SUGGESTED_SITES.map((site) => (
          <li key={site.origin}>
            <label>
              <input
                type="checkbox"
                checked={isGranted(site.origin)}
                onChange={() => void toggle(site.origin)}
              />
              {site.label}
            </label>
          </li>
        ))}
        {custom.map((origin) => (
          <li key={origin}>
            <label>
              <input type="checkbox" checked onChange={() => void toggle(origin)} />
              {origin.replace('*://', '').replace('/*', '')}
            </label>
          </li>
        ))}
      </ul>

      <h2 className="spaced">Search results</h2>
      <p className="note">
        Marks films you have already seen or saved when they show up in search
        results. Granted separately, because these pages have nothing to do with
        playback. Nothing is reordered or rewritten — only annotated — and no
        request leaves your machine.
      </p>

      <ul className="sites">
        {SEARCH_SITES.map((site) => (
          <li key={site.origin}>
            <label>
              <input
                type="checkbox"
                checked={isGranted(site.origin)}
                onChange={() => void toggle(site.origin)}
              />
              {site.label}
            </label>
          </li>
        ))}
      </ul>

      <button className="link" onClick={() => void browser.runtime.openOptionsPage()}>
        Settings and data export
      </button>
    </section>
  );
}
