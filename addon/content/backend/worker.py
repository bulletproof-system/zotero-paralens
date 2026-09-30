"""Single-job BabelDOC v0.5.20 worker. Run via uv in backend/.venv.

The config path is the sole CLI argument. No API credentials in argv/status/logs.
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from mapping_adapter import make_mapping


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)


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
    return data, source, job


async def run(data, source, job):
    if (job / "cancel").exists():
        raise RuntimeError("Translation cancelled")
    from babeldoc.docvision.base_doclayout import DocLayoutModel
    from babeldoc.format.pdf.high_level import do_translate, get_translation_stage
    from babeldoc.progress_monitor import ProgressMonitor
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.translator.translator import OpenAITranslator
    from babeldoc.format.pdf.document_il.midend.add_debug_information import AddDebugInformation
    from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater

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

    working = Path(tempfile.mkdtemp(prefix="babeldoc-", dir=job))
    output = Path(tempfile.mkdtemp(prefix="output-", dir=job))
    try:
        translator = OpenAITranslator(
            data["sourceLanguage"], data["targetLanguage"], data["model"],
            base_url=data["baseURL"], api_key=data["apiKey"],
            # BabelDOC's cache is shared across profiles/providers and does not
            # include base_url. Never reuse a response from a different endpoint.
            ignore_cache=True,
        )
        layout = DocLayoutModel.load_onnx()
        if (job / "cancel").exists():
            raise RuntimeError("Translation cancelled")
        config = TranslationConfig(
            translator=translator, input_file=source, lang_in=data["sourceLanguage"],
            lang_out=data["targetLanguage"], doc_layout_model=layout,
            output_dir=output, working_dir=working, debug=True,
            skip_clean=True, no_dual=True, no_mono=False,
            watermark_output_mode=WatermarkOutputMode.NoWatermark,
            auto_extract_glossary=False, qps=1,
        )
        getattr(layout, "init_font_mapper", lambda _config: None)(config)
        # BabelDOC 0.5.20 async_translate can leave its completion event unset
        # on Windows after saving a PDF. The pinned synchronous API returns the
        # same TranslateResult without relying on that event/queue handshake.
        def on_progress(**event):
            if (job / "cancel").exists():
                config.cancel_translation()
                raise RuntimeError("Translation cancelled")
            if event.get("type") in ("progress_start", "progress_update", "progress_end"):
                atomic_json(job / "progress.json", {
                    "stage": str(event.get("stage", ""))[:120],
                    "completed": event.get("stage_current", 0),
                    "total": event.get("stage_total", 0),
                })

        with ProgressMonitor(
            get_translation_stage(config),
            progress_change_callback=on_progress,
            report_interval=config.report_interval,
        ) as monitor:
            result = do_translate(monitor, config)
        if result is None or not result.mono_pdf_path:
            raise RuntimeError("BabelDOC did not produce a monolingual PDF")
        pdf = Path(result.mono_pdf_path).resolve(strict=True)
        if not pdf.is_relative_to(output):
            raise RuntimeError("BabelDOC PDF output escaped the job directory")
        draft = make_mapping(
            source, pdf, config.working_dir / "styles_and_formulas.json",
            config.working_dir / "il_translated.json", config.working_dir / "typsetting.json",
        )
        published = job / "translated.pdf"
        if published.exists():
            raise RuntimeError("Translation output already exists; use a fresh job directory")
        shutil.copyfile(pdf, published)
        atomic_json(job / "mapping.v1.json", draft)
        atomic_json(job / "result.json", {
            "translatedPdfPath": str(published),
            "mappingDraftPath": str(job / "mapping.v1.json"),
        })
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


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: worker.py <private-job-config>")
    # Remove the secret file before any model loading or network request.
    data, source, job = load_config(sys.argv[1])
    try:
        asyncio.run(run(data, source, job))
    except Exception:
        # Never serialize exception messages: third-party exceptions may contain keys/PDF text.
        if (job / "cancel").exists():
            atomic_json(job / "error.json", {"stage": "cancelled", "message": "Translation cancelled"})
        else:
            atomic_json(job / "error.json", {"stage": "failed", "message": "BabelDOC job failed; inspect PDF, model and provider configuration"})
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()