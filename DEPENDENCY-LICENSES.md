# Dependency licenses

The locked dependency entries were checked against the npm-generated
`package-lock.json`. This archive contains source and dependency manifests.
It does not bundle npm packages or browser binaries.

| Package | Version checked | License | Use |
| --- | --- | --- | --- |
| `esbuild` and its 23 platform-specific `@esbuild/*` packages | 0.21.5 | MIT | Test bundler and optional binaries |
| `playwright`, `playwright-core` | 1.56.1 | Apache-2.0 | Browser tests |
| `fsevents` | 2.3.2 | MIT | Optional macOS dependency of Playwright |
| `react` | 18.0.0 | MIT | Optional peer for the React entry point |
| `@types/chrome` | 0.0.260 | MIT | Optional peer for type checking |

React and Chrome types are selected by the consumer. The checked versions
are the lower bounds declared in the manifest. Other resolutions and their
transitive dependencies should be checked if included in a downstream bundle.
Preserve the applicable upstream license and copyright notices when
redistributing third-party code, along with Apache NOTICE materials where applicable.
