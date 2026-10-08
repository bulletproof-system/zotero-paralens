"""Single-job BabelDOC v0.5.20 worker. Run via uv in backend/.venv.

The config path is the sole CLI argument. No API credentials in argv/status/logs.
"""
import asyncio
import copy
import json
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from mapping_adapter import make_mapping, unavailable_mapping, MappingUnavailableError


_atomic_write_lock = threading.Lock()


def atomic_json(path, value):
    # Serialize callbacks within one worker; distinct temp names also protect
    # independent writers. Native Windows renames to the same destination are
    # not reliably concurrent even when each source has a different name.
    with _atomic_write_lock:
        _atomic_json(path, value)


def _atomic_json(path, value):
    path = Path(path)
    # Progress callbacks can come from two BabelDOC executor pools. A shared
    # name.tmp races (one thread renames/deletes another's pending write),
    # turning a long job into intermittent FileNotFound/Permission errors.
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temp = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
        for attempt in range(6):
            try:
                os.replace(temp, path)
                break
            except PermissionError:
                # Windows readers/antivirus can briefly deny replacement.
                # A persistent permissions/disk problem must still fail safely.
                if attempt == 5:
                    raise
                time.sleep(0.01 * (2 ** attempt))
    finally:
        temp.unlink(missing_ok=True)


def performance_options(data):
    result = {}
    for name, default, maximum in (("concurrency", 4, 16), ("qps", 2, 10)):
        value = data.get(name, default)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ValueError("Invalid translation performance option")
        result[name] = value
    return result


def load_config(path):
    path = Path(path).resolve(strict=True)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    finally:
        path.unlink(missing_ok=True)
    if not isinstance(data, dict):
        raise ValueError("Invalid job configuration")
    source = Path(data["sourcePath"]).resolve(strict=True)
    job = Path(data["jobDirectory"]).resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise ValueError("Source must be an existing PDF")
    if not job.is_dir() or job == source.parent or source.is_relative_to(job):
        raise ValueError("Job directory must be separate from the source PDF")
    with source.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError("Source does not have a PDF header")
    for name in ("apiKey", "model", "baseURL", "sourceLanguage", "targetLanguage"):
        if not isinstance(data.get(name), str) or not data[name].strip():
            raise ValueError(f"Missing job field: {name}")
    # The caller has already verified HTTPS/loopback URL; verify again at worker boundary.
    from urllib.parse import urlsplit
    url = urlsplit(data["baseURL"])
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Remote translation API must use HTTPS")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("API URL must not contain credentials")
    data.update(performance_options(data))
    return data, source, job


def translation_progress(event):
    overall = event.get("overall_progress", 0)
    if not isinstance(overall, (int, float)) or not math.isfinite(overall):
        overall = 0
    return {
        "stage": str(event.get("stage", ""))[:120],
        "completed": event.get("stage_current", 0), "total": event.get("stage_total", 0),
        "percent": max(0, min(90, overall * 0.9)),
    }


@contextmanager
def watch_cancellation(job, cancellation):
    """Cancellation must work during long provider calls, not just UI progress ticks."""
    stop = threading.Event()
    def watch():
        while not stop.wait(0.2):
            if (job / "cancel").exists():
                cancellation.set()
                return
    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()


def guard_translator(translator, job, cancellation):
    # BabelDOC's paragraph translator catches provider exceptions and can
    # publish an untranslated PDF as success. Keep only safe classifications
    # outside its fallback path, and do not start more requests after cancel.
    state = {"successful": 0, "failed": 0, "error": None}
    lock = threading.Lock()
    for name in ("translate", "llm_translate"):
        original = getattr(translator, name, None)
        if original is None:
            continue
        def guarded(*args, _original=original, **kwargs):
            if cancellation.is_set() or (job / "cancel").exists():
                cancellation.set()
                raise asyncio.CancelledError()
            try:
                result = _original(*args, **kwargs)
            except Exception as error:
                status = safe_job_error(error, "translation")
                with lock:
                    state["failed"] += 1
                    if not state["error"] or state["error"]["code"] != "api_auth":
                        state["error"] = status
                # Invalid credentials cannot become valid by retrying every
                # paragraph; prevent hundreds of further billable requests.
                if status["code"] == "api_auth":
                    cancellation.set()
                raise
            with lock:
                state["successful"] += 1
            return result
        setattr(translator, name, guarded)
    return state


