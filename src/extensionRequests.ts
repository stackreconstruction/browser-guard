// What an extension's own requests tell sites. An extension's pages and worker are a
// privileged origin: Chrome treats its requests to sites it has host access to as
// first-party (their cookies go along, even SameSite=Lax ones, and answers can set new
// ones), the local network is open to them, and crossorigin="anonymous" makes things
// worse (cookies still sent, plus `Origin: chrome-extension://<id>`, which names the
// extension to the site). Measured in a browser; see RULES.md.

import { extensionHost, onSafari } from './browsers';
import { LOCAL_URL_PATTERNS } from './localNetwork';

/** For <img>/<video> in an extension page: no Referer. (Cookies: anonymousMediaRule.) Not crossOrigin. */
export const ANONYMOUS_MEDIA = { referrerPolicy: 'no-referrer' } as const;

const DNR = () => chrome.declarativeNetRequest;

/**
 * A session rule taking Cookie off the extension's own image and media requests, and
 * Set-Cookie off their answers. Session rules end with the browser: install it at every
 * worker start. Needs "declarativeNetRequestWithHostAccess" (or declarativeNetRequest).
 * Safari can't change response headers: there it takes Cookie off only, and keeping
 * answers from setting cookies is left to Safari's own cross-site cookie blocking
 * (RULES.md 6.2: measure it).
 */
export function anonymousMediaRule(id: number): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: DNR().RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{ header: 'cookie', operation: DNR().HeaderOperation.REMOVE }],
      ...onSafari() ? {} : { responseHeaders: [{ header: 'set-cookie', operation: DNR().HeaderOperation.REMOVE }] },
    },
    condition: {
      initiatorDomains: [extensionHost()],
      resourceTypes: [DNR().ResourceType.IMAGE, DNR().ResourceType.MEDIA],
    },
  };
}

/**
 * Session rules blocking the extension's own image and media requests to the local
 * network, redirects included (a public URL answering with a redirect to a router is
 * caught too, which a check of the first URL alone misses). Ids `firstId`, `firstId + 1`, …
 * Add them while the extension shows a public page's media, remove them for a local one.
 */
export function localMediaBlockRules(firstId: number): chrome.declarativeNetRequest.Rule[] {
  return LOCAL_URL_PATTERNS.map((regexFilter, index) => ({
    id: firstId + index,
    priority: 2,
    action: { type: DNR().RuleActionType.BLOCK },
    condition: { initiatorDomains: [extensionHost()], regexFilter, resourceTypes: [DNR().ResourceType.IMAGE, DNR().ResourceType.MEDIA] },
  }));
}

/**
 * Installs (or replaces) session rules: the call to make at every worker start. Rejects if
 * the browser refuses them: report it, since the protection they give is then missing.
 */
export async function installSessionRules(rules: chrome.declarativeNetRequest.Rule[]): Promise<void> {
  await DNR().updateSessionRules({ removeRuleIds: rules.map(rule => rule.id), addRules: rules });
}

/**
 * A fetch from the worker on a page's behalf: no cookies, no Referer, no redirects (a public URL
 * must not bounce a privileged request onto the local network; the page can follow
 * ordinary redirects itself). Check the URL with `reachableFrom` first.
 */
export function fetchForPage(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
}
