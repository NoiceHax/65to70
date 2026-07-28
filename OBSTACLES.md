# Obstacles and solutions

Everything that went wrong building Keeper, and what fixed it. Written down
because almost none of it was predictable from the outside, and most of it was
a wrong assumption rather than a missing feature.

Ordered by theme rather than by when it happened.

---

## Reading the title

**Non-Latin titles were silently deleted.**
Word normalisation stripped everything outside `[a-z0-9]`, so any Devanagari,
Tamil or Japanese title reduced to an empty string and was then classified as
pure padding and discarded. Found by pointing a probe at a live TMDB page,
which served a Hindi title because of the region.
*Fix: Unicode-aware normalisation.* Not an edge case for an Indian user, a
large fraction of the library.

**Indic vowel signs were deleted too.**
The same class of bug in a different place. `\p{Diacritic}` and `[^\p{L}\p{N}]`
both remove combining marks, and Indic scripts express vowels as combining
marks, so folding an accent turned into deleting half the word. Devanagari
titles stopped matching themselves.
*Fix: keep `\p{M}`, and restrict diacritic folding to Latin base letters.*

**A client-rendered site reported its own brand as the film.**
`og:title` was baked into the app shell as "Cineby" on every page, and it
outranked `document.title`, which the app actually rewrites per route.
*Fix: score candidates instead of taking the first structured one, demote
`og:title` below `document.title`, and reject any candidate matching the
site's own name.*

**Page metadata was only read once.**
Re-reading was keyed on the URL changing. A single-page app sets its real title
well after first paint without touching the URL, so the first wrong snapshot
was captured and never revisited.
*Fix: key on a signature of the extracted values, not the URL.*

**Landing page taglines were queued as films.**
"JioHotstar - Watch TV Shows, Movies, Specials, Live Cricket & Football".
*Fix: three or more commas means a tagline. Two stays allowed, because "Sex,
Lies, and Videotape" is real and losing it is worse than letting a tagline
through to the resolver, which rejects it anyway.*

**The site name rode along into matching.**
"Adarsh Baal Vidyalaya - Cineby". Ranking rejected a title that was *only* the
brand but did nothing about the far more common case of the brand sitting
alongside the real answer.
*Fix: strip whole segments matching the brand. Only whole segments, so a film
containing the site's name survives.*

**URL slugs carried catalogue ids.**
"27205 inception".
*Fix: strip leading and trailing numeric runs of five digits or more, so
four-digit titles like "1917" and "2012" survive.*

---

## Finding the video

**`querySelectorAll` does not cross a shadow boundary.**
Several embed players render into a shadow root, so those pages appeared to
contain no video at all, which is indistinguishable from a page that genuinely
has none.
*Fix: walk shadow roots. Closed roots remain unreachable by anyone.*

**Everything was gated behind finding a `<video>`.**
A page whose title had been read perfectly well produced nothing, because the
element sat in an unreachable frame or a closed root, and the identification
was thrown away with it.
*Fix: a title or a catalogue id queues on its own. Knowing what is being
watched is the point; measuring how much is a refinement.*

**A second film in the same tab was silently dropped.**
It reused the first film's session, and a session that already carries a queued
entry is never queued again. Read correctly, matched correctly, discarded
without a word.
*Fix: each identification gets its own session. Watching two things in one tab
is entirely ordinary.*

---

## Permissions and frames

**Host permissions are per-origin, and `allFrames` only reaches matching frames.**
Aggregator sites serve the player from a different domain, so granting the site
you typed never reaches the frame holding the video.
*Fix: report embedded origins so the missing one can be granted, and
eventually an opt-in all-sites mode.*

**The iframe `src` attribute lies.**
Embed hosts redirect. The markup said `player.videasy.net`, the frame landed on
`player.videasy.to`, and a permission for the first never reached the second.
The page cannot see through that, because a cross-origin frame's real location
is off limits to it.
*Fix: `webNavigation.getAllFrames`, which reports where every frame currently
is after redirects.*

