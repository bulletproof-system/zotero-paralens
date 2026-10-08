import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mapping_adapter import make_mapping, _refs, MappingUnavailableError
import worker
from worker import load_config


class Point:
    def __init__(self, x, y): self.x, self.y = x, y
    def __mul__(self, matrix): return Point(self.x, 100 - self.y)


class Matrix:
    def __invert__(self): return self


class Rect:
    def __init__(self): self.x0, self.y0, self.x1, self.y1 = 0, 0, 100, 100
    @property
    def width(self): return 100
    @property
    def height(self): return 100
    def __mul__(self, matrix): return self


class Quad:
    def __init__(self):
        self.ul, self.ur = Point(10, 10), Point(50, 10)
        self.lr, self.ll = Point(50, 20), Point(10, 20)
        self.rect = Rect()


class Page:
    cropbox = Rect()
    transformation_matrix = Matrix()
    def __init__(self, text): self.text = text
    def search_for(self, text, quads): return [Quad()] if text == self.text else []
    def get_textbox(self, rect): return self.text
    def get_image_info(self, hashes=True): return []


class Document:
    def __init__(self, page): self.page = page
    def __len__(self): return 1
    def __getitem__(self, index): return self.page
    def __enter__(self): return self
    def __exit__(self, *_): pass


class AdapterTests(unittest.TestCase):
    def test_real_pdf_text_matches_il_and_geometry(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            src, dst = folder / "in.pdf", folder / "out.pdf"
            src.write_bytes(b"%PDF-source")
            dst.write_bytes(b"%PDF-target")
            def stage(filename, text, paragraph_id="same"):
                path = folder / filename
                path.write_text(json.dumps({"page": [{"pdf_paragraph": [
                    {"unicode": text, "debug_id": paragraph_id}
                ]}]}), encoding="utf-8")
                return path
            before = stage("before.json", "Original paragraph")
            middle = stage("middle.json", "Translated paragraph")
            after = stage("after.json", "Translated paragraph")
            docs = {src: Document(Page("Original paragraph")),
                    dst: Document(Page("Translated paragraph"))}
            with patch.dict(sys.modules, {"pymupdf": types.SimpleNamespace(open=lambda path: docs[Path(path)])}):
                mapping = make_mapping(src, dst, before, middle, after)
                self.assertEqual(mapping["segments"][0]["status"], "aligned")
                self.assertEqual(mapping["segments"][0]["source"][0]["quads"][0],
                                 [0.1, 0.1, 0.5, 0.1, 0.5, 0.2, 0.1, 0.2])
                self.assertNotIn("attachmentKey", mapping["source"])
                # BabelDOC writes temporary debug labels at matching offsets
                # across snapshots. They must not become hoverable segments.
                debug = {"unicode": "plain text", "debug_id": None}
                debug_rendered = {"unicode": "plain text", "debug_id": None,
                    "pdf_paragraph_composition": [{"pdf_character": {"debug_info": True}}]}
                for filename, paragraph in (("before.json", debug),
                                            ("middle.json", debug),
                                            ("after.json", debug_rendered)):
                    path = folder / filename
                    contents = json.loads(path.read_text(encoding="utf-8"))
                    contents["page"][0]["pdf_paragraph"].insert(0, paragraph)
                    path.write_text(json.dumps(contents), encoding="utf-8")
                clean = make_mapping(src, dst, before, middle, after)
                self.assertEqual(len(clean["segments"]), 1)
                self.assertEqual(clean["segments"][0]["status"], "aligned")
                before = stage("before.json", "Original paragraph")
                middle = stage("middle.json", "Translated paragraph")
                after = stage("after.json", "Translated paragraph")
                # A changed IL identity may not be highlighted even if the text is found.
                stage("after.json", "Translated paragraph", paragraph_id="different")
                unsafe = make_mapping(src, dst, before, middle, after)
                self.assertEqual(unsafe["segments"][0]["status"], "uncertain")
                self.assertEqual(unsafe["segments"][0]["target"], [])
                # Matching page order without a stable IL identity is not enough.
                stage("before.json", "Original paragraph", paragraph_id=None)
                stage("middle.json", "Translated paragraph", paragraph_id=None)
                stage("after.json", "Translated paragraph", paragraph_id=None)
                no_ids = make_mapping(src, dst, before, middle, after)
                self.assertEqual(no_ids["segments"][0]["status"], "uncertain")
                stage("before.json", "Original paragraph")
                stage("middle.json", "Translated paragraph")
                # Text not actually present in the target PDF must never get a quad.
                stage("after.json", "Translated paragraph")
                stage("middle.json", "Hallucinated paragraph")
                missing = make_mapping(src, dst, before, middle, after)
                self.assertEqual(missing["segments"][0]["status"], "uncertain")

    def test_cjk_paragraph_wraps_have_unique_line_quads(self):
        first = "河流缓缓流淌。水很清澈。"
        second = "今天海风轻柔，远处能看到山。"
        def block():
            lines = []
            for y, text in ((10, first), (30, second)):
                chars = [{"c": ch, "bbox": (10 + x * 2, y, 12 + x * 2, y + 10)}
                         for x, ch in enumerate(text)]
                lines.append({"dir": (1, 0), "spans": [{"chars": chars}]})
            return {"type": 0, "lines": lines}
        class WrappedPage(Page):
            def __init__(self, blocks): self.blocks = blocks
            def search_for(self, text, quads): return []
            def get_text(self, kind):
                self.assert_kind = kind
                return {"blocks": self.blocks}
        def quad(_direction, _span, chars):
            left, top = chars[0]["bbox"][:2]
            right, bottom = chars[-1]["bbox"][2:]
            return types.SimpleNamespace(
                ul=Point(left, top), ur=Point(right, top),
                lr=Point(right, bottom), ll=Point(left, bottom))
        pdf = types.SimpleNamespace(recover_span_quad=quad)
        with patch.dict(sys.modules, {"pymupdf": pdf}):
            refs = _refs(WrappedPage([block()]), first + second, 1)
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0]["pageIndex"], 1)
            self.assertEqual(len(refs[0]["quads"]), 2)
            self.assertAlmostEqual(refs[0]["quads"][0][1], 0.1)
            self.assertAlmostEqual(refs[0]["quads"][1][1], 0.3)
            self.assertEqual(_refs(WrappedPage([block(), block()]), first + second, 1), [])
            self.assertEqual(_refs(WrappedPage([block()]), first + second + "新", 1), [])

    def test_worker_calls_pinned_api_and_cleans_intermediate_files(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            source = job / "source.pdf"
            import pymupdf
            with pymupdf.open() as document:
                document.new_page().insert_text((50, 60), "Original paragraph for worker tests")
                document.save(source)
            work = job / "job"
            work.mkdir()
            class Layout:
                @classmethod
                def load_onnx(cls): return cls()
            class Config:
                def __init__(self, **kwargs):
                    self.__dict__.update(kwargs)
                    self.report_interval = 0.1
            provider_failure = None
            class Translator:
                def __init__(self, *args, **kwargs):
                    self.api_key = kwargs["api_key"]
                    self.ignore_cache = kwargs["ignore_cache"]
                    self.client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=lambda **kwargs: None)))
                def translate(self, _text):
                    if provider_failure is not None: raise provider_failure
                    return "Translated paragraph"
            class Monitor:
                def __init__(self, stages, progress_change_callback, report_interval, cancel_event=None, finish_callback=None):
                    self.progress_change_callback = progress_change_callback
                def __enter__(self): return self
                def __exit__(self, *_): pass
            def translate(pm, config):
                self.assertEqual(config.translator.api_key, "private-key")
                self.assertTrue(config.translator.ignore_cache)
                self.assertEqual(config.debug, True)
                self.assertEqual(config.no_dual, True)
                self.assertEqual(config.qps, payload.get("qps", 2))
                self.assertEqual(config.pool_max_workers, payload.get("concurrency", 4))
                try: config.translator.translate("Private source text")
                except Exception: pass  # BabelDOC may swallow provider failures.
                pdf = config.output_dir / "generated.pdf"
                with pymupdf.open() as document:
                    document.new_page().insert_text((50, 60), "Translated paragraph for worker tests")
                    document.save(pdf)
                pm.progress_change_callback(type="progress_update", stage="translate", stage_current=1, stage_total=1, overall_progress=40)
                return types.SimpleNamespace(mono_pdf_path=pdf)
            modules = {
                "babeldoc": types.ModuleType("babeldoc"),
                "babeldoc.docvision": types.ModuleType("babeldoc.docvision"),
                "babeldoc.docvision.base_doclayout": types.SimpleNamespace(DocLayoutModel=Layout),
                "babeldoc.format": types.ModuleType("babeldoc.format"),
                "babeldoc.format.pdf": types.ModuleType("babeldoc.format.pdf"),
                "babeldoc.format.pdf.high_level": types.SimpleNamespace(do_translate=translate, get_translation_stage=lambda config: []),
                "babeldoc.progress_monitor": types.SimpleNamespace(ProgressMonitor=Monitor),
                "babeldoc.format.pdf.translation_config": types.SimpleNamespace(
                    TranslationConfig=Config, WatermarkOutputMode=types.SimpleNamespace(NoWatermark=0)),
                "babeldoc.format.pdf.document_il": types.ModuleType("babeldoc.format.pdf.document_il"),
                "babeldoc.format.pdf.document_il.midend": types.ModuleType("babeldoc.format.pdf.document_il.midend"),
                "babeldoc.format.pdf.document_il.midend.il_translator_llm_only": types.SimpleNamespace(ILTranslatorLLMOnly=type("ILTranslatorLLMOnly", (), {"translate":lambda self,docs:None})),
                "babeldoc.format.pdf.document_il.backend": types.ModuleType("babeldoc.format.pdf.document_il.backend"),
                "babeldoc.format.pdf.document_il.backend.pdf_creater": types.SimpleNamespace(PDFCreater=type("PDFCreater", (), {"write": lambda self, config: None})),
                "babeldoc.format.pdf.document_il.midend.add_debug_information": types.SimpleNamespace(AddDebugInformation=type("AddDebugInformation", (), {"process": lambda self, docs: None})),
                "babeldoc.translator": types.ModuleType("babeldoc.translator"),
                "babeldoc.translator.translator": types.SimpleNamespace(OpenAITranslator=Translator, set_translate_rate_limiter=lambda qps: self.assertEqual(qps, max(5, payload.get("qps", 2)))),
            }
            payload = {"apiKey": "private-key", "sourceLanguage": "en",
                       "targetLanguage": "zh", "model": "model", "baseURL": "https://example.org/v1"}
            with patch.dict(sys.modules, modules), patch.object(worker, "make_mapping", return_value={"schemaVersion": 1}) as mapping:
                progress_updates = []
                original_atomic = worker.atomic_json
                def record_progress(path, value):
                    if Path(path).name == "progress.json": progress_updates.append(value)
                    original_atomic(path, value)
                def mapped(*args, on_progress):
                    for completed in (0, 1, 2): on_progress(completed, 2)
                    return {"schemaVersion": 1}
                mapping.side_effect = mapped
                with patch.object(worker, "atomic_json", side_effect=record_progress):
                    asyncio.run(worker.run(payload, source, work))
                self.assertEqual([entry["percent"] for entry in progress_updates], [0, 36, 90, 93, 96, 97])
                mapping.side_effect = None
                unavailable = Path(folder) / "unavailable"
                unavailable.mkdir()
                mapping.side_effect = MappingUnavailableError("private-key / PDF text")
                diagnostics = {}
                asyncio.run(worker.run(payload, source, unavailable, diagnostics))
                fallback = json.loads((unavailable / "mapping.v1.json").read_text())
                self.assertEqual(fallback["segments"][0]["status"], "failed")
                self.assertEqual(fallback["segments"][0]["source"], [])
                self.assertTrue((unavailable / "translated.pdf").exists())
                self.assertTrue((unavailable / "result.json").exists())
                self.assertEqual(diagnostics["stage"], "publish")
                self.assertNotIn("private-key", (unavailable / "mapping-warning.json").read_text())
                for index, error in enumerate((PermissionError("private"), MemoryError("private"))):
                    fatal = Path(folder) / f"fatal-{index}"
                    fatal.mkdir()
                    mapping.side_effect = error
                    with self.assertRaises(type(error)):
                        asyncio.run(worker.run(payload, source, fatal))
                    self.assertFalse((fatal / "result.json").exists())
                cancelled = Path(folder) / "cancelled"
                cancelled.mkdir()
                def cancel_during_mapping(*args, on_progress):
                    (cancelled / "cancel").write_text("")
                    on_progress(1, 2)
                mapping.side_effect = cancel_during_mapping
                with self.assertRaisesRegex(RuntimeError, "cancelled"):
                    asyncio.run(worker.run(payload, source, cancelled))
                self.assertFalse((cancelled / "result.json").exists())
                mapping.side_effect = None
                provider_failed = Path(folder) / "provider-failed"
                provider_failed.mkdir()
                APIConnectionError = type("APIConnectionError", (Exception,), {})
                provider_failure = APIConnectionError("private-key / private source text")
                with self.assertRaises(worker.ProviderJobError) as caught:
                    asyncio.run(worker.run(payload, source, provider_failed))
                self.assertEqual(worker.safe_job_error(caught.exception, "mapping")["code"], "api_connection")
                self.assertFalse((provider_failed / "result.json").exists())
                self.assertFalse((provider_failed / "translated.pdf").exists())
                provider_failure = None
                high = Path(folder) / "high-qps"
                high.mkdir()
                payload.update(concurrency=8, qps=10)
                try:
                    asyncio.run(worker.run(payload, source, high))
                    self.assertTrue((high / "result.json").exists())
                finally:
                    payload.pop("concurrency")
                    payload.pop("qps")
                # Windows may hold the intermediate PDFs open even after a
                # successful translation; the result should remain usable.
                blocked = Path(folder) / "blocked"
                blocked.mkdir()
                failed = Path(folder) / "failed"
                failed.mkdir()
                original_rmtree = worker.shutil.rmtree
                def locked(path, *args, **kwargs):
                    if Path(path).parent in (blocked, failed):
                        raise PermissionError("PDF handle is open")
                    return original_rmtree(path, *args, **kwargs)
                async def no_wait(_delay): pass
                with patch.object(worker.shutil, "rmtree", side_effect=locked), \
                     patch.object(worker.asyncio, "sleep", side_effect=no_wait):
                    asyncio.run(worker.run(payload, source, blocked))
                    self.assertTrue((blocked / "result.json").exists())
                    self.assertTrue((blocked / "cleanup-warning.json").exists())
                    self.assertNotIn("private-key", (blocked / "cleanup-warning.json").read_text())
                    mapping.side_effect = ValueError("original translation failure")
                    with self.assertRaisesRegex(ValueError, "original translation failure"):
                        asyncio.run(worker.run(payload, source, failed))
                    self.assertFalse((failed / "result.json").exists())
                    self.assertTrue((failed / "cleanup-warning.json").exists())
            self.assertTrue((work / "translated.pdf").exists())
            self.assertEqual(json.loads((work / "mapping.v1.json").read_text()), {"schemaVersion": 1})
            self.assertFalse(any(p.name.startswith("babeldoc-") or p.name.startswith("output-") for p in work.iterdir()))
            self.assertNotIn("private-key", (work / "progress.json").read_text())
    def test_worker_honors_cancel_before_importing_babeldoc(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            (job / "cancel").write_text("", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Translation cancelled"):
                asyncio.run(worker.run({}, job / "source.pdf", job))

    def test_config_file_removed_before_network_or_import(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder / "file.pdf"
            source.write_bytes(b"%PDF-fixture")
            job = folder / "job"
            job.mkdir()
            config = job / "config"
            config.write_text(json.dumps({
                "sourcePath": str(source), "jobDirectory": str(job),
                "apiKey": "secret", "baseURL": "https://api.example/v1",
                "model": "model", "sourceLanguage": "en", "targetLanguage": "zh",
            }), encoding="utf-8")
            data, _, _ = load_config(config)
            self.assertEqual(data["apiKey"], "secret")
            self.assertFalse(config.exists())


if __name__ == "__main__": unittest.main()