"""Default check-only quality mode uses synthetic text and never invokes an API."""
import asyncio
import copy
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker

PROSE = "The experiment analyzes the measured results and compares the values with previous reports from other researchers."


class CheckOnlyTests(unittest.TestCase):
    def check(self, visible, expected_remaining):
        paragraph = types.SimpleNamespace(unicode=visible, visible=visible)
        before = copy.deepcopy(paragraph.__dict__)
        docs = types.SimpleNamespace(page=[types.SimpleNamespace(pdf_paragraph=[paragraph])])
        engine = types.SimpleNamespace(
            translation_config=types.SimpleNamespace(lang_in="en", lang_out="zh"),
            translate_engine=types.SimpleNamespace(llm_translate=lambda *a, **k: self.fail("Check-only must not invoke an API")),
            il_translator=types.SimpleNamespace(pre_translate_paragraph=lambda *a, **k: self.fail("Check-only must not prepare repairs")))
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            job = Path(folder)
            if expected_remaining:
                with self.assertRaises(worker.IncompleteTranslationError) as caught:
                    worker.check_untranslated(engine, docs, job, threading.Event(), {id(paragraph): {"text": PROSE}})
                self.assertEqual(worker.safe_job_error(caught.exception, "translation")["code"], "translation_untranslated")
            else:
                worker.check_untranslated(engine, docs, job, threading.Event(), {id(paragraph): {"text": PROSE}})
            stats = json.loads((job / "translation-quality.json").read_text(encoding="utf-8"))
            self.assertEqual(stats["remaining"], expected_remaining)
            self.assertEqual(stats["attempts"], 0)
            self.assertFalse(stats["autoRepair"])
            self.assertEqual(paragraph.__dict__, before)
            self.assertNotIn(PROSE, (job / "translation-quality.json").read_text(encoding="utf-8"))
            progress = json.loads((job / "progress.json").read_text(encoding="utf-8"))
            self.assertNotIn("补译未翻译的正文段落", progress["stage"])

    def test_untranslated_prose_is_only_reported_without_extra_requests(self):
        self.check(PROSE, 1)

    def test_missing_translation_is_reported_without_extra_requests(self):
        self.check("", 1)

    def test_translated_paragraph_does_not_become_a_false_failure(self):
        self.check("实验分析测量结果，并与已有研究进行比较。", 0)

    def test_cancel_does_not_start_a_check(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            (job / "cancel").touch()
            with self.assertRaises(asyncio.CancelledError):
                worker.check_untranslated(None, None, job, threading.Event(), {})
            self.assertFalse((job / "translation-quality.json").exists())

    def test_no_check_is_attempted_for_other_language_directions(self):
        engine = types.SimpleNamespace(translation_config=types.SimpleNamespace(lang_in="zh", lang_out="en"))
        with tempfile.TemporaryDirectory() as folder, patch.object(worker, "untranslated_paragraphs", side_effect=AssertionError("Unexpected scan")):
            stats = worker.check_untranslated(engine, None, Path(folder), threading.Event(), {})
            self.assertEqual(stats["remaining"], 0)


if __name__ == "__main__": unittest.main()
