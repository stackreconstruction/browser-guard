// browser-guard's log of what the guards do: the source of the code behind an event, and
// a page's repeated events kept from flooding it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const result = await build({ entryPoints: [new URL('../src/guardLog.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { sourceOf, reportRepeated, onGuardEvent } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('the source of a declaration, with its comment, ignoring brackets in strings, templates and regexes', () => {
  const source = [
    'const before = 1;',
    '/** Reads a page. */',
    'export async function read(url: string) {',
    '  const quoted = "}" + \'{\' + `${url} }`;',
    '  const charset = /charset=["\']?([\\w-]+)\\/[}]/i.exec(quoted);',
    '  // a } in a comment',
    '  if (charset) { return 1 / 2; }',
    '}',
    'const after = 2;',
    '// Two lines',
    '// above.',
    'const arrow = (a: number) => ({ a, b: [a] });',
    'const later = 3;',
  ].join('\n');
  assert.equal(sourceOf(source, 'read'), source.split('\n').slice(1, 8).join('\n'));
  assert.equal(sourceOf(source, 'arrow'), '// Two lines\n// above.\nconst arrow = (a: number) => ({ a, b: [a] });');
  assert.equal(sourceOf(source, 'missing'), undefined);
});

test('the source of the guards themselves', async () => {
  const pageHost = await readFile(new URL('../src/pageHost.ts', import.meta.url), 'utf8');
  const see = sourceOf(pageHost, 'seeThroughWhileHeld');
  assert.match(see, /^\/\*\*/);
  assert.match(see, /\n}$|…$/);
  assert.match(see, /export function seeThroughWhileHeld/);
  const local = await readFile(new URL('../src/localNetwork.ts', import.meta.url), 'utf8');
  assert.match(sourceOf(local, 'isLocalIpv4'), /^const isLocalIpv4 = [^\n]*\n[\s\S]*\(a === 192 && b === 168\)[\s\S]*;$/);
});

test('an event a page can repeat is reported once in a while, with how many were left out', () => {
  const seen = [];
  const stop = onGuardEvent(event => seen.push(event.message));
  for (let count = 0; count < 5; count++) reportRepeated('hover', { kind: 'ignored', message: 'made-up hover' }, 60000);
  assert.deepEqual(seen, ['made-up hover']);
  reportRepeated('hover', { kind: 'ignored', message: 'made-up hover' }, 0);
  assert.deepEqual(seen, ['made-up hover', 'made-up hover (4 more since the last report)']);
  stop();
});
