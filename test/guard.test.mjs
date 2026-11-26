// browser-guard's parts that need no page: the local network, page-supplied URLs, the
// extension's request rules, and opt-in per site, against stand-ins of the chrome APIs.
// (The page host, see-through and inert copies run in a browser: dom.browser.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const load = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const { isLocalHost, isLocalUrl, reachableFrom, LOCAL_URL_PATTERNS, webUrl, siteActivation, anonymousMediaRule, localMediaBlockRules, installSessionRules, fetchForPage,
  extensionHost, onSafari, requestSiteAccess } = await load(new URL('../src/index.ts', import.meta.url).pathname);

// The Local Network Access spec's non-public blocks, at their edges, and names that aren't addresses.
const LOCAL_HOSTS = ['localhost', 'router', 'nas.local', 'app.localhost', '0.0.0.0', '10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.9', '172.31.255.255',
  '169.254.1.1', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '[::]', '[::1]', '[fd00::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]',
  '[::ffff:c0a8:101]', '[2001:db8::1]', '[3fff::1]', '[3fff:fff::1]',
  // A final dot names the same host, and the browser resolves it alike.
  'localhost.', 'router.', 'nas.local.', 'app.localhost.'];
const PUBLIC_HOSTS = ['example.com', 'localhost.example.com', '8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.17.0.1', '198.20.0.1',
  '[2606:4700::1111]', '[2001:db9::1]', '[3fff:1000::1]', '[::ffff:808:808]',
  // Names that begin like an IPv6 range: a page on one is a public page.
  'fd00.com', 'fe80.net', 'ff00.io', 'fc00.example'];

test('the local network, and what an extension may reach for a page', () => {
  for (const host of LOCAL_HOSTS) assert.ok(isLocalHost(host), host);
  for (const host of PUBLIC_HOSTS) assert.ok(!isLocalHost(host), host);
  assert.ok(reachableFrom('https://cdn.example/a.jpg', 'https://site.example/'));
  assert.ok(!reachableFrom('http://192.168.1.1/admin', 'https://site.example/'), 'a public page names a router');
  assert.ok(reachableFrom('http://192.168.1.1/x.jpg', 'http://192.168.1.5/'), 'a local page, its own network');
  assert.ok(!reachableFrom('javascript:alert(1)', 'https://site.example/'));
  assert.ok(!reachableFrom('http://192.168.1.1/admin', 'https://fd00.com/'), 'a public page whose name looks like an IPv6 range');
});

test('the request rules block what isLocalUrl calls local, and nothing it calls public', () => {
  const patterns = LOCAL_URL_PATTERNS.map(pattern => new RegExp(pattern));
  // As the browser hands them to its rules: canonical URLs, with a port and a user at times.
  const urls = host => [`http://${host}/a.jpg`, `https://user@${host}:8443/a.jpg`].map(url => new URL(url).href);
  for (const url of LOCAL_HOSTS.flatMap(urls)) assert.ok(isLocalUrl(url) && patterns.some(pattern => pattern.test(url)), url);
  // A public IPv4-mapped address is the one public URL the rules block too: the regex doesn't decode it.
  for (const url of PUBLIC_HOSTS.filter(host => !host.startsWith('[::ffff:')).flatMap(urls)) {
    assert.ok(!isLocalUrl(url) && patterns.every(pattern => !pattern.test(url)), url);
  }
  // Credentials may hold ' ( ) *, which URLs keep as they are.
  for (const url of ["http://a(b)*'c@192.168.1.1/x.jpg", "http://a(b@localhost./x.jpg"]) assert.ok(patterns.some(pattern => pattern.test(new URL(url).href)), url);
  // An "@" in the path isn't credentials: these are public pictures.
  for (const url of ['https://site.example/@someone/a.jpg', 'https://cdn.example/a@b/c.jpg', 'https://example.com/@10.0.0.1/a.jpg', 'https://example.com/logo@2x.png']) {
    assert.ok(!isLocalUrl(url) && patterns.every(pattern => !pattern.test(url)), url);
  }
});

