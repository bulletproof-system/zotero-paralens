"""Bounded repair regressions: synthetic paragraphs, local/mock API only."""
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
CHINESE = "实验分析测量结果，并与已有研究进行比较。"


def response(content):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(
        message=types.SimpleNamespace(content=content), finish_reason="stop")])


def paragraphs(count=1):
    values = [types.SimpleNamespace(unicode=PROSE, visible=PROSE) for _ in range(count)]
    page = types.SimpleNamespace(pdf_paragraph=values, pdf_font=[], pdf_xobject=[])
    return values, types.SimpleNamespace(page=[page]), {id(p): PROSE for p in values}


def engine(translate, post=None):
    def apply(paragraph, tracker, prepared, result):
        paragraph.unicode = result
        paragraph.visible = result
    return types.SimpleNamespace(
        translation_config=types.SimpleNamespace(lang_in="en", lang_out="zh"),
        il_translator=types.SimpleNamespace(
            pre_translate_paragraph=lambda p, *args: (p.unicode, object()),
            generate_prompt_for_llm=lambda text, *args: text,
            post_translate_paragraph=post or apply),
        translate_engine=types.SimpleNamespace(llm_translate=translate))


class RepairTests(unittest.TestCase):
    def test_english_echo_retries_once_with_stronger_prompt_then_commits(self):
        values, docs, sources = paragraphs()
        calls = []
        def translate(prompt, **kwargs):
            calls.append(prompt)
            return PROSE if len(calls) == 1 else CHINESE
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            stats = worker.repair_untranslated(engine(translate), docs, Path(folder), threading.Event(), sources)
            self.assertEqual(stats["attempts"], 2)
            self.assertEqual(stats["repaired"], 1)
            self.assertEqual(stats["remaining"], 0)
            self.assertEqual(values[0].visible, CHINESE)
            self.assertIn("Simplified Chinese", calls[0])
            self.assertIn("previous repair was incomplete", calls[1])
            self.assertNotIn(PROSE, (Path(folder) / "translation-quality.json").read_text())

    def test_rejected_parse_does_not_overwrite_the_previous_usable_paragraph(self):
        values, docs, sources = paragraphs()
        values[0].unicode = values[0].visible = "已译部分。" + PROSE
        before = copy.deepcopy(values[0].__dict__)
        calls = []
        def translate(*args, **kwargs):
            calls.append(1)
            return CHINESE
        def broken_post(p, tracker, prepared, result):
            p.unicode = p.visible = "错误补译。" + PROSE
            p.extra_mutation = True
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            with self.assertRaises(worker.IncompleteTranslationError) as caught:
                worker.repair_untranslated(engine(translate, broken_post), docs, Path(folder), threading.Event(), sources)
            self.assertEqual(values[0].__dict__, before)
            self.assertEqual(len(calls), 2)
            status = worker.safe_job_error(caught.exception, "translation")
            self.assertEqual(status["code"], "translation_untranslated")
            self.assertEqual(status["quality"]["incomplete_compositions"], 1)

    def test_progress_advances_and_counts_completed_paragraphs(self):
        values, docs, sources = paragraphs(3)
        updates = []
        original = worker.atomic_json
        def write(path, value):
            if path.name == "progress.json": updates.append(value)
            original(path, value)
        with tempfile.TemporaryDirectory() as folder, patch.object(worker, "atomic_json", side_effect=write), patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            stats = worker.repair_untranslated(engine(lambda *args, **kwargs: CHINESE), docs, Path(folder), threading.Event(), sources)
            self.assertEqual(stats["repaired"], 3)
            self.assertEqual(updates[0]["percent"], 77)
            self.assertEqual(updates[-1]["percent"], 85)
            self.assertEqual(updates[-1]["completed"], 3)
            self.assertTrue(all(b["percent"] >= a["percent"] for a, b in zip(updates, updates[1:])))
            self.assertIn("第 2/3 段", updates[2]["stage"])

    def test_cancellation_after_reply_does_not_commit_or_start_the_next_request(self):
        values, docs, sources = paragraphs(2)
        cancellation = threading.Event()
        calls = []
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            job = Path(folder)
            def translate(*args, **kwargs):
                calls.append(1)
                (job / "cancel").touch()
                cancellation.set()
                return CHINESE
            with self.assertRaises(asyncio.CancelledError):
                worker.repair_untranslated(engine(translate), docs, job, cancellation, sources)
            self.assertEqual(len(calls), 1)
            self.assertEqual(values[0].visible, PROSE)
            self.assertEqual(json.loads((job / "translation-quality.json").read_text())["remaining"], 2)

    def test_empty_repair_has_two_actual_requests_not_nested_retry_loops(self):
        values, docs, sources = paragraphs()
        calls = []
        def create(**options):
            calls.append(options)
            return response(None)
        translator = types.SimpleNamespace(client=types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        worker.guard_api_response(translator, threading.Event())
        def translate(prompt, **kwargs):
            return translator.client.chat.completions.create(messages=[{"role": "user", "content": prompt}]).choices[0].message.content
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            with self.assertRaises(worker.IncompleteTranslationError) as caught:
                worker.repair_untranslated(engine(translate), docs, Path(folder), threading.Event(), sources)
            self.assertEqual(caught.exception.quality["response_incomplete"], 1)
        self.assertEqual(len(calls), 2)
        self.assertEqual([c["max_tokens"] for c in calls], [8192, 16384])
        self.assertTrue(all(c["timeout"] == worker.REPAIR_TIMEOUT_SECONDS for c in calls))
        self.assertIsNone(getattr(worker._repair_request, "attempt", None))

    def test_real_sdk_repair_rate_limit_and_server_errors_do_not_retry(self):
        import httpx
        import openai
        from babeldoc.translator.translator import OpenAITranslator
        # Invoke the pinned 100-attempt decorated method, but all HTTP goes
        # through MockTransport. No real endpoint, key, model or disk cache.
        for status in (429, 500):
            with self.subTest(status=status):
                calls = []
                def handle(request):
                    calls.append(request)
                    return httpx.Response(status, json={"error": {"message": "PRIVATE_MESSAGE", "type": "synthetic"}})
                with httpx.Client(transport=httpx.MockTransport(handle)) as http:
                    client = openai.OpenAI(api_key="synthetic", base_url="https://example.invalid/v1", http_client=http)
                    translator = types.SimpleNamespace(
                        client=client, send_temperature=False, enable_json_mode_if_requested=False,
                        send_dashscope_header=False, extra_body={}, model="test-only")
                    worker.guard_api_response(translator, threading.Event(), {"concurrency": 1, "qps": 10})
                    expected = worker.ProviderJobError if status == 429 else openai.InternalServerError
                    with worker.repair_api_scope(0), self.assertRaises(expected) as caught:
                        OpenAITranslator.do_llm_translate(translator, "Synthetic prompt", rate_limit_params={})
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0].extensions["timeout"]["read"], 60)
                    self.assertEqual(client.max_retries, 0)
                    if status == 429:
                        self.assertEqual(worker.safe_job_error(caught.exception, "translation")["code"], "api_rate_limit")
                        self.assertNotIn("PRIVATE", str(caught.exception))

    def test_recovered_empty_reply_does_not_leave_a_stale_partial_warning(self):
        values, docs, sources = paragraphs()
        calls = []
        def create(**options):
            calls.append(options)
            return response(None if len(calls) == 1 else CHINESE)
        translator = types.SimpleNamespace(client=types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        translator.llm_translate = lambda prompt, **kwargs: translator.client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}]).choices[0].message.content
        cancellation = threading.Event()
        with tempfile.TemporaryDirectory() as folder, patch(
                "babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode",
                side_effect=lambda p: p.visible):
            job = Path(folder)
            worker.guard_api_response(translator, cancellation)
            state = worker.guard_translator(translator, job, cancellation)
            stats = worker.repair_untranslated(engine(translator.llm_translate), docs, job, cancellation, sources)
            self.assertEqual(stats["repaired"], 1)
            self.assertEqual(len(calls), 2)
            self.assertEqual(state["failed"], 0)
            self.assertIsNone(state["error"])
            self.assertEqual(state["successful"], 1)

    def test_repair_scope_is_thread_local_and_restored_on_failure(self):
        calls = []
        def create(**options):
            calls.append(options)
            return response(CHINESE)
        translator = types.SimpleNamespace(client=types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        worker.guard_api_response(translator, threading.Event())
        def call(): translator.client.chat.completions.create(max_tokens=2048)
        with self.assertRaises(RuntimeError):
            with worker.repair_api_scope(1):
                thread = threading.Thread(target=call)
                thread.start()
                thread.join()
                call()
                raise RuntimeError("synthetic")
        call()
        self.assertEqual([c["max_tokens"] for c in calls], [8192, 16384, 8192])
        self.assertNotIn("timeout", calls[0])
        self.assertEqual(calls[1]["timeout"], 60)
        self.assertNotIn("timeout", calls[2])


if __name__ == "__main__": unittest.main()
