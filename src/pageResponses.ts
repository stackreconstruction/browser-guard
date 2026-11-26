// Page responses - read what a site's own API answers its page, from the isolated world,
// with nothing fixed for the page to find (RULES.md 1.1, 2.5, 2.6, 3.4).
//
// A content script's `fetch` is its own: it never sees the page's requests. Only a script
// in the page's world does, so `tapPageResponses` is injected there by the worker
// (`injectPageResponseTap`), into the asking tab's frame only, while the content script
// wants it. It wraps `fetch` and `XMLHttpRequest` (which the page can see: do it only on
// sites the user turned on, and only while needed) and hands each answer whose text holds
// `needle` to the content script in an event whose name is new for every tap. Everything
// that comes back is page input: the page can read, forge or stop the events.

/** A one-off event name: letters only, so it is no selector or code anywhere. */
export function tapName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, byte => String.fromCharCode(97 + (byte % 26))).join('');
}

export const isTapName = (value: unknown): value is string => typeof value === 'string' && /^[a-z]{20}$/.test(value);

/**
 * Runs in the page's world (injected; it must stay self-contained). Hands the text of each
 * answer that holds `needle`, up to `maxLength`, to `name` events on the document; an event
 * of that name without text (the content script's stop) puts `fetch` and XHR back.
 */
export function tapPageResponses(name: string, needle: string, maxLength: number): void {
  const pageFetch = window.fetch;
  const pageOpen = XMLHttpRequest.prototype.open;
  const hand = (text: unknown) => {
    if (typeof text === 'string' && text.length <= maxLength && text.includes(needle)) {
      document.dispatchEvent(new CustomEvent(name, { detail: text }));
    }
  };
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const answer = pageFetch.apply(this, args);
    answer.then(response => {
      // Only JSON: media and streams are never read twice or waited on to their end.
      if ((response.headers.get('content-type') ?? '').includes('json')) response.clone().text().then(hand, () => {});
    }, () => {});
    return answer;
  } as typeof fetch;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') hand(this.responseText);
      } catch { /* not text */ }
    });
    return (pageOpen as (...rest: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  const stop = (event: Event) => {
    if (typeof (event as CustomEvent).detail === 'string') return;
    document.removeEventListener(name, stop);
    if (window.fetch !== pageFetch) window.fetch = pageFetch;
    XMLHttpRequest.prototype.open = pageOpen;
  };
  document.addEventListener(name, stop);
}

/**
 * The content script's side: listens under a new name, asks the worker (`channel`) to tap
 * this frame, and hands `onText` each answer. Returns the stop, which also unwraps the page.
 */
export function listenForPageResponses(channel: string, onText: (text: string) => void): () => void {
  const name = tapName();
  const listener = (event: Event) => {
    const text = (event as CustomEvent).detail;
    if (typeof text === 'string') onText(text);
  };
  document.addEventListener(name, listener);
  chrome.runtime.sendMessage({ channel, name }).catch(() => {});
  return () => {
    document.removeEventListener(name, listener);
    document.dispatchEvent(new CustomEvent(name));
  };
}

/**
 * The worker's side: taps the frame that asked, and no other, when `allowed` (the site is
 * turned on). A content script's request is the page's (RULES.md 2.7): it gets only its own
 * frame tapped, under the name it chose, which must be a tap name.
 */
export async function injectPageResponseTap(sender: chrome.runtime.MessageSender, name: unknown, needle: string,
  maxLength: number, allowed: (url: string) => Promise<boolean>): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url || !isTapName(name) || !await allowed(sender.url)) return false;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [sender.frameId ?? 0] }, world: 'MAIN',
    func: tapPageResponses, args: [name, needle, maxLength] });
  return true;
}
