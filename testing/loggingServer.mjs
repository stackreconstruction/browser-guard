// A local site that writes down what every request told it: cookie, Referer, Origin,
// Sec-Fetch-*. The way to prove a privacy claim ("no cookies", "names no page", "asks
// for nothing when opened") instead of reasoning about it. Plain Node, no dependencies.
import { createServer } from 'node:http';

/**
 * Starts a server on 127.0.0.1. `routes` maps a path (or a RegExp tested on it) to an
 * answer: { status, type, body, headers }, or a function of the request giving one (for
 * answers naming the server's own port: a redirect). Unknown paths get a small SVG picture.
 * Every picture answer also tries to plant a cookie (`planted=1`), so a test can check
 * none was accepted.
 */
export async function startLoggingServer(routes = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const { cookie = '', referer = '', origin = '' } = request.headers;
    requests.push({ path: request.url, host: request.headers.host?.split(':')[0], cookie, referer, origin,
      site: request.headers['sec-fetch-site'], mode: request.headers['sec-fetch-mode'], dest: request.headers['sec-fetch-dest'],
      userAgent: request.headers['user-agent'] });
    const found = Object.entries(routes).find(([path]) => path.startsWith('/') ? path === request.url : new RegExp(path).test(request.url))?.[1];
    const route = typeof found === 'function' ? found(request) : found;
    if (route) {
      response.writeHead(route.status ?? 200, { 'Content-Type': route.type ?? 'text/html', ...route.headers });
      return void response.end(route.body ?? '');
    }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Set-Cookie': 'planted=1; SameSite=Lax' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#888"/></svg>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

/** The requests that told the site something: a cookie, a Referer or an Origin. */
export const toldSomething = requests => requests.filter(request => request.cookie || request.referer || request.origin);

/**
 * Chromium flag mapping names to the test server: a "public" site (has a dot) and a
 * "local" one (a bare name counts as the local network), e.g. { 'public.test': '127.0.0.1', router: '127.0.0.1' }.
 */
export const mapHosts = hosts => `--host-resolver-rules=${Object.entries(hosts).map(([name, ip]) => `MAP ${name} ${ip}`).join(', ')}`;
