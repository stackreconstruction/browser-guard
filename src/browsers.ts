// Where the extension runs: what differs between Chromium, Safari and browsers with part
// of the extension APIs (Orion on a phone) that the rest of this package, and an
// extension using it, has to know (RULES.md §6).

/**
 * The host of the extension's own origin, as network rules see its requests
 * (`initiatorDomains`). Chrome's is the extension's id; Safari's (and Firefox's) is a
 * UUID that isn't `runtime.id`, and Safari's is new at every launch, so it is
 * worked out at each start and never stored.
 */
export const extensionHost = () => new URL(chrome.runtime.getURL('/')).host;

/** Whether the extension runs in Safari (its pages are safari-web-extension:// ones). */
export const onSafari = () => chrome.runtime.getURL('/').startsWith('safari-web-extension:');

/**
 * Asks for access to a site's pages: Safari grants host access site by site, at the
 * user's word, whatever the manifest asks for. Call it in the user's click (a toolbar
 * button, a button in an extension page) before anything is awaited: browsers honour a
 * request only then. Elsewhere access granted at install (host_permissions) is checked
 * first, and asked for only if the user withheld it: Chrome refuses a request without a
 * user gesture even for access it has, and a worker's toolbar click may not count as one.
 * Resolves to whether the extension has it.
 */
export function requestSiteAccess(host: string): Promise<boolean> {
  const origins = [`*://${host}/*`];
  if (onSafari()) return chrome.permissions.request({ origins });
  return chrome.permissions.contains({ origins }).then(granted => granted || chrome.permissions.request({ origins }));
}

/**
 * Whether the toolbar button opens a page of the extension as a popup (`action.default_popup`):
 * a build for a browser where an extension can't open a window of its own, or isn't told of
 * a click on its button (Orion on a phone).
 */
export const actionOpensPopup = () => !!chrome.runtime.getManifest?.().action?.default_popup;

/** The extension APIs a browser may lack, each with what is then missing. A browser with part of them says nothing: only a call tells. */
const OPTIONAL_APIS: Record<string, string> = {
  'scripting.executeScript': 'no site can be turned on',
  'tabs.onUpdated': 'a page loaded later needs "reconnect"',
  'tabs.connect': 'the page\'s media can\'t be listed here',
  'declarativeNetRequest.updateSessionRules': 'pictures shown here may send their site its cookies',
  'storage.session': 'kept in storage.local',
  'downloads.download': 'files open in a tab, to save from there',
  'windows.create': 'no window of the extension\'s own',
};

/** The APIs of OPTIONAL_APIS this browser lacks, as `name (what is missing with it)`. */
export function missingApis(): string[] {
  const has = (path: string) => typeof path.split('.').reduce<unknown>((at, name) => (at as Record<string, unknown> | undefined)?.[name], chrome) !== 'undefined';
  return Object.entries(OPTIONAL_APIS).filter(([path]) => !has(path)).map(([path, lost]) => `${path} (${lost})`);
}
