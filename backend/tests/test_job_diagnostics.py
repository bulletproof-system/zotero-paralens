"""Progress and diagnostic regressions with synthetic HTTP and document metadata."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

import httpx
import openai

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class JobDiagnosticsTests(unittest.TestCase):
    def test_persisted_progress_is_monotonic_and_counters_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            values = []
            for percent in (75, 80, 77, float("nan"), 90, 120):
                worker.atomic_json(path, {"stage": "Typesetting", "percent": percent,
                                          "completed": 12, "total": 8})
                value = json.loads(path.read_text(encoding="utf-8"))
                values.append(value["percent"])
                self.assertEqual(value["completed"], 8)
            self.assertEqual(values, [75, 80, 80, 80, 90, 97])
            worker.atomic_json(path, {"stage": "Save PDF", "percent": 90,
                                      "completed": -1, "total": True})
            value = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn("completed", value)
            self.assertNotIn("total", value)
            self.assertEqual(value["percent"], 97)

    def test_stage_allocation_reserves_quality_progress_before_typesetting(self):
        event = {"stage": "Translate Paragraphs", "stage_current": 1, "stage_total": 1}
        values = [worker.translation_progress(dict(event, overall_progress=n), 80)["percent"]
                  for n in (0, 40, 80, 90, 100)]
        self.assertEqual(values, [0, 37.5, 75, 85, 90])

    def test_real_sdk_retry_and_empty_response_statistics_exclude_private_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            diagnostics = {"_job": Path(directory), "_started": time.monotonic(), "stage": "translation"}
            calls = []
            def handle(request):
                calls.append(request)
                if len(calls) == 1:
                    return httpx.Response(503, json={"error": {"message": "PRIVATE_ERROR", "type": "synthetic"}})
                return httpx.Response(200, json={"id": "PRIVATE_ID", "object": "chat.completion",
                    "created": 0, "model": "synthetic", "choices": [{"index": 0, "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "" if len(calls) == 2 else "PRIVATE_RESPONSE"}}],
                    "usage": {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10}})
            with openai.OpenAI(api_key="PRIVATE_API_KEY", base_url="https://synthetic.invalid/v1",
                http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
                worker.guard_api_response(types.SimpleNamespace(client=client), threading.Event(),
                                          {"concurrency": 2, "qps": 10}, diagnostics)
                response = client.chat.completions.create(model="synthetic",
                    messages=[{"role": "user", "content": "PRIVATE_DOCUMENT"}])
                self.assertEqual(response.choices[0].message.content, "PRIVATE_RESPONSE")
            worker.write_job_diagnostics(directory, diagnostics, final=True)
            text = (Path(directory) / "diagnostics.json").read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE", text)
            metrics = json.loads(text)["api"]
            self.assertEqual(metrics["requests"], 3)
            self.assertEqual(metrics["successful"], 2)
            self.assertEqual(metrics["failed"], 1)
            self.assertEqual(metrics["retries"], 2)
            self.assertEqual(metrics["emptyResponses"], 1)
            self.assertEqual(metrics["activeRequests"], 0)
            self.assertEqual(metrics["totalTokens"], 20)
            self.assertEqual(metrics["httpStatuses"], {"503": 1, "200": 2})

    def test_failure_summary_is_written_without_config_or_exception_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            async def fail(data, source, job, diagnostics):
                worker.diagnostic_stage(diagnostics, "translation")
                diagnostics["operation"] = "pdf_save"
                diagnostics["pdfSave"] = {"failed": 1, "maxPathLength": 360, "path": "PRIVATE_PATH"}
                diagnostics["api"] = {"requests": 1, "apiKey": "PRIVATE_KEY", "response": "PRIVATE_TEXT",
                                      "httpStatuses": {"401": 1, "PRIVATE_KEY": 1}}
                diagnostics["input"] = {"pages": 8, "encrypted": False, "filename": "PRIVATE_FILE"}
                diagnostics["apiKey"] = "PRIVATE_KEY"
                raise RuntimeError("PRIVATE_MESSAGE")
            with patch.object(worker, "_run", side_effect=fail):
                with self.assertRaises(RuntimeError):
                    asyncio.run(worker.run({"apiKey": "PRIVATE_KEY"}, job / "PRIVATE_DOCUMENT.pdf", job))
            text = (job / "diagnostics.json").read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE", text)
            value = json.loads(text)
            self.assertEqual(value["operation"], "pdf_save")
            self.assertEqual(value["pdfSave"]["maxPathLength"], 360)
            self.assertIn("pymupdf", value["runtime"])

    def test_http_and_mupdf_exception_codes_are_numeric_only(self):
        for name in ("FzErrorSystem", "AuthenticationError"):
            error = type(name, (Exception,), {})("PRIVATE_RESPONSE")
            error.status_code = 401
            error.code = 2
            error.apiKey = "PRIVATE_KEY"
            status = worker.safe_exception_diagnostics(error)
            self.assertEqual(status["exceptionType"], name)
            self.assertEqual(status["exceptionChain"][0]["status_code"], 401)
            self.assertEqual(status["exceptionChain"][0]["code"], 2)
            self.assertNotIn("PRIVATE", json.dumps(status))


if __name__ == "__main__":
    unittest.main()