class ProviderJobError(RuntimeError):
    def __init__(self, status):
        super().__init__("Provider translation failed")
        self.safe_status = status


class IncompleteTranslationError(RuntimeError):
    """Never include provider output or PDF prose in the exception message."""


def translation_api_options(options):
    """Avoid implicit high-effort thinking in known dual-mode DeepSeek models.

    BabelDOC consumes content, not reasoning_content. Do not send a provider-
    specific option to unrelated models or override an explicit thinking mode.
    See api-docs.deepseek.com/guides/thinking_mode/.
    """
    result = dict(options)
    if result.get("model") in {"deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"}:
        body = dict(result.get("extra_body") or {})
        body.setdefault("thinking", {"type": "disabled"})
        result["extra_body"] = body
    return result


class RequestGate:
    """One job-wide bound shared by both BabelDOC pools and every retry.

    Use monotonic time and cancellation-aware waits; waiting requests hold no
    API slot and cancelled waiters never dispatch new billable requests.
    """
    def __init__(self, concurrency, qps, cancellation):
        self.concurrency = concurrency
        self.interval = 1.0 / qps
        self.cancellation = cancellation
        self.condition = threading.Condition()
        self.active = 0
        self.next_start = 0.0

    @contextmanager
    def request(self):
        with self.condition:
            while True:
                if self.cancellation.is_set():
                    raise asyncio.CancelledError()
                now = time.monotonic()
                if self.active < self.concurrency and now >= self.next_start:
                    self.active += 1
                    self.next_start = now + self.interval
                    break
                self.condition.wait(timeout=0.05)
        try:
            if self.cancellation.is_set():
                raise asyncio.CancelledError()
            yield
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()


def guard_api_response(translator, cancellation, performance=None):
    create = translator.client.chat.completions.create
    gate = RequestGate(performance["concurrency"], performance["qps"], cancellation) if performance else None
    # SDK-internal retries bypass create(). Replace connection/server retries
    # below; BabelDOC retains its own 429 backoff. Every attempt uses our gate.
    if gate:
        translator.client.max_retries = 0
    def request(*args, **options):
        for attempt in range(3):
            try:
                if gate:
                    with gate.request():
                        return create(*args, **options)
                return create(*args, **options)
            except Exception as error:
                if not gate or attempt == 2:
                    raise
                import openai
                status = getattr(error, "status_code", None)
                retryable = (isinstance(error, openai.APIConnectionError)
                             or isinstance(status, int) and (status in (408, 409) or status >= 500))
                if not retryable:
                    raise  # 401/403 never retry; 429 belongs to BabelDOC.
                if cancellation.wait(0.5 * (2 ** attempt)):
                    raise asyncio.CancelledError() from None

    def complete(*args, **kwargs):
        kwargs = translation_api_options(kwargs)
        # BabelDOC 0.5.20 caps LLM requests at 2048 tokens. Reasoning gateways
        # may consume that budget before emitting content. Retry once with a
        # larger budget; empty/truncated output must never become original prose.
        requested = kwargs.get("max_tokens", 0) or 0
        for budget in (max(8192, requested), max(16384, requested)):
            if cancellation.is_set():
                raise asyncio.CancelledError()
            options = dict(kwargs, max_tokens=budget)
            response = request(*args, **options)
            choices = getattr(response, "choices", None)
            choice = choices[0] if choices else None
            content = getattr(getattr(choice, "message", None), "content", None)
            finish = getattr(choice, "finish_reason", None)
            if isinstance(content, str) and content.strip() and finish not in ("length", "content_filter"):
                return response
            if finish == "content_filter":
                break
        raise IncompleteTranslationError("API returned empty or truncated translation")
    translator.client.chat.completions.create = complete


def _english_prose(text):
    return len(re.findall(r"[A-Za-z]{3,}", text or "")) >= 12 and len(re.findall(r"[A-Za-z]", text or "")) >= 80


