# browser-guard

The security and privacy model of ig-rb-ext, packaged for other extensions and apps
that touch pages they don't own: what was fixed, as code; why, as rules; how it was
broken and checked, as test tools and a playbook. Private, for my own projects.

- [RULES.md](RULES.md): the rules, each with what went wrong, what to do, and how to test it.
- [PENTEST.md](PENTEST.md): the checklist to run against a build before trusting it.
- `src/`: the fixes, as TypeScript for Chromium MV3 extensions (most of it works for any web code).
- `testing/`: the pentest tools, plain Node/Playwright, no build step.

## Use it in another project

Copy the folder, or depend on it from disk:

```json
"dependencies": { "browser-guard": "file:../ig-rb-ext/packages/browser-guard" }
```

It ships TypeScript sources: the project's bundler (Vite, esbuild) compiles them.
Everything imported from `browser-guard` is plain TypeScript over the `chrome` APIs:
no framework. The optional peers are for parts you may not use: `@types/chrome` to
type-check, React for the hooks in `browser-guard/react`, Playwright for `testing/`.
Chromium, Manifest V3. Safari 26+ support (RULES.md §6) is kept but no longer
maintained or tested: the app using it decommissioned Safari (4.22.0).

## `src/`: the fixes

| Module | Gives | Rule |
| --- | --- | --- |
| `browsers` | `extensionHost()` (your origin's host, as network rules see it: Chrome's id, Safari's per-launch UUID), `onSafari()`, `requestSiteAccess(host)` (in the user's click: Safari grants sites one by one), `actionOpensPopup()` (a build whose toolbar button opens a page of the extension), `missingApis()` (the optional APIs this browser lacks, with what each costs: to show the user). | 6.1, 6.3, 6.9 |
| `siteActivation` | Opt in per site: `siteActivation({ scriptsFor })` → `activate`, `deactivate`, `toggle(host, access?)`, `isOn`, `sites`, `synced`, `inTurn`. Registers content scripts per host, keeps the list in `trustedStore` (content scripts can't write it), makes the browser match it at every start (`synced` rejects naming any site it couldn't), queues changes. `persistent: false`: keeps the list only, for a browser where scripts can't be registered; the caller puts them into each page as it loads. | 1.1–1.6, 6.9 |
| `trustedStore` | `trustedGet(key)`, `trustedSet(key, value)`: state a privileged decision reads, in IndexedDB of the extension's origin (out of content scripts' reach), mirrored to `chrome.storage.local` for display; the first read takes over `storage.local`'s value; `storage.local` alone where the worker has no IndexedDB. | 1.6 |
| `pageHost` | `createPageHost(document, css)`: a zero-size, click-through host with a closed shadow root and a fresh random id. `replaceable(name, remove)`: re-injection without a page-fireable event. `keepInPage(container, signal)`: the host put back when the page empties or replaces its body (a reader view). `seeThroughWhileHeld(shadow, signal)`: hold Ctrl to click the page under it (a link as a plain click), except elements marked with `STAYS_SOLID`. `fromHost`. | 2.1, 2.3, 2.4b, 2.5, 2.6, 2.8 |
| `senders` | `fromOwnExtension`, `fromExtensionPage(sender, path)`, `byUser` (`isTrusted`), `webUrl` (http(s) only, SVG-safe). | 2.2, 2.7, 3.1, 3.4 |
| `agentPort` | Drive a content script's agents (data and functions) from an extension page over a port: diffs of data, own functions by name, events dropped. Tab side `serveAgentsToWindows(getAgents, name?)` → `changed`, `stop` (only your own extension's pages, on the port's name); window side `connectToTab(tabId, onAgents, { name, retryMs, retries })` → disconnect. Underneath, `serveAgents` / `remoteAgents` on any port-like pair. | 2.4, 3.2, 3.3 |
| `react` (`browser-guard/react`) | `useAgentServer(agents, name?)`, `useRemoteAgents(tabId, generation, name?)`: the same as hooks. The only module that needs React. | 2.4 |
| `extensionRequests` | `fetchForPage` (no cookies, no Referer, no redirects), `anonymousMediaRule` (DNR: no `Cookie`/`Set-Cookie` on your pages' media), `localMediaBlockRules`, `installSessionRules` (rejects if the browser refuses them: report it), `ANONYMOUS_MEDIA` (no referrer). | 4.1–4.3, 4.6 |
| `localNetwork` | `isLocalHost`, `isLocalUrl`, `reachableFrom(url, pageUrl)`, `LOCAL_URL_PATTERNS` (DNR regexes): the Local Network Access spec's non-public blocks, plus `.local` and bare names. | 4.3 |
| `guardLog` | `reportGuard(event)` / `onGuardEvent(listener)`: what the guards did (a request and what it withheld, a refusal, made-up input ignored), for a log the user reads. `reportRepeated(key, event, ms)`: what a page can repeat, at most once in a while. `sourceOf(source, name)`: one declaration's source, to show the code behind an event. | 5.7 |
| `pageResponses` | Read a site's API answers to its page from a content script: `listenForPageResponses(channel, onText)` → stop; `injectPageResponseTap(sender, name, needle, maxLength, allowed)` in the worker (the asking frame only, a one-off name from `tapName`); `tapPageResponses`, the page-world wrapper of `fetch` (JSON) and XHR, undone on stop. What comes back is page input. | 1.1b, 2.5, 2.7, 3.5 |
| `inertCopy` | `inertCopy(node)`: copy DOM without loading anything. `SAVED_PAGE_POLICY`: CSP for saved HTML. | 4.5, 4.7 |

A worker, in short:

```ts
import { siteActivation, anonymousMediaRule, installSessionRules, fromExtensionPage } from 'browser-guard';

const sites = siteActivation({
  scriptsFor: host => [{ js: ['content.js'], matches: [`*://${host}/*`], runAt: 'document_idle' }],
  onOff: host => chrome.tabs.query({ url: `*://${host}/*` }).then(tabs => tabs.forEach(tab => chrome.tabs.sendMessage(tab.id!, { off: true }))),
});
installSessionRules([anonymousMediaRule(1_000_000)]).catch(error => console.error('media go with cookies', error));
sites.synced.catch(error => console.error(error)); // names the sites that didn't register
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.channel !== 'site' || !fromExtensionPage(sender, 'panel.html')) return; // never from a content script
  sites.toggle(message.host).then(reply);
  return true;
});
```

## `testing/`: the pentest tools

- `extensionBrowser.mjs`: `launchWithExtension(dir, { profile, args, ...playwright })`:
  Chromium with the unpacked extension loaded (Playwright's own, or `CHROME_EXECUTABLE`;
  Playwright from `PLAYWRIGHT_MODULE` if it lives elsewhere). Also exports `chromium`.
- `loggingServer.mjs`: `startLoggingServer(routes)` logs what each request told the
  site (cookie, Referer, Origin, `Sec-Fetch-*`, host) and tries to plant a cookie (a
  route is an answer, or a function of the request giving one, e.g. a redirect naming the port);
  `toldSomething(requests)`; `mapHosts({ 'public.test': '127.0.0.1', router: '127.0.0.1' })`
  for a public site and a local device on one machine.
- `pageProbes.mjs`: run as the page (`page.evaluate`): `pageSees`, `watchFromPage`
  (`addInitScript`), `coverPage` (clickjacking layer), `clicksTaken(hostSelector)`,
  `fakeInput(target)`.

ig-rb-ext imports every module from here (`src/background.ts`, `src/mountPanel.tsx`,
`src/lib/savePage.ts`, `src/lib/article.ts`, `src/lib/localHost.ts`, `src/lib/agentPort.ts`),
so its browser tests exercise this code.

[PENTEST.md](PENTEST.md) §0 shows the setup; ig-rb-ext's `tests/browser-*.mjs` are worked examples.

## Tests

- `npm test` (or ig-rb-ext's `npm test`): `test/guard.test.mjs`, the parts that need no
  page: the local network (and that the DNR patterns agree with `isLocalUrl`), page URLs,
  the request rules and `fetchForPage`, `siteActivation`; `test/agentPort.test.mjs`, the
  port (own functions only, diffs, the name and sender checks, reconnecting);
  `test/guard-log.test.mjs`, the guard log (events, repeats, a declaration's source).
- `npm run test:browser` (or ig-rb-ext's): `test/dom.browser.mjs`, in Chromium: the page
  host, see-through with real and made-up keys, `replaceable`, `inertCopy`. Needs
  Playwright's Chromium (`npx playwright install chromium`) or `CHROME_EXECUTABLE`.
