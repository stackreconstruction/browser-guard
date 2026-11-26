# Rules for software that touches other people's pages

These come from fixing and pentesting **ig-rb-ext** (a Chromium extension that scans
pages, saves media and pages, and runs tools on them; `review.md` there has every
finding). They hold for any browser extension, and most for any app that embeds
itself in, scrapes, proxies or saves third-party pages. Each rule says what went
wrong, what to do, and how to test it. The code in `src/` does the doing; the tools
in `testing/` and the steps in [PENTEST.md](PENTEST.md) do the testing.

The model in one line: **the page is hostile, and so is everything it names; your
privileged context must not lend it your privileges; and nothing you do should tell a
site more than the user's own browsing already does.**

---

## 1. Presence: be nowhere you weren't asked to be

**1.1 Opt in per site; nothing on other pages.**
*What went wrong:* every page got a button, listeners, fonts and (on X) a wrapped
`fetch`, so every site and its trackers could see and trigger the extension.
*Do:* register content scripts per site when the user turns it on
(`siteActivation`), never in the manifest's `content_scripts`, and no
`web_accessible_resources` (pages can probe for them).
*Test:* on a site that is off, the page sees no element, no font, a native `fetch`, and
no event or mutation of yours (`pageSees`, `watchFromPage`).

**1.1b In the page's world only while needed.** A content script's `fetch` is its own:
to read what a site's API answers its page you must wrap the page's `fetch`, which the page
can see (`fetchNative` false). *Do:* inject the wrapper (`pageResponses`) from the worker
into the asking frame only, on a site that is on, only while something waits for it, under
a name new each time; put the page's `fetch` back when done. A wrapper registered for every
page of the site (as X's `tw-interceptor.js` still is) is there for good. *Test:*
`fetchNative` stays true while nothing waits, and is true again after.

**1.2 Keep the on/off list yourself, and make the browser match it at start.**
*What went wrong:* `persistAcrossSessions: false` lost every site at restart; an
extension reload or update can drop registered scripts.
*Do:* the list in storage is the truth; at every worker start, register what's
missing and unregister what isn't listed (`siteActivation` does).
*Test:* restart the browser on the same profile (Playwright `launchPersistentContext`
twice); unregister everything, restart, check it comes back.

**1.3 Batch APIs fail all or nothing.**
*What went wrong:* `unregisterContentScripts({ ids })` with one id that wasn't
registered (the X-only script, off X) removed nothing, and a `.catch` hid it: turning
a site off left it on for its next page.
*Do:* ask what's registered and pass only those; never swallow errors from state changes.
That goes for protections set up at start too: `installSessionRules` rejects when the
browser refuses a rule, and `siteActivation`'s `synced` tries every site, then rejects
naming the ones it couldn't register. Report them (in an extension, `console.error` shows
under Errors on chrome://extensions); a `.catch(() => {})` there hid missing cookie or
local-network protection, and test stand-ins missing whole APIs.
*Test:* turn off, then load a *new* page of the site (not just the open one); make the
browser refuse a rule or a registration and check it is reported.

**1.4 One change at a time.** Two quick clicks, or a click while the worker starts,
interleave async steps (read list, write list, register). Queue them (`inTurn`).

**1.5 Turning off removes everything**, from open tabs too: a message to them, and
the scripts unregistered.

**1.6 State a privileged decision reads is written only by trusted contexts.**
*What went wrong:* the on/off list was in `chrome.storage.local`, which content scripts
can write too: one compromised renderer on a site that is on (or a bug in your content
script) could add a site, and the next worker start registered the scripts there, with no
message from the extension's own page involved. The sender check guarded the message, not
the state behind it. *Do:* keep such state where a content script can't write it
(`trustedStore`: IndexedDB of the extension's origin; `chrome.storage.session` is trusted
by default but lasts only the browser's session; `chrome.storage.local.setAccessLevel`
closes the whole area, settings your page UI reads included), mirrored to `storage.local` for display only; take it from your own page by a message
checked with `fromExtensionPage`; and re-check at the point of use what still comes from
shared storage (an address before `tabs.update`: `webUrl`). *Test:* write the shared copy as
a content script could, restart, and check nothing changed (`tests/browser-activation.mjs`).

## 2. What a page can do to what you put in it

**2.1 Closed shadow root.** The page's scripts get no reference inside, so they can't
read what you show (a user's library) or press your buttons. Keep an *open* root only
in a test build, for selectors, and run the security tests on the production build.

**2.2 Only the user's input counts.** Pages dispatch made-up keys, clicks and hovers.
Check `event.isTrusted` (`byUser`) on every listener that acts. *Test:* `fakeInput`,
then check nothing happened, then a real `page.keyboard.press` does.

**2.3 Take no click you don't draw.** *What went wrong:* the gaps between side panels
and the area around a hover button swallowed the page's clicks. *Do:* a zero-size,
`pointer-events: none` host; `pointer-events: auto` only on what is drawn; layout
wrappers stay `none`. *Test:* `clicksTaken(hostSelector)` must be 0 in every layout.

**2.4 Anything in a page can be covered (clickjacking).** A page can lay its own
transparent layer over your UI, see where the user clicks, or show fake controls with
holes over real ones ("remove all", a download). A Document Picture-in-Picture window
does *not* fix it: it belongs to the page's origin, and a test page covered one 300ms
after it opened. *Do:* put settings and anything destructive in an extension page (a
`chrome.windows.create({ type: 'popup' })` window or a tab) and talk to the page's side
over a port (`agentPort`). *Test:* `coverPage()`, then click your UI; `window.__caught` must stay empty.

**2.4b Let the user see through you.** Whatever you draw covers part of the page. Give
the user a way to click under it that the page can't trigger: a held key, trusted
events only, the switch a style inside the closed root (the page sees no change). Watch
for a modifier key's own meaning: Ctrl+click opens a link in a new tab, so a link clicked
through you with Ctrl held gets a plain click instead (the browser's default stopped, then
`link.click()`: the page's handlers run once, and the browser applies the link's target,
`rel=noreferrer` and `referrerpolicy` itself; following it by hand with `window.open` lost
those). On a Mac, Control+click is the right click (a menu, no click at all): over your UI,
while seen through, stop the menu and give what is under it a plain click. You stay
see-through for a moment after the key is let go (`seeThroughWhileHeld`). Small controls
that sit on the page's own content (a save button on a thumbnail) can stay solid
(`STAYS_SOLID`): they are what the user reaches for there. *Test:* real
`keyboard.down`, a click at your UI lands on the page, one at a solid control lands on
it; a dispatched key, or a quick shortcut, changes nothing.

**2.4c Hostnames have more than one spelling.** A name's final dot (`localhost.`,
`nas.local.`) is the same host to the browser's resolver: checks of names (`isLocalHost`,
network-rule patterns) strip or allow it, or a page names the local network past them.
An IPv6 host keeps colons inside its brackets: ids or keys built from hosts must not split
on `:`. *Test:* every check of a host list with the trailing-dot and bracketed forms.

