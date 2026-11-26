// Copying a page's DOM (to save it, or read an article out of it) without the copy
// doing anything. cloneNode in the live document makes copied <img>, <video> and
// <iframe> load again: tracking pixels and blocked images were requested once more,
// with the page as referer, and setting an image's src from data-src on the copy loaded
// images the page never had. A document with no window loads nothing.

/** A deep copy of `node` in a document with no window: nothing in it loads or runs. */
export function inertCopy<T extends Node>(node: T): T {
  return document.implementation.createHTMLDocument('').importNode(node, true) as T;
}

/**
 * A Content-Security-Policy for a saved page: no scripts, and no requests when opened
 * (everything it shows is embedded as data:), except a linked video or sound when played,
 * and a font from whoever serves the file ('self': a reader such as the cs-learning hub,
 * dressing the page in its own typeface; never the site the page came from).
 * Put it in a <meta http-equiv> first in <head>; drop the page's <base>, ping attributes
 * and preloads; make cross-origin frames links.
 */
export const SAVED_PAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data: 'self'; media-src data: http: https:; form-action 'none'; base-uri 'none'";
