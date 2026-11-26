// What an extension puts into a page: one host element, closed to the page.
// - A closed shadow root: the page's scripts get no reference inside, so they can
//   neither read what it shows nor press its buttons.
// - A zero-size, fixed host with pointer-events: none; only what is drawn takes clicks
//   (set pointer-events: auto on it), so the page around it keeps every click.
// - A new id on each page: no fixed id marks the extension to the page.
// - Replacing a copy (the script injected again): through the isolated world's global,
//   which the page can't reach. An event on the document is heeded only by a copy an
//   extension reload cut off (chrome.runtime.id gone): the page could fire it too.
// - Put back when the page takes it out (keepInPage): a reader view that empties <body>.
// - Hold Ctrl to see through it and click the page under it (seeThroughWhileHeld).
// Still: anything in a page can be covered by the page's own elements (clickjacking).
// Put what matters (settings, destructive actions) in an extension page instead.

import { reportGuard, reportRepeated } from './guardLog';

export interface PageHost {
  container: HTMLElement;
  shadow: ShadowRoot;
}

/** A closed host in `doc`, styled with `css`. `id` only for test builds (selectors); else a new one per page. */
export function createPageHost(doc: Document, css: string, { id, open = false }: { id?: string; open?: boolean } = {}): PageHost {
  const container = doc.createElement('div');
  container.id = id ?? `h${Math.random().toString(36).slice(2, 10)}`;
  Object.assign(container.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none' });
  doc.body.appendChild(container);
  const shadow = container.attachShadow({ mode: open ? 'open' : 'closed' });
  const style = doc.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  return { container, shadow };
}

// A page that takes the host out each time it is put back gets it back this often at most.
const PUT_BACK_MS = 200;

/**
 * Puts the host back into the page when the page takes it out, until `signal` aborts: a script
 * that empties or replaces <body> (a reader view made of the page: Obsidian Web Clipper's) takes
 * the host with the rest, and what is drawn in it stays mounted where nobody sees it. Its shadow
 * root and all in it come back as they were. Watches the children of <html> and <body> only.
 */
export function keepInPage(container: HTMLElement, signal: AbortSignal): void {
  let body: HTMLElement | null = null;
  let waiting = 0;
  const watch = () => {
    body = document.body;
    observer.disconnect();
    observer.observe(document.documentElement, { childList: true });
    if (body) observer.observe(body, { childList: true });
  };
  const putBack = () => {
    waiting = 0;
    if (signal.aborted || container.isConnected || !document.body) return;
    document.body.appendChild(container);
    watch();
    reportRepeated('host:put-back', { kind: 'info', code: { file: 'packages/browser-guard/src/pageHost.ts', name: 'keepInPage' },
      message: 'The page took the extension\'s element out (it emptied or replaced its body): put back as it was' }, 60000);
  };
  const observer = new MutationObserver(() => {
    if (body !== document.body) watch();
    if (!container.isConnected && !waiting) waiting = window.setTimeout(putBack, PUT_BACK_MS);
  });
  watch();
  signal.addEventListener('abort', () => {
    observer.disconnect();
    clearTimeout(waiting);
  });
}

/**
 * Registers `remove` as this copy's way out, after removing the copy running before it.
 * `name` is the extension's own (one per kind of content script). `remove` runs once,
 * however the copy is replaced, and takes its listener with it.
 */
export function replaceable(name: string, remove: () => void): () => void {
  const key = Symbol.for(`${name}:unmount`);
  const global = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  global[key]?.();
  const event = `${name}:replace`;
  document.dispatchEvent(new Event(event));
  const listening = new AbortController();
  const removeOnce = () => {
    if (listening.signal.aborted) return;
    listening.abort();
    remove();
  };
  global[key] = removeOnce;
  document.addEventListener(event, () => {
    if (!chrome.runtime?.id) return removeOnce();
    // Running, a copy is replaced through its own world: this event came from the page.
    reportRepeated('replace:made-up', { kind: 'ignored', code: { file: 'packages/browser-guard/src/pageHost.ts', name: 'replaceable' },
      message: 'The page fired the event that removes an old copy of the extension: ignored, this copy is running' });
  }, { signal: listening.signal });
  return removeOnce;
}

/** Marks an element that stays shown and clickable while the rest is seen through (small controls over the page's own content). */
export const STAYS_SOLID = 'data-stays-solid';
// Seeing through: everything in the host but what stays solid lets clicks through to the
// page and all but disappears. Opacity can't be undone below a faded element, so it fades
// the largest parts holding nothing solid. A style inside the closed root, so the page can't tell.
const SOLID = `[${STAYS_SOLID}]`;
const SEE_THROUGH = `:not(${SOLID}, ${SOLID} *) { pointer-events: none !important; }
:host > :not(:has(${SOLID})), :has(${SOLID}) > :not(${SOLID}, :has(${SOLID})) { opacity: 0.15; }`;
// Ctrl held this long, alone, sees through; a shortcut (Ctrl+C) is quicker.
const SEE_THROUGH_HOLD_MS = 250;

/**
 * Hold Ctrl, alone, to see through what the extension shows and click the page under
 * it; elements marked `STAYS_SOLID` stay as they are. A link clicked through it opens as
 * with a plain click, not in a new tab as a Ctrl+click would (elsewhere on the page it
 * does). Let go to click without Ctrl: it stays see-through while the pointer is over it,
 * until a click goes through or the pointer leaves it. Only the user's own keys count:
 * a page can make up key events (reported to the guard log, as is each step here).
 */
export function seeThroughWhileHeld(shadow: ShadowRoot, signal: AbortSignal): void {
  const style = document.createElement('style');
  style.textContent = SEE_THROUGH;
  shadow.appendChild(style);
  // By its media, not `disabled`: a style element taken out of the page and put back (keepInPage) is enabled again.
  const see = (on: boolean) => { style.media = on ? 'all' : 'not all'; };
  see(false);
  let holding: number | undefined;
  let seeing = false;
  let letGo = false;
  const pointer = { x: -1, y: -1 };
  const end = () => {
    clearTimeout(holding);
    seeing = letGo = false;
    see(false);
  };
  /** Whether the pointer is over something the extension shows (looked for with see-through off for the moment, which paints nothing). */
  const overShown = (x = pointer.x, y = pointer.y) => {
    see(false);
    const hit = shadow.elementFromPoint(x, y);
    see(true);
    return hit?.getRootNode() === shadow;
  };
  const listen = <K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void) =>
    window.addEventListener(type, event => { if (event.isTrusted) listener(event); }, { capture: true, passive: true, signal });
  const code = { file: 'packages/browser-guard/src/pageHost.ts', name: 'seeThroughWhileHeld' };
  window.addEventListener('keydown', event => {
    if (!event.isTrusted && event.key === 'Control') reportRepeated('see-through:made-up', { kind: 'ignored', code,
      message: 'The page made up a Ctrl key press: ignored, the extension stays as it is' });
  }, { capture: true, passive: true, signal });

  listen('keydown', event => {
    if (event.key !== 'Control' || event.shiftKey || event.altKey || event.metaKey) return end();
    if (seeing) letGo = false;
    else if (!event.repeat) {
      clearTimeout(holding);
      holding = window.setTimeout(() => {
        seeing = true;
        see(true);
        reportRepeated('see-through:on', { kind: 'info', code, message: 'Ctrl held: the extension is see-through, clicks go to the page under it' }, 60000);
      }, SEE_THROUGH_HOLD_MS);
    }
  });
  listen('keyup', event => {
    if (event.key !== 'Control') return;
    clearTimeout(holding);
    if (seeing && overShown()) letGo = true;
    else end();
  });
  listen('pointermove', event => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (letGo && !overShown()) end();
  });
  // The click has gone to the page by now; the next one is the extension's again.
  listen('click', () => { if (letGo) end(); });
  // A Ctrl+click through what is shown follows its link as a plain click would: the
  // browser's own new tab is stopped (not passive, to be able to), and the link gets a
  // plain click instead, so the page's handlers run once (a router, a lightbox) and the
  // browser applies the link's target, rel and referrerpolicy itself.
  window.addEventListener('click', event => {
    if (!event.isTrusted) return;
    // The Mac's Control+click, already given as a plain click (below), if the browser sends it on.
    if (event.timeStamp - menuClickAt < MENU_CLICK_MS) return void (event.preventDefault(), event.stopPropagation());
    if (!seeing || !event.ctrlKey || !overShown(event.clientX, event.clientY)) return;
    const link = linkOf(event);
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    link.click();
    reportGuard({ kind: 'info', code, message: 'A link Ctrl+clicked through the extension opened as a plain click, not in a new tab',
      details: { link: link.href, target: link.target || '_self', 'the browser\'s new tab': 'stopped (preventDefault)', 'instead': 'a plain click on the link: the page\'s handlers and the link\'s target, rel and referrerpolicy apply' } });
  }, { capture: true, signal });
  // On a Mac, Control+click is the right click: the browser opens its menu and the page
  // gets no click. Over what is shown, while seen through, it is the user's click on what
  // is under it (the page, or a control that stays solid): the menu is stopped, and that
  // gets a plain click.
  let menuClickAt = -Infinity;
  window.addEventListener('contextmenu', event => {
    if (!onMac() || !event.isTrusted || !seeing || !event.ctrlKey || !overShown(event.clientX, event.clientY)) return;
    const { clientX, clientY } = event;
    const under = elementAt(document, clientX, clientY);
    const target = under === shadow.host ? shadow.elementFromPoint(clientX, clientY) : under; // a control that stays solid
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    menuClickAt = event.timeStamp;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY }));
    reportGuard({ kind: 'info', code, message: 'Control+click (a right click on a Mac) through the extension: given as a plain click, not the menu',
      details: { 'clicked': target === under ? 'the page under the extension' : 'a control of the extension\'s that stays solid', 'the browser\'s menu': 'stopped (preventDefault)' } });
  }, { capture: true, signal });
  listen('wheel', event => { if (event.ctrlKey) end(); }); // zooming
  listen('blur', event => { if (event.target === window) end(); }); // focus left the tab (not an element of it)
}

// How long a click after the Mac's Control+click counts as the same one.
const MENU_CLICK_MS = 1000;
const onMac = () => /^Mac/.test(navigator.platform);

/** The page's element at a point, inside the open shadow roots it holds. */
function elementAt(root: Document | ShadowRoot, x: number, y: number): Element | null {
  const element = root.elementFromPoint(x, y);
  const inner = element?.shadowRoot && element.shadowRoot !== root ? elementAt(element.shadowRoot, x, y) : null;
  return inner && inner !== element ? inner : element;
}

/** The web link a click follows, unless it downloads: what a plain click can be made to do the same with. */
function linkOf(event: MouseEvent): HTMLAnchorElement | HTMLAreaElement | undefined {
  const link = event.composedPath().find((node): node is HTMLAnchorElement | HTMLAreaElement =>
    node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
  return link && /^https?:/.test(link.href) && !link.hasAttribute('download') ? link : undefined;
}

/** Whether an event started inside the host: listeners outside see it as coming from the host itself. */
export const fromHost = (host: Element | null, event: Event) => !!host && event.target === host;
