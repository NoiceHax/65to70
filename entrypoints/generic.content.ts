/**
 * Tier 2 detection — the generic fallback that runs on any granted site.
 *
 * Registered at runtime (never in the manifest) so it only ever runs on origins
 * the user explicitly granted. See lib/permissions.ts.
 *
 * M0: proves runtime registration works and finds media elements.
 * M1: adds the metadata cascade and coverage tracking.
 */
export default defineContentScript({
  registration: 'runtime',
  main() {
    const videos = document.querySelectorAll('video');
    console.log('[keeper] generic content script active', {
      host: location.hostname,
      videos: videos.length,
      frame: window.top === window ? 'top' : 'iframe',
    });
  },
});
