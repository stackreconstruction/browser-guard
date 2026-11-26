// State a privileged decision reads (which sites are on, which extension is told a tab's id),
// kept where only the extension's own pages and worker can write it: IndexedDB of the
// extension's origin. Content scripts run in the page's origin, so they can't reach it;
// chrome.storage.local is theirs to write too, and setAccessLevel would close the whole area to
// them (an app's page UI may need it for its settings), so a compromised renderer on a site that
// is on could otherwise turn on another site.
//
// A value is mirrored into chrome.storage.local under the same key, for the pages that show it
// (they may read the mirror; no decision does). The first read takes chrome.storage.local's
// value, where it was kept before, and keeps it from then on. Where the worker has no
// IndexedDB (or it fails to open), chrome.storage.local alone, as before (browsers.ts).

const DB_NAME = 'browser-guard-trusted';
const STORE = 'values';

let database: Promise<IDBDatabase | null> | undefined;
const opened = (): Promise<IDBDatabase | null> => database ??= new Promise(resolve => {
  if (typeof indexedDB === 'undefined') return resolve(null);
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => resolve(null);
});

const done = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** What `key` holds (undefined: nothing), read from the trusted store. Don't keep null: it stands for nothing. */
export async function trustedGet(key: string): Promise<unknown> {
  const db = await opened();
  const local = async () => (await chrome.storage.local.get(key))[key];
  if (!db) return local();
  const held = await done(db.transaction(STORE).objectStore(STORE).get(key));
  if (held !== undefined) return held ?? undefined; // null: taken over when there was nothing
  // The first read: what was kept there before this store, once (nothing written there later is taken).
  const before = await local();
  await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put(before ?? null, key));
  return before;
}

/**
 * Keeps `value` under `key` in the trusted store, and its mirror in chrome.storage.local
 * (`mirror: false`: where the page that shows it writes the mirror itself, as it is typed).
 */
export async function trustedSet(key: string, value: unknown, { mirror = true } = {}): Promise<void> {
  const db = await opened();
  if (db) await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
  if (mirror || !db) await chrome.storage.local.set({ [key]: value });
}
