// Chromium with an unpacked extension loaded, for browser tests and pentests (Playwright).
// Playwright's own Chromium (`npx playwright install chromium`), or the browser that
// CHROME_EXECUTABLE names; Playwright itself from PLAYWRIGHT_MODULE (a module path or
// file:// URL) when it is installed somewhere else.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
/** Playwright's Chromium, as loaded here: for a browser without the extension, launch it with `{ executablePath: process.env.CHROME_EXECUTABLE }`. */
export { chromium };

/**
 * A persistent context (extensions need one) with the extension built in `dir` loaded,
 * headless. `profile`: a directory to launch on again (a browser restart); a new one by
 * default. `args`: more Chromium flags (`mapHosts`). Other options go to Playwright.
 */
export async function launchWithExtension(dir, { profile, args = [], ...options } = {}) {
  const extension = resolve(dir);
  return chromium.launchPersistentContext(profile ?? await mkdtemp(join(tmpdir(), 'extension-browser-')), {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: 'chromium',
    headless: true,
    ...options,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args],
  });
}
