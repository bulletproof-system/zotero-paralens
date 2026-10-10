# Third-party notices / 第三方许可声明

ParaLens is licensed under **AGPL-3.0-or-later**; see `LICENSE` at the repository root or `LICENSE.txt` at the XPI root.
Copyright: ltt and ParaLens contributors; upstream authors retain their own rights.
This project is based on Zotero Plugin Template and retains its AGPL licensing.
Third-party software remains subject to its own license; this document does not
relicense it or certify the entire dependency chain.

## Distributed inside the XPI

### Zotero Plugin Toolkit

- Upstream: https://github.com/windingwind/zotero-plugin-toolkit
- License: **MIT**.
- Copyright and full permission notice:
  `licenses/zotero-plugin-toolkit-LICENSE.txt` at the repository or XPI root.
- JavaScript from this library is bundled into the plugin. The source dependency
  version is recorded in `package-lock.json`. Build staging copies the installed
  library's unmodified LICENSE and records its actual version in
  `content/licenses/DEPENDENCIES.json` inside the XPI.
- The checked-in license snapshot corresponds to toolkit 6.0.0. When upgrading,
  review its license, update that snapshot, and review newly bundled dependencies.

The XPI also includes ParaLens's Python worker and mapping adapter, their editable
sources in this repository, and their BabelDOC dependency declaration. These
ParaLens files are covered by the project's AGPL license.

## Installed separately on the user's explicit request

### BabelDOC 0.6.4

- Upstream: https://github.com/funstory-ai/BabelDOC
- Versioned source: https://github.com/funstory-ai/BabelDOC/tree/v0.6.4
- Source archive: https://github.com/funstory-ai/BabelDOC/archive/refs/tags/v0.6.4.tar.gz
- Upstream metadata declares **AGPL-3.0**; do not reinterpret it as an
  unrestricted MIT license or add an upstream `-or-later` grant.
- Exact upstream license snapshot:
  `licenses/BabelDOC-0.6.4-LICENSE.txt` at the repository or XPI root.
- ParaLens imports BabelDOC in a local Python worker. It does not include a
  BabelDOC wheel, source tree, virtual environment, model or font in the XPI.
  Clicking Install runs `uv sync`; no installation happens merely on startup.
- Imports, adapters and runtime hooks do not authorize removal of upstream
  notices. If you redistribute BabelDOC or a modified backend, retain its
  notices and supply the applicable corresponding source and build information.

### PyMuPDF and the rest of the Python dependency tree

- PyMuPDF is required by BabelDOC and directly imported by ParaLens's adapter.
  Upstream offers an AGPL v3 option and a commercial license option:
  https://github.com/pymupdf/PyMuPDF and
  https://pymupdf.readthedocs.io/en/latest/about.html.
- The open-source route must observe the upstream AGPL requirements. A commercial
  exception is not granted by this repository.
- Only BabelDOC itself is currently pinned. No reviewed Python `uv.lock` is
  included, so transitive versions, platform-specific wheels and their notices
  are **not a fully audited or reproducible dependency inventory**.
- Before shipping a Python environment or offline installer, record the actual
  versions, inspect each distribution's license and bundled native components,
  and include the needed notices and corresponding-source provisions.
- Downloaded models, OCR assets and fonts require their own license review; the
  BabelDOC software license alone is not a license for all such assets.

## Development tools and host application

TypeScript (Apache-2.0), ESLint, Prettier, Mocha, Chai, types packages and other
build/test dependencies are listed with versions and declared licenses in
`package-lock.json`. Zotero Plugin Scaffold and the ESLint configuration use
AGPL-3.0-or-later. They are not shipped as a node_modules tree inside the XPI.
Any code copied from tools into an output must still be reviewed separately.
Zotero is supplied independently by its upstream; this package does not ship
Zotero or replace its license.

## Source and warranty

ParaLens is provided **without warranty**. Recipients may modify and redistribute
it under the applicable AGPL terms, while preserving upstream rights and notices.
See `docs/source-distribution.md` at the repository or XPI root for obtaining
the matching source, building, installation and release checks. Local readable
license copies are also included in `content/licenses/` inside the XPI.