test('the request rules are in the regex syntax every browser takes (Safari\'s is the smallest)', () => {
  // WebKit's content-blocker subset: no alternation, counted repeats, non-capturing groups, escapes for classes, or negated classes.
  for (const pattern of LOCAL_URL_PATTERNS) assert.doesNotMatch(pattern, /\||\{|\(\?|\\[dDwWsSbB]|\[\^/, pattern);
});

test('the extension\'s own requests: no cookies on its media, no local media for a public page, page fetches without cookies or redirects', async () => {
  const updates = [];
  globalThis.chrome = {
    runtime: { id: 'extension', getURL: path => new URL(path, 'chrome-extension://extension/').href },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: 'modifyHeaders', BLOCK: 'block' }, HeaderOperation: { REMOVE: 'remove' }, ResourceType: { IMAGE: 'image', MEDIA: 'media' },
      updateSessionRules: async update => { updates.push(update); },
    },
  };
  const media = anonymousMediaRule(7);
  assert.deepEqual(media.condition, { initiatorDomains: ['extension'], resourceTypes: ['image', 'media'] }, 'only the extension\'s own pictures and media');
  assert.deepEqual(media.action.requestHeaders, [{ header: 'cookie', operation: 'remove' }]);
  assert.deepEqual(media.action.responseHeaders, [{ header: 'set-cookie', operation: 'remove' }]);
  const block = localMediaBlockRules(10);
  assert.deepEqual(block.map(rule => rule.id), LOCAL_URL_PATTERNS.map((_, at) => 10 + at));
  assert.deepEqual(block.map(rule => rule.condition.regexFilter), [...LOCAL_URL_PATTERNS]);
  assert.ok(block.every(rule => rule.action.type === 'block' && rule.condition.initiatorDomains[0] === 'extension' && rule.priority > media.priority));
  // Installing replaces rules left under the same ids (session rules outlive a worker, not the browser).
  await installSessionRules([media, ...block]);
  assert.deepEqual(updates, [{ removeRuleIds: [7, ...block.map(rule => rule.id)], addRules: [media, ...block] }]);
  // A browser refusing them: the caller hears of it, since the protection is then missing.
  chrome.declarativeNetRequest.updateSessionRules = async () => { throw new Error('Rule with id 7 is invalid'); };
  await assert.rejects(installSessionRules([media]), /invalid/);

  const asked = [];
  globalThis.fetch = async (url, init) => { asked.push({ url, ...init }); return new Response(''); };
  await fetchForPage('https://cdn.example/a.jpg', { credentials: 'include', redirect: 'follow', headers: { accept: 'image/*' } });
  assert.deepEqual(asked, [{ url: 'https://cdn.example/a.jpg', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { accept: 'image/*' } }],
    'the caller can\'t turn cookies, redirects or the Referer back on');
});

test('page-supplied URLs: web addresses only', () => {
  assert.equal(webUrl('https://site.example/a?b=1'), 'https://site.example/a?b=1');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings', 'not a url', 42, null]) assert.equal(webUrl(value), null, String(value));
});

/** chrome.scripting and chrome.storage.local, in memory; unregistering an unknown id fails the whole call, as Chrome's does. */
function fakeChrome(stored) {
  const scripts = new Map();
  const storage = { ...stored };
  globalThis.chrome = {
    storage: { local: { get: async key => (key in storage ? { [key]: storage[key] } : {}), set: async entries => Object.assign(storage, entries) } },
    scripting: {
      getRegisteredContentScripts: async () => [...scripts.values()],
      registerContentScripts: async list => list.forEach(script => { if (scripts.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`); scripts.set(script.id, script); }),
      unregisterContentScripts: async ({ ids }) => {
        if (ids.some(id => !scripts.has(id))) throw new Error('Nonexistent script ID');
        ids.forEach(id => scripts.delete(id));
      },
    },
  };
  return { scripts, storage };
}

test('opt-in per site: on and off, kept, and the scripts made to match the list at start', async () => {
  const { scripts, storage } = fakeChrome();
  const turnedOn = [];
  const sites = siteActivation({
    scriptsFor: host => [{ matches: [`*://${host}/*`], js: ['content.js'] }, ...host === 'x.com' ? [{ matches: [`*://${host}/*`], js: ['page.js'], world: 'MAIN' }] : []],
    onOn: host => { turnedOn.push(host); },
  });
  await sites.synced;
  await Promise.all([sites.activate('example.com'), sites.activate('x.com')]);
  assert.deepEqual([...scripts.keys()].sort(), ['site:example.com', 'site:x.com', 'site:x.com#1']);
  assert.ok([...scripts.values()].every(script => script.persistAcrossSessions));
  assert.deepEqual(storage.activeSites, ['example.com', 'x.com']);
  assert.deepEqual(turnedOn, ['example.com', 'x.com']);
  // Off: all of a site's scripts go, whatever their number.
  await sites.toggle('x.com');
  assert.deepEqual([...scripts.keys()], ['site:example.com']);
  assert.equal(await sites.isOn('x.com'), false);

  // A restart where the scripts were dropped (an extension reload) and a stray one is left: the list wins.
  scripts.clear();
  scripts.set('site:old.example', { id: 'site:old.example' });
  const again = siteActivation({ scriptsFor: host => [{ matches: [`*://${host}/*`], js: ['content.js'] }] });
  await again.synced;
  assert.deepEqual([...scripts.keys()], ['site:example.com']);
});

test('an IPv6 site turns off: its scripts go, and it can be turned on again', async () => {
  const { scripts } = fakeChrome();
  const sites = siteActivation({ scriptsFor: host => [{ matches: [`*://${host}/*`], js: ['content.js'] }, { matches: [`*://${host}/*`], js: ['page.js'] }] });
  await sites.synced;
  await sites.activate('[::1]');
  assert.deepEqual([...scripts.keys()], ['site:[::1]', 'site:[::1]#1']);
  await sites.deactivate('[::1]');
  assert.deepEqual([...scripts.keys()], [], 'no script left for its next page');
  await sites.activate('[::1]');
  assert.equal(scripts.size, 2);
});

test('the first start keeps the sites that were on (registered) as the list', async () => {
  const { storage } = fakeChrome();
  await chrome.scripting.registerContentScripts([{ id: 'site:kept.example' }, { id: 'site:kept.example#1' }]);
  const sites = siteActivation({ scriptsFor: () => [{ js: ['content.js'] }, { js: ['page.js'] }] });
  await sites.synced;
  assert.deepEqual(storage.activeSites, ['kept.example']);
});

test('scripts registered under another id scheme (site:<host>:x) are replaced at start, not left beside the new ones', async () => {
  const { scripts, storage } = fakeChrome({ activeSites: ['x.com'] });
  await chrome.scripting.registerContentScripts([{ id: 'site:x.com' }, { id: 'site:x.com:x' }]);
  const sites = siteActivation({ scriptsFor: () => [{ js: ['content.js'] }, { js: ['page.js'] }] });
  await sites.synced;
  assert.deepEqual([...scripts.keys()].sort(), ['site:x.com', 'site:x.com#1']);
  assert.deepEqual(storage.activeSites, ['x.com']);
  await sites.deactivate('x.com');
  assert.deepEqual([...scripts.keys()], []);

  // Before the list was kept: the old scheme still counts as on.
  const fresh = fakeChrome();
  await chrome.scripting.registerContentScripts([{ id: 'site:x.com' }, { id: 'site:x.com:x' }]);
  await siteActivation({ scriptsFor: () => [{ js: ['content.js'] }] }).synced;
  assert.deepEqual(fresh.storage.activeSites, ['x.com']);
});

test('a site whose scripts can\'t be registered at start: the others are, synced names it, later changes go on', async () => {
  const { scripts } = fakeChrome({ activeSites: ['broken.example', 'fine.example'] });
  const register = chrome.scripting.registerContentScripts;
  chrome.scripting.registerContentScripts = async list => {
    if (list.some(script => script.id.includes('broken'))) throw new Error('Invalid match pattern');
    return register(list);
  };
  const sites = siteActivation({ scriptsFor: host => [{ matches: [`*://${host}/*`], js: ['content.js'] }] });
  await assert.rejects(sites.synced, /broken\.example: Invalid match pattern/);
  assert.deepEqual([...scripts.keys()], ['site:fine.example']);
  await sites.activate('later.example');
  assert.ok(scripts.has('site:later.example'));
});

test('Safari: the extension\'s own requests are named by its origin\'s host, and answers\' cookies are left to Safari', () => {
  const dnr = { RuleActionType: { MODIFY_HEADERS: 'modifyHeaders', BLOCK: 'block' }, HeaderOperation: { REMOVE: 'remove' }, ResourceType: { IMAGE: 'image', MEDIA: 'media' } };
  globalThis.chrome = { runtime: { id: 'extension', getURL: path => new URL(path, 'chrome-extension://extension/').href }, declarativeNetRequest: dnr };
  assert.deepEqual([extensionHost(), onSafari()], ['extension', false], 'Chrome: the id is the host');
  assert.ok(anonymousMediaRule(1).action.responseHeaders, 'Chrome takes Set-Cookie off answers');

  // Safari: the id is a bundle name, the host a UUID that changes at every launch.
  const uuid = '5f3c2b9e-8a41-4d7c-9e0f-1b2a3c4d5e6f';
  globalThis.chrome = { runtime: { id: 'com.example.IGCapture.Extension (ABCDE12345)', getURL: path => new URL(path, `safari-web-extension://${uuid}/`).href }, declarativeNetRequest: dnr };
  assert.deepEqual([extensionHost(), onSafari()], [uuid, true]);
  const media = anonymousMediaRule(1);
  assert.deepEqual(media.condition.initiatorDomains, [uuid], 'not runtime.id, which no request carries');
  assert.equal(media.action.responseHeaders, undefined, 'Safari can\'t change response headers: a rule asking to is refused');
  assert.deepEqual(media.action.requestHeaders, [{ header: 'cookie', operation: 'remove' }]);
  assert.ok(localMediaBlockRules(10).every(rule => rule.condition.initiatorDomains[0] === uuid));
});

test('site access is asked for at once, in the user\'s click (Safari asks the user, site by site)', async () => {
  const asked = [];
  globalThis.chrome = { runtime: { getURL: path => `safari-web-extension://uuid${path}` }, permissions: { request: async access => { asked.push(access); return false; } } };
  const answer = requestSiteAccess('example.com');
  assert.deepEqual(asked, [{ origins: ['*://example.com/*'] }], 'asked before anything was awaited: browsers honour a request only during the click');
  assert.equal(await answer, false, 'the user said no');
});

test('site access granted at install is not asked for (Chrome refuses a request without a gesture, even for access it has)', async () => {
  const asked = [];
  let granted = true;
  globalThis.chrome = { runtime: { getURL: path => `chrome-extension://id${path}` }, permissions: {
    contains: async () => granted,
    request: async access => { asked.push(access); throw new Error('This function must be called during a user gesture'); },
  } };
  assert.equal(await requestSiteAccess('example.com'), true);
  assert.deepEqual(asked, [], 'nothing asked');
  granted = false; // the user restricted the extension's site access
  await assert.rejects(requestSiteAccess('example.com'), /user gesture/);
  assert.equal(asked.length, 1, 'asked when withheld');
});

test('toggle with the user\'s answer on site access (Safari): turned on only if granted; turning off asks nothing', async () => {
  const { scripts } = fakeChrome();
  const sites = siteActivation({ scriptsFor: host => [{ matches: [`*://${host}/*`], js: ['content.js'] }] });
  await sites.synced;
  await sites.toggle('denied.example', Promise.resolve(false));
  assert.equal(await sites.isOn('denied.example'), false, 'the user said no: nothing registered');
  assert.deepEqual([...scripts.keys()], []);
  await sites.toggle('granted.example', Promise.resolve(true));
  assert.deepEqual([...scripts.keys()], ['site:granted.example']);
  await sites.toggle('granted.example', Promise.resolve(false));
  assert.deepEqual([...scripts.keys()], [], 'on: the click turns it off, whatever the answer');
  // A request the browser refused to make is reported, not taken for a no.
  await assert.rejects(sites.toggle('broken.example', Promise.reject(new Error('must be called during a user gesture'))), /user gesture/);
});
