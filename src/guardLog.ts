// What the guards do, for the user to see: each request the extension makes and what it
// withheld, each one refused, each made-up event a page fired and was ignored. An event
// names the code that decided it, so a log can show that code (`sourceOf`) beside it.

export interface GuardEvent {
  /**
   * network: a request the extension made (and what it kept from the site); blocked: one
   * it refused; ignored: input a page made up; info: a guard switched on or off.
   */
  kind: 'network' | 'blocked' | 'ignored' | 'info';
  message: string;
  /** The facts: address, cookies, redirects, headers, who asked. */
  details?: Record<string, string>;
  /** Where the deciding code is: a file (as the project names it) and a declaration in it. */
  code?: { file: string; name: string };
}

type Listener = (event: GuardEvent) => void;
const listeners = new Set<Listener>();

/** Hands a guard event to every listener (the extension's log). */
export function reportGuard(event: GuardEvent): void {
  listeners.forEach(listener => listener(event));
}

/** Listens for guard events reported in this script; returns how to stop. */
export function onGuardEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const lastReported = new Map<string, { at: number; skipped: number }>();

/**
 * Reports an event a page can repeat at will (made-up hovers, keys) at most once per
 * `ms` for its `key`, with how many were left out since: a page can't flood the log.
 */
export function reportRepeated(key: string, event: GuardEvent, ms = 10000): void {
  const now = Date.now();
  const last = lastReported.get(key);
  if (last && now - last.at < ms) return void last.skipped++;
  lastReported.set(key, { at: now, skipped: 0 });
  reportGuard(last?.skipped ? { ...event, message: `${event.message} (${last.skipped} more since the last report)` } : event);
}

/** Longest source shown for one declaration. */
const MAX_LINES = 80;

/**
 * The source of the declaration `name` (a function, or a const) in `source`, with the
 * comment right above it; undefined when there is none. A const's end is found reading
 * strings, template literals, regular expressions and comments, so their brackets don't count.
 */
export function sourceOf(source: string, name: string): string | undefined {
  const declaration = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function\\*?\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`, 'm').exec(source);
  if (!declaration) return undefined;
  const end = declarationEnd(source, declaration.index);
  // The comment block (/** … */ or // lines) directly above.
  const before = source.slice(0, declaration.index).split('\n');
  before.pop();
  let start = before.length;
  if (/\*\/\s*$/.test(before[start - 1] ?? '')) while (start > 0 && !/^\s*\/\*/.test(before[--start]));
  else while (start > 0 && /^\s*\/\//.test(before[start - 1])) start--;
  const text = [...before.slice(start), source.slice(source.lastIndexOf('\n', declaration.index) + 1, end)].join('\n');
  const lines = text.split('\n');
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length));
  const shown = lines.map(line => line.slice(indent));
  return shown.length > MAX_LINES ? [...shown.slice(0, MAX_LINES), '…'].join('\n') : shown.join('\n');
}

/**
 * Where a declaration starting at `from` (a line's start) ends. A function: at the `}`
 * on a line of its own at the declaration's indent (or its own line, when the body is on
 * it; type annotations hold braces too). A const: at its `;` outside any brackets.
 */
function declarationEnd(source: string, from: number): number {
  const firstLine = source.slice(from, lineEnd(source, from));
  if (/^\s*(?:export\s+)?(?:async\s+)?function/.test(firstLine)) {
    if (/}\s*$/.test(firstLine)) return from + firstLine.length;
    const indent = /^\s*/.exec(firstLine)![0];
    const close = new RegExp(`\n${indent}}`, 'g');
    close.lastIndex = from;
    const found = close.exec(source);
    return found ? found.index + found[0].length : source.length;
  }
  let depth = 0;
  let previous = '';
  for (let at = from; at < source.length; at++) {
    const char = source[at];
    if (char === '/' && source[at + 1] === '/') { at = lineEnd(source, at) - 1; continue; }
    if (char === '/' && source[at + 1] === '*') { at = source.indexOf('*/', at + 2) + 1 || source.length; continue; }
    if (char === '"' || char === '\'' || char === '`') { at = closing(source, at, char); previous = char; continue; }
    // A slash where a value is expected starts a regular expression.
    if (char === '/' && /^[(,=:[!&|?{};+\-*%<>~^]?$/.test(previous)) { at = regexEnd(source, at); previous = '/'; continue; }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (depth === 0 && char === ';') return at + 1;
    if (!/\s/.test(char)) previous = char;
  }
  return source.length;
}

const lineEnd = (source: string, at: number) => (source.indexOf('\n', at) + 1 || source.length + 1) - 1;

/** The index of the quote closing the string or template literal opened at `at`. */
function closing(source: string, at: number, quote: string): number {
  for (let next = at + 1; next < source.length; next++) {
    if (source[next] === '\\') next++;
    else if (source[next] === quote) return next;
  }
  return source.length;
}

/** The index of the slash closing the regular expression opened at `at` (a `/` inside [...] doesn't close it). */
function regexEnd(source: string, at: number): number {
  let inClass = false;
  for (let next = at + 1; next < source.length && source[next] !== '\n'; next++) {
    if (source[next] === '\\') next++;
    else if (source[next] === '[') inClass = true;
    else if (source[next] === ']') inClass = false;
    else if (source[next] === '/' && !inClass) return next;
  }
  return at;
}