**Player domains rotate, and a server switcher changes them per click.**
One session granted more than fifteen origins. Hydraflix cycled through
`vidsrc.xyz`, `vidfast.pro`, `vidlink.pro`, `vidora.su`, `moviesapi.club`,
`embed.su` and `player.videasy.net`.
*Fix: an explicit all-sites toggle, off by default. Per-origin grants are the
right default and simply cannot win against this.*

**Ad frames were suggested as players.**
A size heuristic misread large ad iframes on an ad-heavy page, and the UI
offered to grant `criteo.com` and an obfuscated malvertising domain. Those were
granted.
*Fix: classify by size and URL shape. Standard ad units are 300x250 or 728x90,
so requiring a box both wide and tall excludes them. Only player-shaped frames
get a button; the rest are listed as probable adverts.*

**A stream of unfamiliar domains to approve is itself the hazard.**
Prompting on every navigation trains people to click yes without reading, which
is exactly how those ad origins got granted.
*Fix: prompt once per site per session, and only for pages that look like
playback.*

**Runtime-registered scripts do not reach already-loaded tabs.**
Repeatedly diagnosed as a permissions bug when the page simply needed a reload.

---

## Measuring how much was watched

**`video.duration` is frequently NaN.**
Players built on Media Source Extensions report NaN until the manifest parses,
and `Infinity` for streams with no declared end. A two-hour film failed the
"is this longer than an advert?" check and was discarded.
*Fix: fall back to `seekable`, and when that is empty too, to sustained
playback.*

**Media readiness is not a DOM mutation.**
The `MutationObserver` fired on the element being inserted, saw NaN, rejected
it, and never looked again, because a duration arriving later changes no
markup.
*Fix: listen for `loadedmetadata`, `durationchange`, `canplay` and `playing`.*

**The runtime was on screen the whole time.**
The most instructive one. `duration` was NaN with an empty `seekable`, while
the player rendered "1:23:45 / 2:14:30" three pixels away. Asking one API and
taking its silence as the answer.
*Fix: read the scrubber's ARIA values, then rendered timestamps. Those values
have to be correct for the player to be usable without sight, so they stay
right when the media element does not.*

**A slider can be reliable for one field and not another.**
JW Player's chapter slider reports a correct `aria-valuemax` and a meaningless
`aria-valuenow`. Using it for position would have corrupted coverage on every
JW Player site, plausibly enough not to notice.

**`seekable` grows while buffering.**
Two consequences: bucket maths drifted as the denominator changed, and a fixed
epsilon read ordinary growth as a media change, tearing down and restarting the
session repeatedly and losing all coverage each time.
*Fix: pin the duration captured at attach, and use a relative change threshold.*

**Progress was read from a single session.**
Ad layers force page reloads, every reload starts a new session, and a film
watched in four stretches reported the last fragment. Spider-Man 3 showed 25%
after being watched in full.
*Fix: union every session for the title, which is what the watched calculation
was already doing correctly.*

**Coverage was unioned across a whole series.**
Opposite halves of two different episodes added up to "complete", marking a
show finished that had never been seen through once.
*Fix: coverage only unions within one episode. Films become a group of one.*

**Measurement on hostile pages is not trustworthy enough to be the only word.**
*Fix: a manual progress override. Not a nicety, the honest response to a
measurement that cannot be reliable.*

---

## Identity and matching

**Films and series have separate id spaces.**
`verifyId` tried movie first when the kind was unknown. TMDB `movie/328402` is
"Ab Tak Chhappan 2" and `tv/328402` is "Adarsh Baal Vidyalaya", entirely
unrelated, and the wrong one was reported as fact.
*Fix: check both when the kind is unknown, and refuse to pick when both exist.*

**Nothing compared the id against the page.**
An id is only as good as the assumption that the site meant the same catalogue.
*Fix: cross-check the resolved title against what the page said, and distrust
the id when they disagree.* Suggested by the user, and the right shape of
answer.

**Short parameter forms were missed.**
`?s=1&e=1` says series. Only `season` and `episode` were recognised.
*Fix: accept the short pair when both are present.*

