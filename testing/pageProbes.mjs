// Probes run as the page's own script (page.evaluate in Playwright): what a hostile
// page can see of, and do to, what an extension or embedded app put into it.

/**
 * What the page can see. Run before and after turning the extension on: the first must
 * be empty. Returns elements on top of everything, their ids (no fixed ones), open
 * shadow roots, fonts added, whether fetch is still native, and what a MutationObserver
 * set up by the page logged (call `watchFromPage` first).
 */
export function pageSees() {
  const topmost = [...document.querySelectorAll('body *')].filter(element => getComputedStyle(element).zIndex === '2147483647');
  return {
    topmost: topmost.map(element => ({ tag: element.tagName, id: element.id, openShadow: !!element.shadowRoot })),
    fonts: [...document.fonts].map(font => font.family),
    fetchNative: /\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
    runtime: typeof globalThis.chrome?.runtime?.sendMessage === 'function',
    seen: window.__probeSeen ?? [],
  };
}

/** Logs, from the page, every element added and every user event, for pageSees().seen. */
export function watchFromPage() {
  window.__probeSeen = [];
  for (const type of ['click', 'mousedown', 'pointerdown', 'keydown', 'mouseover', 'focusin']) {
    addEventListener(type, event => window.__probeSeen.push(`${type}:${event.composedPath()[0]?.id || event.target?.tagName}`), true);
  }
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => window.__probeSeen.push(`added:${node.id || node.nodeName}`))))
    .observe(document.documentElement, { childList: true, subtree: true });
}

/**
 * Clickjacking: lays a transparent layer over the whole page `delayMs` after it is
 * called (late, so it lands above things added after it), catching clicks. Returns
 * nothing; read `window.__caught` for where the user clicked through it.
 */
export function coverPage(delayMs = 300) {
  setTimeout(() => {
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    layer.addEventListener('click', event => { window.__caught = [event.clientX, event.clientY]; });
    document.body.append(layer);
  }, delayMs);
}

/**
 * Click-through: points of the viewport (a `step`px grid) where the element `hostSelector`
 * takes the click though nothing of it is drawn there. Should be 0: the page's own
 * clicks must reach the page around an overlay. "Drawn" is anything with a background,
 * or a control, inside the host's (open: test build) shadow root.
 */
export function clicksTaken(hostSelector, step = 6) {
  const host = document.querySelector(hostSelector);
  if (!host?.shadowRoot) return -1;
  const shown = [...host.shadowRoot.querySelectorAll('*')].filter(element => {
    const style = getComputedStyle(element);
    return style.pointerEvents !== 'none' && (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || /^(BUTTON|INPUT|SELECT|A|svg)$/.test(element.tagName));
  }).map(element => element.getBoundingClientRect()).filter(box => box.width && box.height);
  const inShown = (x, y) => shown.some(box => x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1);
  let count = 0;
  for (let y = 2; y < innerHeight; y += step) for (let x = 2; x < innerWidth; x += step) {
    if (document.elementFromPoint(x, y) === host && !inShown(x, y)) count++;
  }
  return count;
}

/** Made-up input: keys and clicks a page can dispatch. Whatever they reach must ignore them (isTrusted false). */
export function fakeInput(target = document) {
  const press = { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, composed: true, cancelable: true };
  for (const node of [window, document, document.body, target]) node.dispatchEvent(new KeyboardEvent('keydown', press));
  target.dispatchEvent?.(new MouseEvent('click', { bubbles: true, composed: true }));
  target.dispatchEvent?.(new MouseEvent('mouseover', { bubbles: true, composed: true }));
}
