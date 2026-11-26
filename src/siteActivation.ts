// Opt-in per site: an extension that runs on a site only once the user turns it on
// there. Until then the site's pages get no script, element or listener of it, so
// nothing on them (trackers included) can see or trigger it. Turned on, every tab and
// later page of the site has it, across restarts, until turned off.
//
// How: the sites are kept in trustedStore.ts (the source of truth: IndexedDB of the
// extension's origin, which content scripts can't write; mirrored into chrome.storage.local
// for the pages that show it, never read back from there after the first time), and their
// content scripts registered with chrome.scripting (persistAcrossSessions). When the
// worker starts, the registered scripts are made to match the list: an extension
// reload or update can drop them. Changes go one at a time, so two quick clicks, or a
// click while the worker starts, can't interleave. Needs the "scripting" and "storage"
// permissions, and host permissions for the sites.

import { trustedGet, trustedSet } from './trustedStore';

/** A content script for a site, without its id: siteActivation names them. */
export type SiteScript = Omit<chrome.scripting.RegisteredContentScript, 'id'>;

export interface SiteActivationOptions {
  /** The content scripts a site gets (the first is its main one). */
  scriptsFor: (host: string) => SiteScript[];
  /**
   * Whether the scripts are registered with the browser, which then puts them into every
   * later page (the default). False where chrome.scripting can't register scripts, or
   * isn't trusted to: the list alone is kept, and the caller puts the scripts into each
   * page of a site turned on as it loads (tabs.onUpdated).
   */
  persistent?: boolean;
  /** The key holding the hosts turned on (trustedStore.ts; its mirror in chrome.storage.local). */
  storageKey?: string;
  /** After a site is turned on: put the scripts into its open tabs, show it on the badge, … */
  onOn?: (host: string, scripts: chrome.scripting.RegisteredContentScript[]) => Promise<void> | void;
  /** After a site is turned off: tell its open tabs to remove what they show, … */
  onOff?: (host: string) => Promise<void> | void;
}

export interface SiteActivation {
  activate: (host: string) => Promise<void>;
  deactivate: (host: string) => Promise<void>;
  /**
   * Turns a site on if it is off, else off. `access`: the pending answer of
   * requestSiteAccess, asked in the user's click (Safari); off, the site stays off
   * unless it is granted.
   */
  toggle: (host: string, access?: Promise<boolean>) => Promise<void>;
  isOn: (host: string) => Promise<boolean>;
  /** The hosts turned on. */
  sites: () => Promise<string[]>;
  /**
   * Settles once the registered scripts match the list, after the worker started. Rejects
   * naming the sites it couldn't make match (every site is tried): handle it, or the
   * worker reports it as an uncaught error.
   */
  synced: Promise<void>;
  /** Runs a change to the sites in turn with the others. */
  inTurn: <T>(change: () => Promise<T>) => Promise<T>;
}

const PREFIX = 'site:';
/** A site's script ids: `site:<host>` for its main one, `site:<host>#<n>` for the others. */
const idsFor = (host: string, count: number) => Array.from({ length: count }, (_, at) => at ? `${PREFIX}${host}#${at}` : `${PREFIX}${host}`);
/**
 * The host an id names. Ids of another scheme under the prefix (`site:<host>:x`) still
 * name their host, so sync replaces them; an IPv6 host keeps the colons in its brackets.
 */
function hostOf(id: string): string | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length).split('#')[0];
  return rest.startsWith('[') ? rest.slice(0, rest.indexOf(']') + 1) : rest.split(':')[0];
}

export function siteActivation({ scriptsFor, persistent = true, storageKey = 'activeSites', onOn, onOff }: SiteActivationOptions): SiteActivation {
  const scripts = (host: string) => {
    const list = scriptsFor(host);
    const ids = idsFor(host, list.length);
    return list.map((script, at) => ({ persistAcrossSessions: true, ...script, id: ids[at] }));
  };
  const registered = async () => persistent ? (await chrome.scripting.getRegisteredContentScripts()).map(script => script.id) : [];
  const register = async (list: chrome.scripting.RegisteredContentScript[]) => { if (persistent) await chrome.scripting.registerContentScripts(list); };

  /** The hosts turned on; before the list was kept, the ones with a main script registered. */
  const sites = async (): Promise<string[]> => {
    const stored = await trustedGet(storageKey);
    if (Array.isArray(stored)) return stored.filter((host): host is string => typeof host === 'string');
    return [...new Set((await registered()).map(hostOf).filter((host): host is string => !!host))];
  };
  const keep = (hosts: string[]) => trustedSet(storageKey, [...new Set(hosts)].sort());
  const isOn = async (host: string) => (await sites()).includes(host);

  // Every script of the site's, whatever their number: unregistering an id that isn't
  // registered fails the whole call, unregistering nothing (a site then stays on).
  const unregister = async (host: string) => {
    const ids = (await registered()).filter(id => hostOf(id) === host);
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  };

  let changes: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(change: () => Promise<T>): Promise<T> => {
    const next = changes.then(change);
    changes = next.catch(() => {});
    return next;
  };

  const turnOn = async (host: string) => {
    const list = scripts(host);
    await keep([...await sites(), host]);
    await unregister(host);
    await register(list);
    await onOn?.(host, list);
  };
  const turnOff = async (host: string) => {
    await keep((await sites()).filter(on => on !== host));
    await unregister(host);
    await onOff?.(host);
  };

  /** Makes the registered scripts match the sites turned on (keeping the list, the first time). */
  const sync = async () => {
    const hosts = await sites();
    await keep(hosts);
    const ids = await registered();
    // One site failing doesn't stop the others; the failures are named after, never passed over (RULES.md 1.3).
    const failures: string[] = [];
    const attempt = (host: string, step: () => Promise<unknown>) =>
      step().catch(error => { failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`); });
    for (const host of new Set(ids.map(hostOf).filter((host): host is string => !!host && !hosts.includes(host)))) await attempt(host, () => unregister(host));
    for (const host of hosts) {
      const expected = scripts(host).map(script => script.id);
      const present = ids.filter(id => hostOf(id) === host);
      if (expected.length === present.length && expected.every(id => present.includes(id))) continue;
      await attempt(host, async () => {
        await unregister(host);
        await register(scripts(host));
      });
    }
    if (failures.length) throw new Error(`siteActivation: the registered scripts don't match the sites turned on (${failures.join('; ')})`);
  };

  return {
    activate: host => inTurn(() => turnOn(host)),
    deactivate: host => inTurn(() => turnOff(host)),
    toggle: (host, access) => inTurn(async () => {
      if (await isOn(host)) {
        access?.catch(() => {}); // asked in the click before it was known; turning off needs no answer
        return turnOff(host);
      }
      if (!access || await access) await turnOn(host);
    }),
    isOn,
    sites,
    synced: inTurn(sync),
    inTurn,
  };
}
