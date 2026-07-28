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
import { tabDiagnostics, type TabDiagnostics } from '@/lib/sessionStore';

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
  const [diagnostics, setDiagnostics] = useState<TabDiagnostics | null>(null);

  const refresh = useCallback(async () => {
    setOrigins(await grantedOrigins());

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) setDiagnostics(await tabDiagnostics(tab.id));
    if (!tab?.url) return;

    setTabOrigin(originPatternFor(tab.url));
    try {
      setTabHost(new URL(tab.url).hostname);
    } catch {
      /* not a web page */
    }
  }, []);

  useEffect(() => {
    void refresh();
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

      {/* "Nothing happened" is the least actionable bug report there is.
          Separating "script never ran" from "ran but found no video" from
          "found a video but no title" turns it into an obvious fix. */}
      {diagnostics && tabOrigin && isGranted(tabOrigin) && (
        <div className="diag">
          <div className={diagnostics.sawVideo ? 'diag-line ok' : 'diag-line warn'}>
            {diagnostics.sawVideo
              ? 'Player found on this page'
              : diagnostics.scriptRan
                ? 'Running here, but no player found yet'
                : 'Not running on this page yet — try reloading'}
          </div>

          {diagnostics.urlIds.length > 0 && (
            <div className="diag-line ok">Identified from URL: {diagnostics.urlIds.join(', ')}</div>
          )}
          {diagnostics.bestTitle && (
            <div className="diag-line ok">Reading title: {diagnostics.bestTitle}</div>
          )}

          {!diagnostics.sawVideo &&
            (() => {
              const ungranted = diagnostics.embeddedFrames.filter(
                (frame) => !isGranted(`${frame.origin}/*`),
              );
              const players = ungranted.filter((frame) => frame.likelyPlayer);
              const others = ungranted.filter((frame) => !frame.likelyPlayer);
              if (ungranted.length === 0) return null;

              return (
                <>
                  {players.length > 0 && (
                    <>
                      <p className="note">
                        The player is served from another domain. Permissions
                        are per-origin, so allowing this site doesn&apos;t reach
                        it:
                      </p>
                      {players.map((frame) => (
                        <button
                          key={frame.origin}
                          className="primary"
                          onClick={() => void toggle(`${frame.origin}/*`)}
                        >
                          Allow {new URL(frame.origin).hostname}
                        </button>
                      ))}
                    </>
                  )}

                  {/* Listed, but not offered as a button. These pages are full
                      of ad frames and prompting someone to hand an extension
                      access to an unidentified ad network is not something to
                      put in front of them. */}
                  {others.length > 0 && (
                    <p className="note dim">
                      Also embedded, probably adverts — not needed for tracking:{' '}
                      {others.map((f) => new URL(f.origin).hostname).join(', ')}
                    </p>
                  )}
                </>
              );
            })()}
        </div>
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