def _bibliography_entries(text):
    matches = list(re.finditer(r"\[(\d{1,3})\]", text or ""))
    if len(matches) < 3 or len(re.findall(r"\b(?:19|20)\d{2}\b", text or "")) < 3:
        return None
    prefix = (text or "")[:matches[0].start()]
    if _english_prose(prefix):
        return None  # Normal prose with inline citations is not a bibliography.
    # A short venue/URL continuation from the previous page is permitted;
    # it is below the prose threshold, not a blanket cross-page exemption.
    indices = [int(match.group(1)) for match in matches]
    if indices != sorted(set(indices)):
        return None
    return {int(match.group(1)): (text or "")[match.end():matches[i+1].start() if i+1 < len(matches) else None]
            for i, match in enumerate(matches)}


def _untranslated_prose(text, source=None):
    # Bibliographic authors, venues and identifiers stay in their original
    # spelling. This is NOT a blanket references exemption: every substantial
    # numbered source entry must still have a Chinese title/description, and
    # real English prose inside a partially translated entry still fails.
    entries = _bibliography_entries(source) if source else None
    if entries:
        matches = list(re.finditer(r"\[(\d{1,3})\]", text or ""))
        indices = [int(match.group(1)) for match in matches]
        if indices != list(entries):
            return True
        clauses = {"is", "are", "was", "were", "have", "has", "had", "can", "could", "will", "would",
                   "should", "must", "we", "our", "this", "these", "they", "that", "which",
                   "shows", "show", "demonstrates", "proposes", "enables", "analyzes", "compares",
                   "reports", "predicts", "produces", "achieves", "uses", "presents", "provides",
                   "introduces", "evaluates", "improves", "reduces", "increases"}
        for i, match in enumerate(matches):
            entry = (text or "")[match.end():matches[i+1].start() if i+1 < len(matches) else None]
            original = entries[int(match.group(1))]
            if _english_prose(original) and not re.search(r"[\u3400-\u9fff]", entry):
                return True
            for part in re.split(r"[\u3400-\u9fff]+", entry):
                words = {word.lower() for word in re.findall(r"[A-Za-z]+", part)}
                if _english_prose(part) and words & clauses:
                    return True
        return False
    # Chinese elsewhere must not hide an untranslated English passage.
    return any(_english_prose(part) for part in re.split(r"[\u3400-\u9fff]+", text or ""))


def repair_untranslated(engine, docs, job, cancellation, source_paragraphs):
    from babeldoc.format.pdf.document_il.midend.il_translator import ParagraphTranslateTracker
    from babeldoc.format.pdf.document_il.utils.layout_helper import get_paragraph_unicode
    if engine.translation_config.lang_in != "en" or engine.translation_config.lang_out != "zh":
        return {"checked": 0, "repaired": 0, "remaining": 0}
    pending = []
    for page in docs.page:
        for paragraph in page.pdf_paragraph:
            saved = source_paragraphs.get(id(paragraph))
            original = saved.get("text") if isinstance(saved, dict) else saved
            if original is None or not _english_prose(original):
                continue
            # Only substantial prose/captions, not codes, equations, author
            # names, or short diagram labels. Inspect actual compositions, not
            # just unicode (which may retain translator placeholder tokens).
            text = get_paragraph_unicode(paragraph) or ""
            if _untranslated_prose(text, original):
                pending.append((page, paragraph, saved.get("paragraph", paragraph) if isinstance(saved, dict) else paragraph))
    stats = {"checked": len(source_paragraphs), "repaired": 0, "remaining": 0,
             "no_input": 0, "no_chinese_reply": 0, "incomplete_compositions": 0}
    for completed, (page, paragraph, original_paragraph) in enumerate(pending):
        if cancellation.is_set() or (job / "cancel").exists():
            raise asyncio.CancelledError()
        atomic_json(job / "progress.json", {"stage": "补译未翻译的正文段落", "completed": completed,
                                          "total": len(pending), "percent": 77})
        fonts = {font.font_id: font for font in page.pdf_font if font.font_id}
        xobjects = {}
        for xobj in page.pdf_xobject:
            xobjects[xobj.xobj_id] = dict(fonts)
            xobjects[xobj.xobj_id].update({font.font_id: font for font in xobj.pdf_font if font.font_id})
        tracker = ParagraphTranslateTracker()
        text, prepared = engine.il_translator.pre_translate_paragraph(original_paragraph, tracker, fonts, xobjects)
        if text is None:
            stats["no_input"] += 1
            stats["remaining"] += 1
            continue
        prompt = engine.il_translator.generate_prompt_for_llm(text, None, None, prepared)
        translated = engine.translate_engine.llm_translate(prompt, rate_limit_params={})
        if not isinstance(translated, str) or not re.search(r"[\u3400-\u9fff]", translated):
            stats["no_chinese_reply"] += 1
            stats["remaining"] += 1
            continue
        engine.il_translator.post_translate_paragraph(paragraph, tracker, prepared, translated)
        actual = get_paragraph_unicode(paragraph) or ""
        if re.search(r"[\u3400-\u9fff]", actual) and not _untranslated_prose(actual, source_paragraphs[id(paragraph)]["text"] if isinstance(source_paragraphs[id(paragraph)], dict) else source_paragraphs[id(paragraph)]):
            stats["repaired"] += 1
        else:
            stats["incomplete_compositions"] += 1
            stats["remaining"] += 1
    atomic_json(job / "translation-quality.json", stats)
    if stats["remaining"]:
        raise IncompleteTranslationError("Substantial English prose remains untranslated")
    return stats