**A film outranked the series being watched.**
"Wednesday" is a 2022 series and several unrelated films, and matching ignored
which kind had been detected.
*Fix: penalise a media type mismatch. Pushed down rather than ruled out, since
an episode marker can be misread.*

**Episode controls were an unused signal.**
An episode list or a next-episode button is present on a series page and absent
on a film one, and settles the kind even when the URL carries no id.
*Fix: read the controls.* Suggested by the user.

**Adapters read generated class names.**
Prime Video's player classes are hashed and changed, so the adapter found
nothing and a series fell through to generic detection.
*Fix: read `document.title` and the episode heading instead. Both are load
bearing for the page itself, so neither can quietly disappear the way a
generated class name can.* Same lesson as the ARIA scrubber: semantic structure
outlasts styling hooks.

**One adapter emitted no episode at all.**
Every episode of a show on JioHotstar resolved to the same title, so the count
never moved off one.
*Fix: read season and episode from the URL, then from a marker in the player.*

**Only the first matching element was read.**
A series splits its player metadata across two lines, one with the year and
season count, another with the episode. Reading the first found the year and
missed the episode, filing whole series as films.

**A season count is not a season number.**
One player writes "1 Seasons" and never says which season is playing. The
episode can be certain while the season genuinely is not, and a "Show S1E9"
string cannot express that without inventing the half it lacks.
*Fix: carry season and episode separately from the title string. A count of one
settles the number; anything higher leaves it unset.*

**A word-boundary match failed on the case it was written for.**
Adjacent text nodes concatenate, so scanning whole-body text for `S3 E12`
found "...MotherS3 E12" with no boundary before the S.
*Fix: check elements individually, which is more precise anyway.*

---

## The catalogue

**The index contained films only.**
Built from the movie id export and the movie detail endpoint, so no series was
ever in it and none could match. Behind three separate reported symptoms before
anyone looked at what was actually in the file.
*Fix: fetch series too, mapping the fields both kinds name differently.*

**Silence was treated as a verdict.**
The rule added to kill site chrome fired on anything the resolver could not
match, deleted the entry, and returned before the prompt was sent. A correctly
read series was discarded and the viewer saw nothing.
*Fix: the index records what it covers. Silence is only evidence if there was
somewhere to look.*

**Confirming required an API key.**
Everything else worked offline, but confirming fetched details from TMDB, so
the bundled index would identify a title and then refuse to record it.
*Fix: details from the local index by id, network as enrichment.*

**Manual search required an API key.**
The one escape hatch for a title the matcher missed returned silence without
one.
*Fix: search the loaded index first, widen to TMDB only when a key exists.*

**Sites serve titles in the viewer's language.**
So the index has to carry alternative and localised titles, not just the
original, or regional viewing resolves to nothing.

**The daily export carries no year.**
And year is what separates a remake from its original, so details have to be
fetched per title rather than taken from the export alone.

---

## Feedback and interface

**The extension could not report its own state.**
"Nothing happened" is the least actionable report possible, and hours went into
guessing between causes that looked identical from outside.
*Fix: distinguish "script never ran" from "ran but found no player" from "found
a player but no title". Three symptoms, three different fixes.*

**The prompt only appeared on a confident match.**
Anything new or regional produced total silence, so a working extension was
indistinguishable from a broken one.
*Fix: name the title either way. A matched one can be confirmed; an unmatched
one is at least visible.*

**The prompt was drawn where nothing renders.**
While anything is fullscreen the browser renders only the fullscreen element
and its descendants, and a toast on the document root exists and is never
drawn. Fullscreen is the normal state while watching a film.
*Fix: each frame decides. Fullscreen on an iframe means the child draws it.*

**Waiting for 80% before asking.**
Two hours of silence before the extension gave any sign it had noticed.
*Fix: ask at detection. "Is this Supergirl?" is answerable while it is on
screen.* Requested by the user, and a better product.

