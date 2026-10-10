"""Partial worker results: synthetic PDFs and mocked providers, never network."""
import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class PartialWorkerTests(unittest.TestCase):
    def run_scenario(self, scenario):
        import pymupdf
        # Fresh classes for every job: the pinned worker hooks class methods.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            job = root / "job"
            job.mkdir()
            with pymupdf.open() as pdf:
                pdf.new_page().insert_text((50, 60), "Synthetic original paragraph")
                pdf.save(source)
            calls = []
            APIError = type("AuthenticationError", (Exception,), {})

            class Layout:
                @classmethod
                def load_onnx(cls): return cls()

            class Config:
                def __init__(self, **kwargs):
                    self.__dict__.update(kwargs)
                    self.report_interval = 0.1
                def cancel_translation(self): pass

            class Translator:
                def __init__(self, *args, **kwargs):
                    self.client = types.SimpleNamespace(chat=types.SimpleNamespace(
                        completions=types.SimpleNamespace(create=lambda **kwargs: None)))
                def translate(self, text):
                    calls.append(text)
                    if text == "fail":
                        raise APIError("PRIVATE_KEY PRIVATE_DOCUMENT")
                    return "Synthetic translated paragraph"

            class Monitor:
                def __init__(self, stages, **kwargs):
                    self.__dict__.update(kwargs)
                def __enter__(self): return self
                def __exit__(self, *_): pass

            class Engine:
                def translate(self, docs):
                    if scenario != "all_failed":
                        self.translator.translate("first")
                    if scenario in ("initial_api", "all_failed"):
                        try:
                            self.translator.translate("fail")
                        except APIError:
                            # Pinned BabelDOC can propagate cancel after auth errors.
                            raise asyncio.CancelledError() from None

            def repair(engine, docs, active_job, cancel, sources):
                if scenario == "quality":
                    raise worker.IncompleteTranslationError("PRIVATE_DOCUMENT", quality={
                        "pending": 2, "repaired": 0, "remaining": 2, "no_chinese_reply": 2})
                if scenario == "repair_api":
                    engine.translator.translate("fail")
                if scenario == "cancel":
                    (active_job / "cancel").touch()
                    cancel.set()
                    raise asyncio.CancelledError()
                if scenario == "internal":
                    raise ValueError("PRIVATE_DOCUMENT")
                return {}

            def translate(monitor, config):
                engine = Engine()
                engine.translator = config.translator
                engine.translate(types.SimpleNamespace(page=[]))
                # Clearing provider cancellation allows rendering, not new calls.
                self.assertFalse(monitor.cancel_event.is_set())
                output = config.output_dir / "generated.pdf"
                with pymupdf.open() as pdf:
                    pdf.new_page().insert_text((50, 60), "Synthetic retained translation")
                    pdf.save(output)
                monitor.progress_change_callback(type="progress_update", overall_progress=90)
                return types.SimpleNamespace(mono_pdf_path=output)

            modules = {
                "babeldoc.docvision.base_doclayout": types.SimpleNamespace(DocLayoutModel=Layout),
                "babeldoc.format.pdf.high_level": types.SimpleNamespace(
                    do_translate=translate, get_translation_stage=lambda config: []),
                "babeldoc.progress_monitor": types.SimpleNamespace(ProgressMonitor=Monitor),
                "babeldoc.format.pdf.translation_config": types.SimpleNamespace(
                    TranslationConfig=Config, WatermarkOutputMode=types.SimpleNamespace(NoWatermark=0)),
                "babeldoc.translator.translator": types.SimpleNamespace(
                    OpenAITranslator=Translator, set_translate_rate_limiter=lambda qps: None),
                "babeldoc.format.pdf.document_il.midend.add_debug_information": types.SimpleNamespace(
                    AddDebugInformation=type("Debug", (), {"process": lambda self, docs: None})),
                "babeldoc.format.pdf.document_il.backend.pdf_creater": types.SimpleNamespace(
                    PDFCreater=type("Creator", (), {"write": lambda self, config: None})),
                "babeldoc.format.pdf.document_il.midend.il_translator_llm_only": types.SimpleNamespace(
                    ILTranslatorLLMOnly=Engine),
            }
            data = {"apiKey": "PRIVATE_KEY", "baseURL": "https://example.invalid/v1",
                    "model": "test-only", "sourceLanguage": "en", "targetLanguage": "zh"}
            with patch.dict(sys.modules, modules), \
                 patch.object(worker, "repair_untranslated", side_effect=repair), \
                 patch.object(worker, "make_mapping", side_effect=worker.MappingUnavailableError("PRIVATE_DOCUMENT")):
                if scenario in ("cancel", "internal", "all_failed"):
                    expected = {"cancel": asyncio.CancelledError, "internal": ValueError,
                                "all_failed": worker.ProviderJobError}[scenario]
                    with self.assertRaises(expected):
                        asyncio.run(worker.run(data, source, job))
                    self.assertFalse((job / "result.json").exists())
                else:
                    asyncio.run(worker.run(data, source, job))
                    result = json.loads((job / "result.json").read_text())
                    with pymupdf.open(job / "translated.pdf") as pdf:
                        self.assertEqual(len(pdf), 1)
                    if scenario == "success":
                        self.assertNotIn("completion", result)
                        self.assertFalse((job / "artifact-retention.json").exists())
                    else:
                        self.assertEqual(result["completion"], "partial")
                        code = "translation_untranslated" if scenario == "quality" else "api_auth"
                        self.assertEqual(result["warning"]["code"], code)
                        self.assertNotIn("PRIVATE", json.dumps(result))
                        self.assertTrue((job / "partial-warning.json").exists())
                retained = scenario != "success"
                self.assertEqual((job / "artifact-retention.json").exists(), retained)
                self.assertEqual(any(p.name.startswith("output-") for p in job.iterdir()), retained)
                self.assertEqual(any(p.name.startswith("babeldoc-") for p in job.iterdir()), retained)
                self.assertEqual(calls, ["fail"] if scenario == "all_failed" else
                                 ["first", "fail"] if scenario in ("initial_api", "repair_api") else ["first"])

    def test_partial_quality_and_provider_failures_still_render_pdf(self):
        for scenario in ("quality", "initial_api", "repair_api", "success"):
            with self.subTest(scenario=scenario): self.run_scenario(scenario)

    def test_cancel_internal_error_and_total_api_failure_are_not_published(self):
        for scenario in ("cancel", "internal", "all_failed"):
            with self.subTest(scenario=scenario): self.run_scenario(scenario)


if __name__ == "__main__": unittest.main()