def finalize_translation(source, pdf, before, translated_il, after, job, diagnostics=None):
    """Finish a generated translation; shared by live jobs and offline artifact replay.
    No API calls or model loading occur in this postprocessing boundary.
    """
    diagnostics = diagnostics if diagnostics is not None else {}
    def mapping_progress(completed, total):
        if (job / "cancel").exists():
            raise RuntimeError("Translation cancelled")
        atomic_json(job / "progress.json", {
            "stage": "生成段落映射", "completed": completed, "total": total,
            "percent": 90 + (completed / total * 6 if total else 0),
        })

    diagnostics["stage"] = "mapping"
    try:
        draft = make_mapping(
            source, pdf, before, translated_il, after,
            on_progress=mapping_progress,
        )
    except MappingUnavailableError:
        if (job / "cancel").exists():
            raise RuntimeError("Translation cancelled") from None
        draft = unavailable_mapping(source, pdf)
        atomic_json(job / "mapping-warning.json", {"schemaVersion": 1, "code": "mapping_unavailable"})
    if (job / "cancel").exists():
        raise RuntimeError("Translation cancelled")
    diagnostics["stage"] = "publish"
    published = job / "translated.pdf"
    if published.exists():
        raise RuntimeError("Translation output already exists; use a fresh job directory")
    atomic_json(job / "progress.json", {"stage": "保存翻译结果", "percent": 97})
    shutil.copyfile(pdf, published)
    atomic_json(job / "mapping.v1.json", draft)
    atomic_json(job / "result.json", {
        "translatedPdfPath": str(published),
        "mappingDraftPath": str(job / "mapping.v1.json"),
    })


