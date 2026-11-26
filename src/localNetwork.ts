// The local network: this machine and its network, as the Local Network Access spec
// draws it (loopback, RFC 1918, carrier-grade NAT, benchmarking, link-local,
// unique-local, documentation addresses), plus .local and bare names. A page can name
// such an address, and an extension (its worker, its own pages) can reach it where the page itself may not:
// the browser keeps public pages from the local network, not extensions. So an
// extension fetches or loads a local address for a page only when that page is local too.

/**
 * The same, as declarativeNetRequest regexFilters (for blocking an extension's own
 * requests to the local network, redirects included). In the syntax every browser
 * takes: Safari's is WebKit's content-blocker subset (`.`, `[a-b]` ranges, `?` `+` `*`,
 * groups, `^` `$`; no `|`, `{n,m}`, `(?:`, `\d` or `[^…]`), so each alternative is a
 * pattern of its own; Chromium rejects one combined pattern as too expensive anyway.
 * They match URLs as the browser hands them over: canonical, lowercase host, a path.
 */
const USER = "([a-zA-Z0-9._~%!$&'()*+,;=:-]*@)?"; // credentials before the host, if any (no "/", so not a path's "@")
const WEB = `^https?://${USER}`;
const END = '(:[0-9]+)?/'; // a port, if any, then the path
const NAME_END = `\\.?${END}`; // a name may end in a dot (localhost.), which the browser keeps and resolves the same
const OCTET = '[0-9]+';
const ipv4 = (start: string, octetsLeft: number) => `${WEB}${start}${`\\.${OCTET}`.repeat(octetsLeft)}${END}`;
export const LOCAL_URL_PATTERNS: readonly string[] = [
  `${WEB}[a-z0-9_-]+${NAME_END}`, // a bare name: localhost, router
  `${WEB}[a-z0-9._-]*\\.local${NAME_END}`,
  `${WEB}[a-z0-9._-]*\\.localhost${NAME_END}`,
  ipv4('0', 3), ipv4('10', 3), ipv4('127', 3),
  ipv4('169\\.254', 2), ipv4('192\\.168', 2),
  ipv4('172\\.1[6-9]', 2), ipv4('172\\.2[0-9]', 2), ipv4('172\\.3[0-1]', 2),
  ipv4('100\\.6[4-9]', 2), ipv4('100\\.[7-9][0-9]', 2), ipv4('100\\.1[0-1][0-9]', 2), ipv4('100\\.12[0-7]', 2), // carrier-grade NAT
  ipv4('198\\.1[8-9]', 2), // benchmarking
  ...['::1?\\]', '::ffff:', 'f[c-d][0-9a-f][0-9a-f]:', 'fe[8-9a-f][0-9a-f]:', 'ff[0-9a-f][0-9a-f]:', '2001:db8:', '3fff:[0-9a-f]?[0-9a-f]?[0-9a-f]?:']
    .map(start => `${WEB}\\[${start}`), // IPv6: loopback, IPv4-mapped, unique-local, link-local, multicast, documentation
];

/** Whether a hostname (as URL.hostname gives it) is on this machine or its network. */
export function isLocalHost(hostname: string): boolean {
  // A name's final dot (localhost.) names the same host: the browser resolves it alike.
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  // Only an IPv6 address has a colon: a name like fd00.com must not read as one.
  if (host.includes(':')) return isLocalIpv6(host);
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || !host.includes('.')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return isLocalIpv4(a, b);
}

const isLocalIpv4 = (a: number, b: number) =>
  a === 0 || a === 10 || a === 127
  || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT (Tailscale's addresses, too)
  || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  || (a === 198 && (b === 18 || b === 19)); // benchmarking

function isLocalIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  // URL normalizes an IPv4-mapped address to two final hexadecimal hextets.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(host);
  if (mapped) {
    const address = Number.parseInt(mapped[1], 16) * 0x10000 + Number.parseInt(mapped[2], 16);
    return isLocalIpv4(address >>> 24, address >>> 16 & 0xff);
  }
  const [first, second] = host.split(':').map(hextet => Number.parseInt(hextet || '0', 16));
  return (first >= 0xfc00 && first <= 0xfdff) // unique-local
    || (first >= 0xfe80 && first <= 0xfeff) // link-local, and the deprecated site-local
    || first >= 0xff00 // multicast
    || (first === 0x2001 && second === 0xdb8) || (first === 0x3fff && second < 0x1000); // documentation
}

/** Whether a URL is an http(s) address on the local network. */
export function isLocalUrl(url = ''): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && isLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the extension may fetch or load `url` on behalf of the page at `fromUrl`: a
 * web address, and on the local network only when that page is too.
 */
export function reachableFrom(url: string, fromUrl = ''): boolean {
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) return false;
  } catch {
    return false;
  }
  return !isLocalUrl(url) || isLocalUrl(fromUrl);
}