**2.5 No fixed names.** A fixed element id, CSS class, global, font family or event
name lets any page detect you. Name your host afresh per page (`createPageHost`), load
fonts from bytes under random family names, keep nothing on the page's globals.

**2.6 Don't let page events drive your lifecycle.** *What went wrong:* the event a
re-injected copy fired to replace the old one could be fired by the page, unmounting the
extension (and its window's connection). *Do:* signal between copies through the
isolated world's own global; heed a document event only in a copy an extension reload
cut off (`chrome.runtime.id` gone) — `replaceable` does both, and removes each copy
once, with its listener. *Test:* fire the event from the page; scanning must go on.

**2.7 Treat a content script's requests as the page's.** It runs in a document a site
controls. Privileged actions (turning a site on, settings, anything account-wide) are
taken only from the extension's own pages (`fromExtensionPage`), never from a content
script.

**2.8 Expect the page to throw your element out.** *What went wrong:* a reader view made
of the page (Obsidian Web Clipper's) empties `<body>` and builds its own; the extension's
host went with the rest while everything in it stayed mounted, so the extension said it
was on and showed nothing until turned off and on. *Do:* watch the children of `<html>`
and `<body>` (not the subtree) and append the host again when it is out of the page, no
more than a few times a second (`keepInPage`). Keep nothing in state that a re-insertion
resets: a `<style>`'s `disabled` is one (use its `media`). *Test:* empty the body, then
replace it; the host is back and its button takes a click.

**2.9 Page text written into a file's own syntax stays text.** A title is the page's to choose: put
into YAML front matter as it is, `Title\n---\nevil: 1` ends the block and adds a key that the
programs reading it (a notes app, a hub filing by `tags`) act on. *Do:* one double-quoted value per
line, `"` and `\` escaped, line breaks and characters YAML can't hold removed, capped before escaping;
the keys only your own. The same for a file name: keep letters of every script, replace what the file
system forbids and the direction marks (U+202A–E, U+2066–9) that can make `…gpj.exe` read `…exe.jpg`.
*Test:* a title holding a newline, `---` and a key gives exactly your keys and two rules.

## 3. Messages and ports

**3.1 Check the sender in every listener** (`fromOwnExtension`), even where only your
code can send: it's one line and closes the door if that changes.

**3.2 A port runs only what it was given.** Call only the receiver's *own* functions
by name (`hasOwnProperty`, not `constructor` or `toString`), with array arguments, and
send data only. *What went wrong:* a function handed straight to `onClick` sent the
click event across, which can't be cloned, so the call silently didn't happen.

**3.3 Send what changed.** Sending a whole state object on every change (thousands of
URLs per scan) is waste; send the changed fields, and keep an object's identity while its
content is the same.

**3.4 Everything a page supplies is untrusted: URLs above all.** *What went wrong:*
`javascript:` links in SVG and `<form action>` survived into saved pages, where they
run; an SVG `<a href>` is an `SVGAnimatedString`, not a string, and crashed every scan.
*Do:* keep `http(s)` only (`webUrl`), resolve before checking, read hrefs the way that
works for SVG too. An extension page's CSP also blocks `javascript:` links: rely on it as
the second line, not the first.

**3.5 What the page's world hands you is the page's.** Events from a page-world script can
be read, forged or stopped by the page. *Do:* take data only (strings), parse it as
hostile (`webUrl`-like checks, a size cap, shapes you expect), act on it only for what the
user already asked for, and let a stop from the page be a denial, not a breach.

**3.6 A stored secret that is empty matches nothing.** A token read from a file and compared to
what a request carries lets in everyone who carries nothing, once the file is empty. *What went
wrong* in ig-rb-ext's `mobile/server.py` (fixed 4.62.1): a power cut just after the token file was
first written (not synced) left it empty, the token became `''`, and a request with no token
matched it. *Do:* take a secret from a file only if it has the shape you write (length and
alphabet: a zeroed file is not empty, but is no secret either), replace it otherwise and say so;
refuse an empty secret in the comparison itself too; write it created readable by its owner only,
synced, then renamed into place. *Test:* empty, blank, zeroed and short files, each refusing a
request with no secret (`tests/mobile-server.test.mjs`).

## 4. Network: what your requests tell sites

**4.1 Fetch for a page without cookies and without following redirects.**
`credentials: 'omit'`, `redirect: 'error'` (`fetchForPage`). From another origin the
cookies are third-party ones tracker blocking withholds, and your host access would
send them anyway; a redirect can bounce a privileged request anywhere (4.3).

**4.2 Your own pages are first-party everywhere.** *Measured:* an `<img>` in an
extension page sent the site's cookies (even `SameSite=Lax`) and accepted `Set-Cookie`.
`crossorigin="anonymous"` still sent them, and added `Origin: chrome-extension://<id>`,
naming the extension to every site. *Do:* a session `declarativeNetRequest` rule
removing `Cookie` and `Set-Cookie` for your own image/media requests
(`anonymousMediaRule`, installed at every start), `referrerpolicy="no-referrer"`, and
never `crossorigin` for this. *Test:* `startLoggingServer`; `toldSomething(requests)`
empty; no `planted` cookie afterwards.

**4.3 You can reach the local network; the page can't.** Chrome keeps public pages from
the local network (Private Network Access); not extensions. A page that names
`http://192.168.1.1/...` (or redirects to it) gets *you* to request it.
*Do:* `reachableFrom(url, pageUrl)` before any fetch or load for a page; block your own
media requests to local addresses with DNR while the page shown is public
(`localMediaBlockRules`: catches redirects, which a URL check can't). "Local" is the Local
Network Access spec's list, not just RFC 1918: carrier-grade NAT (100.64.0.0/10, where
Tailscale puts devices), benchmarking (198.18.0.0/15), unique- and link-local IPv6.
*What went wrong:* the IPv6 checks ran on every hostname, and `parseInt('fd00.com', 16)`
is `0xfd00`: a page on `fd00.com` counted as a local page, so the extension would fetch
the router for it. Classify a host by its kind (only an IPv6 address has a colon) first.
*Still open:* a public *name* that resolves to a local address (DNS rebinding, or a
name pointed at 192.168.x.x) passes every check made on the URL, and DNR matches URLs
too. An extension can't see the address before it connects; the browser's own
protection doesn't cover extension requests.
*Test:* `mapHosts({ 'public.test': …, router: … })` and check the server never sees `router`.

**4.3b A server that fetches for a page closes what 4.3 leaves open.** A server (not an
extension) sees the address before it connects. *Do:* resolve the name, refuse it if *any*
address it resolves to is local, then connect to the address checked (not the name again,
which a rebinding DNS answers differently the second time), and do the same for every
redirect. Allow http(s) only, by building the client from the handlers you mean: *what went
wrong* in ig-rb-ext's `mobile/server.py`: Python's `urllib.request.build_opener()` adds file:
and ftp: handlers, so `?url=file:///etc/passwd` read the server's own files, until the opener
was assembled from http(s) handlers alone. *Test:* local addresses, `localhost`, `[::1]` and
`file:` all refused, with the fixture server seeing nothing (`tests/mobile-server.test.mjs`). A
redirect to a local address is refused by the same check, in the handler every hop goes through,
but is untested there: it needs a public server that redirects. A tool that fetches for
itself (yt-dlp) gets the same check on the address it is handed, before it starts: *what went
wrong*: the server's yt-dlp routes checked the scheme alone, so a captured page naming
`http://192.168.1.1/v.mp4` sent yt-dlp into the home network (ig-rb-ext deep review of
4.101.0, S1). Its own redirects and follow-up requests are past the check; say so, or route
it through a proxy that applies it.

**4.3c A browser a server drives asks the network nothing itself.** A headless browser that
runs a page's scripts for a server (to render or archive it) would otherwise connect wherever
the page says, the local network included, past 4.3b. *Do:* route every request (Playwright's
`context.route('**/*')`) and answer it with the server's own guarded fetch; close WebSockets
(`route_web_socket`); block service workers; point its proxy at a closed port with
`<-loopback>` in the bypass list (Chromium otherwise reaches loopback directly) and WebRTC at
proxied UDP only; drop `Cookie` and `Set-Cookie`. *Test* (ig-rb-ext `tests/mobile-server.test.mjs`,
"every part"): a page that opens a WebSocket to its own server and sets a cookie; the server
sees no upgrade and no `Cookie` header.

**4.3d A saved page's scripts run only on an origin that holds nothing.** Replaying an archive
with its scripts (a service worker answering from it) runs whatever the page's scripts do with
the origin's storage and endpoints. *Do:* serve the replay on an origin of its own (another port
is enough), with no API, no token and no app there; hand it one file by an unguessable ticket
the authenticated app asked for; keep its requests on it (`connect-src 'self'` and the rest) and
check the policy the replayer gives replayed pages (ReplayWeb.page allows `ws: wss:`: narrowed in
ig-rb-ext's `mobile/replay.py`, and a version not checked is not served). *Test*
(`tests/mobile-server.test.mjs` "replay", `tests/browser-mobile.mjs`): no `/api` on the replay
origin, tickets only for archives in the folder, and a replay with the site gone asks nothing of
any other address.

**4.4 Don't re-request what the page didn't load.** *What went wrong:* scanning and
saving re-requested tracking pixels and images that tracker blocking had stopped, with
the page as referer. *Do:* skip 1×1 and failed images (`complete && naturalWidth <= 1`).

**4.5 Copy DOM inertly.** *What went wrong:* `cloneNode` in the live document made the
copy's images load again; setting `src` from `data-src` on an article's copy loaded
images the page never had. *Do:* `inertCopy` (a document with no window).

**4.6 Rewrite headers narrowly and briefly.** Header rules match only your request
(`initiatorDomains: [runtime.id]`, `tabIds: [TAB_ID_NONE]`, the resource type, the host)
and are removed when it answers. Ported rule sets carry surprises: Ladder's
`x-forwarded-for: none` *sends* the literal header `none`; its forged Google
`X-Forwarded-For` is a lie and was dropped.

**4.7 Saved or exported HTML asks the network for nothing.** A CSP meta first in
`<head>` (`SAVED_PAGE_POLICY`), everything embedded as `data:`, `ping` and preloads
dropped, `<base>` dropped, cross-origin `<iframe>`s turned into links, media
`preload="none"`. *Test:* open the saved file with all routes aborted except `data:`;
zero requests. The one exception is `font-src 'self'`: a reader that serves the file (the
cs-learning hub) may dress it in its own typeface; `'self'` is whoever serves the file, never
the site it came from, and the saved page itself asks for nothing.

**4.8 Decode in the page's charset.** `response.text()` is UTF-8; legacy pages
(`windows-1252`) turn to mojibake. Use the header's charset, else `<meta charset>`.

**4.9 Be honest about the IP.** An extension can't change the IP of one request
(`chrome.proxy` is browser-wide). Offer a user-named proxy where it matters, say what the
proxy then learns, and leave the rest to the browser's own proxy or VPN.

## 5. Testing, so the claims are true

**5.1 Measure; don't reason.** Every privacy claim above was wrong once until a server
logged the headers. Log cookie, Referer, Origin, `Sec-Fetch-*` (`startLoggingServer`).

**5.2 Make the test fail on the old code.** Stash the fix, rebuild, run: it must fail.
*What went wrong:* `html.replace('REMOTE', …)` replaced one placeholder of several, so
the privacy assertions passed vacuously for weeks; `replaceAll` exposed real leaks.

**5.3 Test the production build** for anything about what a page can see (closed roots,
random ids); a test build may open things up for selectors. Build both in the test script.

**5.3b Launch one way.** `launchWithExtension(dir, { profile, args })` (`testing/`) loads
the unpacked extension in a persistent context; every test using it means one place to
change the browser, its flags or where Playwright comes from.

**5.4 Headless isn't a browser.** Every page counts as focused (clipboard and focus
paths can't be staged); popup windows report their own size, not the viewport you set
(resize them with `chrome.windows.update`). Route fake sites with
`context.route()` or `--host-resolver-rules` instead of the internet.

**5.5 Fixtures that look like the real thing find the real bugs**: a card whose id
contains "title" broke a "title link" heuristic; a header image on every page showed
re-detection reordering a list; a site that sets its link on hover showed lookups
running too early.

**5.6 Hostile page, every surface, both states.** Before turning on, after, and after
turning off; in the page and in your extension page; see [PENTEST.md](PENTEST.md).

---

## 6. Safari (and browsers other than Chromium)

Safari runs Manifest V3 web extensions, with the same `chrome.*` names, but does less of
some APIs and differs where it protects users. Support data: MDN's browser-compat-data
(October 2026). None of this has run in a real Safari yet: PENTEST.md §8 before trusting it.

**6.1 Your origin isn't your id, and in Safari it changes.** Chrome's pages are
`chrome-extension://<id>`; Safari's are `safari-web-extension://<UUID>`, a UUID that
isn't `runtime.id` and is new at every Safari launch (sites can't fingerprint it).
*What would have gone wrong:* every rule here named the extension's own requests
`initiatorDomains: [runtime.id]`, which no request carries in Safari (or Firefox): the
cookie and local-network rules would have matched nothing. *Do:* `extensionHost()`,
worked out at each start; session rules only (re-installed at every start, so they
always name this launch's host); never store an extension URL across launches.
`sender.id` is still `runtime.id`, so `fromOwnExtension` holds; `fromExtensionPage`
compares URLs of one launch. *Test:* `guard.test.mjs` with Safari's URL; on a Mac,
restart Safari and check `getSessionRules()` names the new host.

**6.2 Network rules: Safari does less, and later.**
- `initiatorDomains` only from Safari 26. Older, a rule meant for the extension's own
  requests is refused or hits every page (cookies stripped from every site's pictures,
  local pictures blocked everywhere): require 26 (`strict_min_version`).
- No `tabIds`: narrow by initiator alone.
- No `responseHeaders`: `Set-Cookie` on answers to the extension's own media can't be
  removed, and a rule asking is refused; `anonymousMediaRule` leaves it out there. What
  still keeps a site from planting a cookie is Safari's cross-site cookie blocking
  ("Prevent cross-site tracking", on by default), unless Safari treats an extension page
  with host access as first-party, as Chrome does. Measure it: `startLoggingServer`
  tries to plant `planted=1`. If it lands, load the window's media through
  `fetchForPage` (no cookies either way) instead of `<img src>`.
- `regexFilter` in WebKit's content-blocker subset: `.`, `[a-b]`, `?` `+` `*`, groups,
  `^` `$`; no `|`, `{n,m}`, `(?:`, `\d` or `[^…]`. A rule outside it is refused.
  `LOCAL_URL_PATTERNS` keeps to it (one alternative per pattern; a unit test holds it
  there), and Chromium takes the same patterns.
- Header rules that set headers (`User-Agent`, `Referer`) need Safari 16.4; whether Safari
  lets a rule set every header Chrome does is untested.

**6.3 Site access is the user's, site by site.** Safari grants host access per site at
the user's word, whatever `host_permissions` asks; a site turned on without it gets no
script. That is rule 1.1 done by the browser too: keep both. *Do:* ask in the user's
click, before anything is awaited (`requestSiteAccess`, then `toggle(host, access)`); a
no leaves the site off, and a request the browser refused to make is an error, not a no.
A worker's fetches for a page (a saved page's files on a CDN) reach only hosts the user
granted: let them fail rather than ask for more. *Test:* deny; nothing is registered and
the page sees nothing (`pageSees`).

**6.4 No helper programs.** Safari's native messaging reaches only the extension's own
app (its `SafariWebExtensionHandler`), sandboxed; it can't start yt-dlp or a Python host.
Don't open a port and hope: refuse at once, in words the UI already understands. If the
app ever relays for the extension, treat every message as page input (an allowlist of
commands, no shell, no paths or arguments from a page), within the App Sandbox.

**6.5 In Safari the page reaches the local network too; the extension reads it.** WebKit
has no Local Network Access restrictions: a public page can already send requests to
192.168.x.x, blind (CORS hides the answers). The extension, with host access, reads them.
Rule 4.3 stands, and matters more: nothing else in Safari stops it.

**6.6 Private windows.** Safari, like Chrome, can let an extension into private windows
(off until the user allows it). Decide what a private window may leave behind (a saved
item, a site turned on) and test with it allowed.

**6.7 Storage across launches.** Whether the extension origin's IndexedDB and
localStorage outlive a Safari launch, with the origin new each time, isn't documented
(`chrome.storage` is the browser's own and stays). Restart Safari and check before
trusting a library to IndexedDB there; keep an export.

**6.8 What holds as in Chrome.** Closed shadow roots, content scripts' isolated world,
`isTrusted`, sender checks, the port's name and sender check, inert copies, the saved
page's CSP: the same rules in WebKit's DOM, once PENTEST.md §8 has shown it.

**6.9 A browser with part of the APIs (Orion on iOS).** Some browsers install Chrome or
Firefox extensions and implement a share of the APIs, without saying which. *What would
have gone wrong:* a worker reads `chrome.windows.onRemoved`, `chrome.commands` or
`chrome.declarativeNetRequest.RuleActionType` while its script loads; the first one
missing throws, and every listener registered after that line never exists: the extension
installs and does nothing. *Do:* ask for every API you can do without with `?.`, at the
top level above all; build a rule inside the promise that installs it, so its failure is
reported and nothing else stops. Reach the user by a popup (`action.default_popup`), the
surface such a browser is surest to have, not by `action.onClicked` or a window
(`actionOpensPopup()`). Don't rely on `registerContentScripts` there:
`siteActivation({ persistent: false })` and put the scripts in on `tabs.onUpdated`. Never
fall back to `content_scripts` on every site with a check inside: that is a script on
sites nobody turned on (1.1). A protection that is missing is *said* (`missingApis()`,
shown to the user: a phone has no console): without `declarativeNetRequest` the extension
page's pictures carry cookies (4.1), and the user should know before looking at them.
Untried in Orion itself: PENTEST.md's checks apply there as in Safari.

### What is still yours to decide in each app

- Anything shown *in* a page can be hidden or covered by it. Keep only harmless,
  reversible actions there.
- A page can always refuse to be scanned (remove your element, change its DOM). Treat
  "the page stopped us" as a denial, not a breach.
- The user's IP, and what yt-dlp-like local tools send, are outside the extension.

**5.7 Show the user what the guards did.** A privacy claim the user can't see is one they
have to take on trust. Log each request the extension makes for a page and what it kept
from the site (cookies, Referer, redirects), each address it refused and why, and each
made-up input a page fired that it ignored; let each line open on its facts and on the
code that decided it (`guardLog`: `reportGuard`, and `sourceOf` on source the worker
carries, not the page). What a page can repeat at will is reported at most once in a
while (`reportRepeated`), so it can't flood the log. *Test:* a page naming a local
address and firing made-up keys; the log shows the fetch (and the server saw no cookie or
Referer), the refusal and one line for the keys, and the code it opens is the code that ran.
