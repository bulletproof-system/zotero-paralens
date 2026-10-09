pref-title = ParaLens Environment and Translation API
pref-description = Translation requires uv; BabelDOC is currently the only supported backend; install it here if needed. API services use an OpenAI-compatible interface.
pref-uv-path = uv path (leave blank to detect automatically)
pref-uv-check = Check uv again
pref-backend = Translation backend
pref-backend-note = Only BabelDOC is implemented so far. The Install button appears when it is missing; uv downloads its Python dependencies. npm builds the plugin but does not install the backend.
pref-backend-install = Install backend
pref-source-language = Source language
pref-target-language = Target language
pref-provider = Translation API
pref-model = Model ID
pref-base-url = API Base URL
pref-api-key = API key (leave blank to keep existing)
pref-delete-key = Delete saved key
pref-save = Save settings
pref-privacy = API keys are stored in Zotero's credential manager, not preferences. Saving settings never makes a paid API request.

pref-concurrency = Translation concurrency
pref-qps = Maximum request starts per second
pref-performance-note = Defaults: concurrency 4, 2 requests/second. Applies to newly queued jobs; PDFs still run one at a time. Lower these if rate limited. Concurrent requests may be billed simultaneously; cancellation cannot recall sent requests.

pref-legal-title = Licenses, third-party notices and source code
pref-legal-notice = Copyright ltt and ParaLens contributors; upstream authors retain their rights. ParaLens is provided without warranty under AGPL-3.0-or-later. You may modify and redistribute it under the applicable license terms. Full license texts are shown below without a network request.
pref-legal-source-note = Source links match the package version. Development builds may include unpublished changes; old releases may lack a source attachment. Access also depends on the repository visibility.
pref-legal-source = Browse versioned source
pref-legal-archive = Download release source archive