**The slider reordered the list mid-drag.**
Writing on every pointer move re-sorted the list, and crossing the completion
threshold moved the row from one section to another, so the thing being dragged
jumped away.
*Fix: hold the value locally, commit on release.*

**Dismissals did not stick.**
Site chrome is a stable string, so dismissing it achieved nothing and the same
entry returned every visit.
*Fix: remember dismissals per host, bounded.*

**The settings page demanded work.**
Three "Not loaded" rows and a file picker, expecting the user to run pipeline
scripts and hand-feed JSON to their own extension. A developer workflow wearing
a user interface.
*Fix: ship the indexes in the build and load them automatically.* The earlier
reasoning against bundling applied to a store-distributed extension, not one
loaded unpacked, and the rule was applied without checking its premise held.

---

## Privacy

**It would have tracked everything, including what people would not want named.**
Titles from any site would surface in the toast, tracking strip, badge, queue
and export. Two things limited the damage and both were accidents: the index
excludes TMDB's adult-flagged entries, and Chrome does not run extensions in
incognito by default.
*Fix: an exclusion list passed to the script registration, so nothing runs on
those origins at all. Deliberately not a filter applied after reading, because
by then the title has been read and shown. Plus a pause switch that
unregisters rather than quietly discarding.*

---

## Tooling and build

**The log streamer hid the answer.**
It attached only to CDP targets of type `page`. Under site isolation a
cross-origin iframe is its own target of type `iframe`, so a content script
that *was* running looked identical to one that never ran, and the opposite
conclusion was drawn.
*Fix: attach to iframe targets too.* When evidence contradicts a solid
hypothesis, suspect the instrument.

**A dropped connection destroyed a long run.**
One ECONNRESET forty thousand requests in rejected a `Promise.all` and threw
away everything already fetched. At that volume a dropped socket is ordinary,
not exceptional.
*Fix: retry transport errors, return null after exhausting them, count and
report the losses, and checkpoint so a re-run resumes.*

**Devtools cannot be attached to a running browser.**
The debug port is a launch flag, and several of these sites detect the devtools
panel and respond by blanking or navigating away.
*Fix: a page inspector that runs through `scripting.executeScript`, which needs
no panel open, and reports what every frame contains.*

**A throwaway browser profile wiped permissions on every restart.**
Since the extension asks for nothing at install and is inert until sites are
granted, every dev restart began with an extension that could do nothing, and a
log that looked like a permissions bug.

**Chrome now blocks `--load-extension`.**
Needs `--disable-features=DisableLoadExtensionCommandLineSwitch`, or loading
unpacked by hand.

**A blanket text replacement does not know prose from behaviour.**
Removing em dashes across the codebase broke four regex character classes that
match real page titles, because sites genuinely write "Inception — 2010". The
tests caught it.

**Dynamic imports that bought nothing.**
Five modules loaded with `await import()` to sidestep circular dependencies
that did not exist, obscuring the dependency graph for no benefit. The bundler
pointed it out.

---

## What actually generalises

**Instrument before hypothesising.** Three wrong guesses in a row cost hours;
piping logs to a terminal found the real cause in minutes. If you are on your
second guess, stop and build visibility instead.

**Absence of signal is not absence of the thing.** No video found might mean no
video, a shadow root, an unreachable frame, or a duration you rejected
yourself.

**Prefer sources with a contract.** ARIA attributes, document titles and
heading structure are load bearing for the page. Generated class names are an
implementation detail with no promise attached.

**Ask an authority, not an implication.** `webNavigation.getAllFrames` knows
where a frame is. An `src` attribute only says where it was pointed.

**Incentives predict implementation.** A service that owns its catalogue has no
reason to expose metadata; a site that depends on search traffic has every
reason to. Read the business model and you can predict the DOM.

**Degrade rather than fail.** Identification without measurement is still most
of the value.

**Never ask users to approve what they cannot evaluate.** Prompting for
unfamiliar domains is how ad networks end up granted.

**Wrong data is worse than missing data.** A wrong entry in a diary, a season
invented to fill a gap, a film reported as the series being watched. Every
choice here should prefer saying nothing to saying something false.
