# Browser Guard

Browser Guard provides TypeScript helpers for browser extensions. It includes
per-site activation, request and sender validation, local address filtering,
isolated page UI, inert document copies, guard event logging, and messaging
between extension pages and content scripts.

The root entry point is `src/index.ts`. The optional React entry point is
`src/react.ts`. Use a TypeScript-aware bundler and supply the browser extension
APIs required by the modules you integrate. React is needed for the React entry
point, and Chrome type definitions can be installed for type checking.

## Run the tests

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

To use an existing Chromium installation, pass its executable path via
`CHROME_EXECUTABLE`. The browser test serves its fixtures through Playwright
request interception.

See [DEPENDENCY-LICENSES.md](DEPENDENCY-LICENSES.md) for the dependency inventory.
This source snapshot does not include an upstream Browser Guard license or
define buyer usage terms. The dependency licenses apply to their respective
packages.
