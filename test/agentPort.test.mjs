// The port between an extension page (a window of the extension's own) and the agents in
// a tab's content script: the window sees each agent's data and can call its functions,
// and nothing else; only the extension's own windows, on the port's name, are served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/agentPort.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { serveAgents, remoteAgents, serveAgentsToWindows, connectToTab } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

/** Two connected ends; messages are copied across as Chrome copies them. */
function portPair() {
  const listeners = { a: [], b: [] };
  const end = (self, other) => ({
    postMessage: message => { const copy = structuredClone(message); queueMicrotask(() => listeners[other].forEach(listener => listener(copy))); },
    onMessage: { addListener: listener => listeners[self].push(listener) },
  });
  return [end('a', 'b'), end('b', 'a')];
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the window sees the agents\' data and calls their functions by name', async () => {
  const [tab, window] = portPair();
  const calls = [];
  let agents = { gallery: { page: 'https://site.test/a', logs: [], scan: () => calls.push('scan'), forget: url => calls.push(`forget ${url}`) } };
  let seen = null;
  remoteAgents(window, value => { seen = value; });
  const send = serveAgents(tab, () => agents);
  await settle();
  assert.equal(seen.gallery.page, 'https://site.test/a');
  assert.deepEqual(seen.gallery.logs, []);
  // Given straight to a button, a function gets the click event: it isn't sent.
  seen.gallery.scan({ nativeEvent: {}, target: { cyclic: null } });
  seen.gallery.forget('https://cdn.test/x.jpg');
  await settle();
  assert.deepEqual(calls, ['scan', 'forget https://cdn.test/x.jpg']);

  // A change is sent again, only the field that changed; the functions stay the same ones, so the panel's hooks hold.
  const scanBefore = seen.gallery.scan;
  const messages = [];
  window.onMessage.addListener(message => messages.push(message));
  agents = { gallery: { ...agents.gallery, page: 'https://site.test/b' } };
  send('gallery');
  await settle();
  assert.equal(seen.gallery.page, 'https://site.test/b');
  assert.deepEqual(seen.gallery.logs, [], 'what didn\'t change is kept');
  assert.equal(seen.gallery.scan, scanBefore);
  assert.deepEqual(messages.map(message => Object.keys(message.view)), [['page']]);
  // Nothing changed: nothing is sent.
  agents = { gallery: { ...agents.gallery } };
  send('gallery');
  await settle();
  assert.equal(messages.length, 1);
});

test('only the agents\' own functions can be called', async () => {
  const [tab, window] = portPair();
  const calls = [];
  serveAgents(tab, () => ({ gallery: { page: 'p', scan: () => calls.push('scan') } }));
  for (const message of [
    { type: 'call', agent: 'gallery', command: 'page', args: [] },
    { type: 'call', agent: 'gallery', command: 'constructor', args: [] },
    { type: 'call', agent: 'gallery', command: 'toString', args: [] },
    { type: 'call', agent: 'other', command: 'scan', args: [] },
    { type: 'call', agent: 'gallery', command: 'scan', args: 'not a list' },
    { type: 'view', agent: 'gallery', view: {}, commands: [] },
  ]) window.postMessage(message);
  await settle();
  assert.deepEqual(calls, []);
  window.postMessage({ type: 'call', agent: 'gallery', command: 'scan', args: [] });
  await settle();
  assert.deepEqual(calls, ['scan']);
});

/** A port end as chrome.runtime.Port has it: a name, its sender, and a disconnect to fire. */
function chromePort(end, fields) {
  const disconnects = [];
  return Object.assign(end, fields, {
    onDisconnect: { addListener: listener => disconnects.push(listener) },
    closed: () => disconnects.forEach(listener => listener()),
  });
}

test('a content script serves only its own extension\'s windows, on its port\'s name, until stopped', async () => {
  const onConnect = new Set();
  globalThis.chrome = { runtime: { id: 'extension', onConnect: { addListener: listener => onConnect.add(listener), removeListener: listener => onConnect.delete(listener) } } };
  let agents = { gallery: { page: 'a' } };
  const server = serveAgentsToWindows(() => agents, 'tools');
  /** A window connecting, and the views it is sent. */
  const connect = (name, senderId = 'extension') => {
    const [tab, window] = portPair();
    const port = chromePort(tab, { name, sender: { id: senderId } });
    const views = [];
    window.onMessage.addListener(message => views.push(message.view));
    onConnect.forEach(listener => listener(port));
    return { port, views };
  };
  const tools = connect('tools');
  const otherName = connect('panel');
  const otherExtension = connect('tools', 'someone-else');
  await settle();
  assert.deepEqual(tools.views, [{ page: 'a' }]);
  assert.deepEqual(otherName.views, [], 'another port name is not served');
  assert.deepEqual(otherExtension.views, [], 'another extension is not served');

  agents = { gallery: { page: 'b' } };
  server.changed('gallery');
  await settle();
  assert.deepEqual(tools.views, [{ page: 'a' }, { page: 'b' }]);
  // A window that closed is sent nothing more; stopped, the content script hears no one.
  tools.port.closed();
  agents = { gallery: { page: 'c' } };
  server.changed('gallery');
  await settle();
  assert.equal(tools.views.length, 2);
  server.stop();
  assert.equal(onConnect.size, 0);
});

test('a window connects on its port\'s name, has null while the tab has no agents, tries again a while, and stops when told', async () => {
  const opened = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabs: {
      connect: (tabId, { name }) => {
        const [window, tab] = portPair();
        const port = chromePort(window, { name, disconnect: () => { port.disconnected = true; } });
        opened.push({ tabId, name, port, tab });
        return port;
      },
    },
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const seen = [];
  const disconnect = connectToTab(4, agents => seen.push(agents && agents.gallery.page), { name: 'tools', retryMs: 5, retries: 2 });
  assert.deepEqual(opened.map(({ tabId, name }) => [tabId, name]), [[4, 'tools']]);
  serveAgents(opened[0].tab, () => ({ gallery: { page: 'a' } }));
  await settle();
  assert.deepEqual(seen, ['a']);

  // The content script goes (the page navigates): null, then another try, `retries` in a row at most.
  opened[0].port.closed();
  assert.deepEqual(seen, ['a', null]);
  await wait(20);
  assert.equal(opened.length, 2);
  opened[1].port.closed();
  await wait(20);
  assert.equal(opened.length, 3);
  opened[2].port.closed();
  await wait(20);
  assert.equal(opened.length, 3, 'it gave up');

  // Disconnecting closes the port, and nothing tries again after.
  const stop = connectToTab(5, () => {}, { retryMs: 5 });
  const last = opened.at(-1);
  assert.equal(last.name, 'panel', 'the default name');
  stop();
  assert.ok(last.port.disconnected);
  last.port.closed();
  await wait(20);
  assert.equal(opened.at(-1), last);
  disconnect();
});
