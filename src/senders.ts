// Who is asking. Messages and events can come from places other than the user.

/** A runtime message from this extension (a content script or one of its pages): check it in every listener. */
export const fromOwnExtension = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id;

/**
 * A message from one of the extension's own pages (`path`, e.g. 'panel.html'), not a
 * content script: for what only that page may ask (turning a site on, settings).
 * A content script runs in a page a site controls; treat its requests as the page's.
 */
export const fromExtensionPage = (sender: chrome.runtime.MessageSender, path: string) =>
  fromOwnExtension(sender) && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(path);

/** An event the user made: a page can dispatch made-up keys, clicks and hovers (isTrusted false). */
export const byUser = (event: Event) => event.isTrusted;

/** An http(s) address, and nothing else (no javascript:, data:, file:, chrome:). For anything a page supplied. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