async def run(data, source, job, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    performance = performance_options(data)
    diagnostics["stage"] = "backend_load"
    if (job / "cancel").exists():
        raise RuntimeError("Translation cancelled")
    atomic_json(job / "progress.json", {"stage": "加载后端与模型", "percent": 0})
    from babeldoc.docvision.base_doclayout import DocLayoutModel
    from babeldoc.format.pdf.high_level import do_translate, get_translation_stage
    from babeldoc.progress_monitor import ProgressMonitor
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.translator.translator import OpenAITranslator, set_translate_rate_limiter
    from babeldoc.format.pdf.document_il.midend.add_debug_information import AddDebugInformation
    from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater
    from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import ILTranslatorLLMOnly

    # Keep IL snapshots for alignment, but do not draw debugging boxes/text
    # into the PDF delivered to the user. This hook is pinned to BabelDOC 0.5.20.
    AddDebugInformation.process = lambda self, docs: None

    def is_debug_paragraph(paragraph):
        compositions = paragraph.pdf_paragraph_composition
        return bool(compositions) and all(
            item.pdf_character is not None
            and getattr(item.pdf_character, "debug_info", False)
            for item in compositions
        )

    original_write = PDFCreater.write

    def write_without_debug_overlay(creater, translation_config):
        # Layout label helpers insert debug-only character paragraphs even
        # before AddDebugInformation.process. Do not publish those overlays.
        for page in creater.docs.page:
            page.pdf_paragraph[:] = [
                paragraph for paragraph in page.pdf_paragraph
                if not is_debug_paragraph(paragraph)
            ]
        was_debug = translation_config.debug
        translation_config.debug = False
        try:
            return original_write(creater, translation_config)
        finally:
            translation_config.debug = was_debug

    PDFCreater.write = write_without_debug_overlay

    original_translate = ILTranslatorLLMOnly.translate
    def translate_with_quality(engine, docs):
        allowed = {"text", "plain text", "figure_caption", "table_caption", "title", "paragraph_title"}
        # Native get_translate_input deliberately skips post-translation
        # PdfSameStyleUnicodeCharacters. Keep the original compositions for
        # substantial prose, so repairs use real source styles/formulas instead
        # of trying to pre-translate an already-mutated Unicode paragraph.
        sources = {id(paragraph): {"text": paragraph.unicode or "", "paragraph": copy.deepcopy(paragraph)}
                   for page in docs.page for paragraph in page.pdf_paragraph
                   if paragraph.layout_label in allowed and paragraph.debug_id is not None
                   and _english_prose(paragraph.unicode)}
        original_translate(engine, docs)
        try:
            repair_untranslated(engine, docs, job, cancellation, sources)
        except IncompleteTranslationError:
            # Explicit opt-in diagnostics only in the isolated test profile.
            # Never print paragraph/prompt text or place private samples in fixtures.
            if (os.environ.get("PARALENS_TEST_RETAIN_FAILED_IL") == "1"
                    and job.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())):
                from dataclasses import asdict
                atomic_json(job / "failed-translation-il.json", asdict(docs))
                atomic_json(job / "failed-source-paragraphs.json", [
                    {"text": saved["text"], "paragraph": asdict(saved["paragraph"])}
                    for saved in sources.values()
                ])
            raise
    ILTranslatorLLMOnly.translate = translate_with_quality

    working = Path(tempfile.mkdtemp(prefix="babeldoc-", dir=job))
    output = Path(tempfile.mkdtemp(prefix="output-", dir=job))
    try:
        # The programmatic BabelDOC entry point does not apply CLI QPS settings
        # and leaves an upstream limiter at 5. Do not silently cap a configured
        # 6-10 QPS job there; the cancellation-aware API gate is authoritative.
        set_translate_rate_limiter(max(5, performance["qps"]))
        translator = OpenAITranslator(
            data["sourceLanguage"], data["targetLanguage"], data["model"],
            base_url=data["baseURL"], api_key=data["apiKey"],
            # BabelDOC's cache is shared across profiles/providers and does not
            # include base_url. Never reuse a response from a different endpoint.
            ignore_cache=True,
        )
        cancellation = threading.Event()
        guard_api_response(translator, cancellation, performance)
        provider_state = guard_translator(translator, job, cancellation)
        diagnostics["stage"] = "model_load"
        layout = DocLayoutModel.load_onnx()
        if (job / "cancel").exists():
            raise RuntimeError("Translation cancelled")
        config = TranslationConfig(
            translator=translator, input_file=source, lang_in=data["sourceLanguage"],
            lang_out=data["targetLanguage"], doc_layout_model=layout,
            output_dir=output, working_dir=working, debug=True,
            skip_clean=True, no_dual=True, no_mono=False,
            watermark_output_mode=WatermarkOutputMode.NoWatermark,
            auto_extract_glossary=False, qps=performance["qps"],
            pool_max_workers=performance["concurrency"],
        )
        getattr(layout, "init_font_mapper", lambda _config: None)(config)
        # BabelDOC 0.5.20 async_translate can leave its completion event unset
        # on Windows after saving a PDF. The pinned synchronous API returns the
        # same TranslateResult without relying on that event/queue handshake.
        def on_progress(**event):
            if (job / "cancel").exists():
                cancellation.set()
                config.cancel_translation()
                raise asyncio.CancelledError()
            if event.get("type") in ("progress_start", "progress_update", "progress_end"):
                atomic_json(job / "progress.json", translation_progress(event))

        diagnostics["stage"] = "translation"
        with watch_cancellation(job, cancellation), ProgressMonitor(
            get_translation_stage(config),
            progress_change_callback=on_progress,
            finish_callback=lambda **_event: None,
            report_interval=config.report_interval,
            cancel_event=cancellation,
        ) as monitor:
            try:
                result = do_translate(monitor, config)
            except (Exception, asyncio.CancelledError):
                if provider_state["error"] and cancellation.is_set() and not (job / "cancel").exists():
                    raise ProviderJobError(provider_state["error"]) from None
                raise
        if provider_state["failed"] and not provider_state["successful"]:
            raise ProviderJobError(provider_state["error"])
        if (job / "cancel").exists():
            raise asyncio.CancelledError()
        if result is None or not result.mono_pdf_path:
            raise RuntimeError("BabelDOC did not produce a monolingual PDF")
        pdf = Path(result.mono_pdf_path).resolve(strict=True)
        if not pdf.is_relative_to(output):
            raise RuntimeError("BabelDOC PDF output escaped the job directory")
        finalize_translation(
            source, pdf, config.working_dir / "styles_and_formulas.json",
            config.working_dir / "il_translated.json", config.working_dir / "typsetting.json",
            job, diagnostics,
        )
    finally:
        # Windows can briefly retain PDF/model handles. Never let a cleanup
        # PermissionError replace the actual translation error, or turn an
        # otherwise successful translation into a failed frontend job.
        remaining = False
        for folder in (working, output):
            for attempt in range(3):
                try:
                    shutil.rmtree(folder)
                    break
                except OSError:
                    if attempt == 2:
                        remaining = True
                    else:
                        await asyncio.sleep(0.2 * (attempt + 1))
        if remaining:
            # This file contains no exception messages, PDF text, paths or keys.
            try:
                atomic_json(job / "cleanup-warning.json", {
                    "message": "Temporary translation files could not be removed; retry after Zotero exits"
                })
            except OSError:
                pass


