// browser-guard's parts that need a page, in Chromium (no extension loaded): the page
// host, seeing through it with Ctrl, replacing a copy, inert copies, and a host put back. Real input comes
// from Playwright (trusted); made-up input from the page's own script (not trusted).
// Run: npm run test:browser
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'guard' });
const PAGE = `<body style="margin:0"><div id="under" style="position:fixed;left:0;top:0;width:200px;height:200px"></div>
  <div id="copied"><img src="/page.jpg" width="40" height="40"></div></body>`;
const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>';

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const requested = [];
  await page.route('http://guard.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    return route.fulfill(path === '/' ? { contentType: 'text/html', body: PAGE } : { contentType: 'image/svg+xml', body: PICTURE });
  });
  await page.goto('http://guard.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  // The host: zero-size, fixed, takes no click, closed, and named afresh each time.
  const host = await page.evaluate(() => {
    const [first, second] = [guard.createPageHost(document, 'p { color: red }'), guard.createPageHost(document, '')];
    const style = getComputedStyle(first.container);
    const testBuild = guard.createPageHost(document, '', { id: 'test-host', open: true });
    return {
      ids: [first.container.id, second.container.id], closed: first.container.shadowRoot === null, styled: first.shadow.querySelector('style')?.textContent,
      box: [style.position, style.width, style.height, style.pointerEvents], testBuild: [testBuild.container.id, testBuild.container.shadowRoot !== null],
    };
  });
  assert.notEqual(host.ids[0], host.ids[1], 'a new id each time');
  assert.ok(host.ids.every(id => /^h[a-z0-9]+$/.test(id)), `ids name nothing: ${host.ids}`);
  assert.ok(host.closed, 'the page gets no reference inside');
  assert.equal(host.styled, 'p { color: red }');
  assert.deepEqual(host.box, ['fixed', '0px', '0px', 'none']);
  assert.deepEqual(host.testBuild, ['test-host', true], 'a test build may name it and leave it open');

  // A button the extension draws over part of the page, and who gets a click there.
  await page.evaluate(() => {
    const { container, shadow } = guard.createPageHost(document, 'button { position: fixed; left: 0; top: 0; width: 200px; height: 200px; pointer-events: auto; }');
    const button = document.createElement('button');
    shadow.append(button);
    window.clicks = { extension: 0, page: 0, fromHost: [] };
    button.addEventListener('click', () => window.clicks.extension++);
    document.getElementById('under').addEventListener('click', () => window.clicks.page++);
    document.addEventListener('click', event => window.clicks.fromHost.push(guard.fromHost(container, event)));
    guard.seeThroughWhileHeld(shadow, new AbortController().signal);
  });
  const clicks = () => page.evaluate(() => ({ ...window.clicks }));
  const click = () => page.mouse.click(100, 100);

  await click();
  assert.deepEqual(await clicks(), { extension: 1, page: 0, fromHost: [true] }, 'the extension\'s own click, seen outside as the host\'s');
  // The page makes up a held Ctrl: nothing changes.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true })));
  await page.waitForTimeout(400);
  await click();
  assert.equal((await clicks()).extension, 2, 'a made-up Ctrl sees through nothing');
  // A quick Ctrl shortcut: nothing changes either.
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
  await click();
  assert.equal((await clicks()).extension, 3, 'a Ctrl shortcut sees through nothing');
  // The user holds Ctrl: the click goes to the page under the button.
  await page.keyboard.down('Control');
  await page.waitForTimeout(400);
  await click();
  assert.deepEqual(await clicks(), { extension: 3, page: 1, fromHost: [true, true, true, false] }, 'held Ctrl: the page gets the click');
  // Let go over the button: one plain click still goes through, then the button is the extension's again.
  await page.keyboard.up('Control');
  await click();
  await click();
  const after = await clicks();
  assert.deepEqual([after.extension, after.page], [4, 2], 'one click after letting go is the page\'s, the next the extension\'s');

  // Replacing a copy: through the global; the page's own event removes only a copy cut off from its extension.
  const replaced = await page.evaluate(() => {
    (window.chrome ??= {}).runtime = { id: 'extension' }; // as in a content script (Chromium has window.chrome, without runtime, in a page)
    const removed = [];
    guard.replaceable('test', () => removed.push('first'));
    document.dispatchEvent(new Event('test:replace')); // fired by the page
    const afterPageEvent = [...removed];
    guard.replaceable('test', () => removed.push('second'));
    const afterSecond = [...removed];
    delete window.chrome.runtime.id; // the extension reloaded: this copy is cut off
    document.dispatchEvent(new Event('test:replace'));
    return { afterPageEvent, afterSecond, end: removed };
  });
  assert.deepEqual(replaced, { afterPageEvent: [], afterSecond: ['first'], end: ['first', 'second'] }, 'each copy removed once, never by the page while running');

  // Inert copies load nothing, even with a new src set (as reading an article's lazy images
  // does). A picture in the live document, made after, does load: once its request is
  // answered, the inert copy's would have been too.
  requested.length = 0;
  const live = page.waitForResponse(/\/live\.jpg$/); // answered: the route below has written it down
  const inert = await page.evaluate(() => {
    const copy = guard.inertCopy(document.getElementById('copied'));
    copy.querySelector('img').src = '/inert.jpg';
    copy.append(Object.assign(copy.ownerDocument.createElement('img'), { src: '/inert-new.jpg' }));
    window.live = new Image(); // kept, so it isn't collected before it loads
    window.live.src = '/live.jpg';
    return copy.ownerDocument.defaultView === null;
  });
  await live;
  assert.ok(inert, 'the copy\'s document has no window');
  assert.deepEqual(requested, ['/live.jpg'], 'the inert copy requested nothing (the live picture did)');

  // The page empties its body (a reader view made of it): the host is put back as it was, its
  // button taking clicks (the see-through style, put back with it, stays off); not once stopped.
  await page.evaluate(() => {
    const { container, shadow } = guard.createPageHost(document, 'button { position: fixed; left: 300px; top: 300px; width: 100px; height: 100px; pointer-events: auto; }', { id: 'kept', open: true });
    const button = document.createElement('button');
    shadow.append(button);
    window.kept = 0;
    button.addEventListener('click', () => window.kept++);
    window.stopKeeping = new AbortController();
    guard.seeThroughWhileHeld(shadow, window.stopKeeping.signal);
    guard.keepInPage(container, window.stopKeeping.signal);
    document.body.textContent = '';
  });
  await page.locator('#kept').waitFor({ state: 'attached' });
  await page.mouse.click(350, 350);
  assert.equal(await page.evaluate(() => window.kept), 1, 'put back, the host\'s button takes the click');
  await page.evaluate(() => { document.body = document.createElement('body'); });
  await page.locator('#kept').waitFor({ state: 'attached' });
  await page.evaluate(() => { window.stopKeeping.abort(); document.body.textContent = ''; });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#kept').count(), 0, 'stopped, the host stays out');

  console.log('PASS: browser-guard in a page: closed, click-through host named afresh; Ctrl held sees through, made-up keys don\'t; copies replaced once; inert copies load nothing; a host the page took out is put back.');
} finally {
  await browser.close();
}
