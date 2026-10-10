# ParaLens development guide

ParaLens is a Zotero plugin based on Zotero Plugin Template and Zotero Plugin Toolkit. Its translation backend is a local Python worker using BabelDOC 0.6.4; the reading UI uses two native Zotero Readers. The project does not expose the template's demonstration UI as its product interface.

## Toolchain and build

Use Node.js 22.13 or later, npm, and uv for the Python backend. The Python project requires Python 3.12. Dependency versions are declared in `package.json`, `package-lock.json`, and `backend/pyproject.toml`.

```sh
npm ci
npm run build
```

The output is `.scaffold/build/zotero-paralens.xpi`. Install it from a file in Zotero's plugin manager. The build stages Python sources and license materials, bundles TypeScript, checks types, and verifies the legal materials in the XPI. The XPI does not include a Python virtual environment, layout models, or fonts.

## Local development

```sh
npm run start
```

The scaffold serves a development build. Local executable and profile configuration are read from the scaffold environment; use dedicated test data, not a production Zotero profile. `.env` is local configuration and must not be committed. Example variables are in [`.env.example`](../.env.example).

## Repository layout

| Directory      | Purpose                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `src/backend/` | Backend contracts, credentials, uv runtime, request configuration and output validation |
| `src/mapping/` | Mapping protocol, validation and Zotero attachment storage                              |
| `src/reader/`  | Serial task queue, attachment workflow, native overlays and scroll synchronization      |
| `addon/`       | Zotero resources, preferences, locales and staged distributable files                   |
| `backend/`     | Editable Python worker, mapping adapter and Python tests                                |
| `test/`        | Node unit tests and Zotero GUI tests                                                    |
| `fixtures/`    | Redistributable synthetic test inputs                                                   |
| `scripts/`     | Staging, package checks, isolated test runners and artifact replay                      |
| `docs/`        | Current architecture, setup, compatibility and source distribution                      |

Update backend sources in `backend/`; `scripts/stage-backend.cjs` copies them into the addon. Update source distribution instructions in `docs/source-distribution.md`; staging maintains the bundled copy. Edit third-party notices only in the repository-root `THIRD_PARTY_NOTICES.md`; staging creates the Git-ignored `addon/content/licenses/THIRD_PARTY_NOTICES.md`, the only notice included in the XPI. Upstream license texts retain their original content and attribution.

## Validation

```sh
npm run lint:check
npm run test:unit
npm run build
uv sync --project backend --python 3.12
uv run --project backend --no-sync --offline python -m unittest discover -s backend/tests -v
```

`uv sync` is an explicit installation command and can download packages. The default tests do not call a paid translation API. For Zotero GUI checks, point `PARALENS_TEST_VENV` to an existing BabelDOC environment and use `npm run test:gui:isolated`. Do not run the scaffold's plain `npm test` in a shared workspace or a real user profile: it resets its test directory.

The isolated runner uses synthetic PDFs and a localhost API. Real API modes require explicit authorization and may incur costs; existing-artifact replay does not translate again. See the [setup and testing guide](../docs/backend-setup.md).

## Release and source materials

The `v**` tag workflow builds and releases the plugin, then uploads a matching source archive and checksums. `npm run release` is a publishing operation, not a validation command; it may change the version, create a commit/tag, and push. Review the command and repository state before running it.

The repository URL and addon identity come from `package.json`; XPI naming and update URL templates are in `zotero-plugin.config.ts`. Configured links alone do not prove remote release availability. Follow the [source distribution instructions](../docs/source-distribution.md) and check the actual release materials before distribution.

## Documentation rules

[AGENT.md](../AGENT.md) requires documentation and code comments to describe confirmed current behavior, not development histories, temporary execution stages, or superseded decisions. Verify statements against code and configuration; unresolved implementation differences are not a new roadmap.

See the [project architecture](../docs/project-architecture.md), [native Reader architecture](../docs/native-reader-architecture.md), and [compatibility limits](../docs/compatibility.md). User instructions are in the [main README](../README.md).