def safe_job_error(error, stage):
    """Return only whitelisted classifications; no provider messages, keys or PDF text."""
    if isinstance(error, ProviderJobError):
        return dict(error.safe_status)
    stages = {"backend_load", "model_load", "translation", "mapping", "publish"}
    stage = stage if stage in stages else "translation"
    codes = {
        "AuthenticationError": "api_auth", "PermissionDeniedError": "api_auth",
        "RateLimitError": "api_rate_limit", "APIConnectionError": "api_connection",
        "APITimeoutError": "api_timeout", "TimeoutError": "api_timeout",
        "ConnectTimeout": "api_timeout", "ReadTimeout": "api_timeout",
        "BadRequestError": "api_request", "NotFoundError": "api_request",
        "InternalServerError": "api_server", "MemoryError": "memory_exhausted",
        "IncompleteTranslationError": "translation_incomplete",
        "PermissionError": "storage_failure", "FileNotFoundError": "file_missing",
        "OSError": "storage_failure", "FileDataError": "pdf_invalid", "EmptyFileError": "pdf_invalid",
    }
    code = {"backend_load": "backend_load_failed", "model_load": "model_load_failed",
            "translation": "translation_failed", "mapping": "mapping_failed", "publish": "publish_failed"}[stage]
    seen = set()
    current = error
    for _ in range(8):
        if current is None or id(current) in seen:
            break
        seen.add(id(current))
        for cls in type(current).__mro__:
            if cls.__name__ in codes:
                code = codes[cls.__name__]
                break
        else:
            current = current.__cause__ or current.__context__
            continue
        break
    return {"schemaVersion": 1, "stage": stage, "code": code}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: worker.py <private-job-config>")
    # Remove the secret file before any model loading or network request.
    data, source, job = load_config(sys.argv[1])
    diagnostics = {"stage": "backend_load"}
    try:
        asyncio.run(run(data, source, job, diagnostics))
    except (Exception, asyncio.CancelledError) as error:
        status = ({"schemaVersion": 1, "stage": "cancelled", "code": "cancelled"}
                  if (job / "cancel").exists() else safe_job_error(error, diagnostics["stage"]))
        try:
            atomic_json(job / "error.json", status)
        except OSError:
            pass  # A full/locked disk must not trigger a traceback with the original API error.
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
