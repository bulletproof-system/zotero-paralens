"""OpenCode protocol regressions; all HTTP uses MockTransport and synthetic keys."""
import json
import sys
import threading
import types
import unittest
from pathlib import Path

import httpx
import openai

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


class OpenCodeHeaderTests(unittest.TestCase):
    def client(self, base, http):
        return types.SimpleNamespace(client=openai.OpenAI(
            api_key="synthetic-opencode-key", base_url=base, http_client=http,
            default_headers={"X-Test-Preserved": "yes"},
        ), send_temperature=False, enable_json_mode_if_requested=False,
            send_dashscope_header=False, extra_body={}, model="glm-5.3-flash",
            update_token_count=lambda _response: None)

    def response(self):
        return httpx.Response(200, json={
            "id": "synthetic", "object": "chat.completion", "created": 0,
            "model": "glm-5.3-flash", "choices": [{"index": 0,
                "finish_reason": "stop", "message": {"role": "assistant", "content": "合成译文"}}],
        })

    def test_zen_and_go_send_required_headers_on_body_retry_and_repair_requests(self):
        from babeldoc.translator.translator import OpenAITranslator
        for base in ("https://opencode.ai/zen/v1", "https://opencode.ai/zen/go/v1/"):
            with self.subTest(base=base):
                requests = []
                def handle(request):
                    requests.append(request)
                    if not request.headers.get("x-opencode-session"):
                        return httpx.Response(400, json={"error": {"type": "MissingSessionID", "message": "missing"}})
                    if len(requests) == 1:
                        return httpx.Response(503, json={"error": {"type": "synthetic", "message": "retry"}})
                    return self.response()
                with httpx.Client(transport=httpx.MockTransport(handle)) as http:
                    translator = self.client(base, http)
                    self.assertTrue(worker.configure_provider_client(translator, {
                        "baseURL": base, "pluginVersion": "0.1.9", "apiKey": "PRIVATE_CONFIG_KEY",
                        "sourcePath": "PRIVATE_DOCUMENT_PATH",
                    }))
                    worker.guard_api_response(translator, threading.Event(), {"concurrency": 1, "qps": 10})
                    # Use the pinned BabelDOC method, including its extra_headers={}.
                    self.assertEqual(OpenAITranslator.do_llm_translate(translator, "Synthetic body", rate_limit_params={}), "合成译文")
                    with worker.repair_api_scope(0):
                        self.assertEqual(OpenAITranslator.do_llm_translate(translator, "Synthetic repair", rate_limit_params={}), "合成译文")
                    self.assertEqual(len(requests), 3)
                    sessions = {request.headers["x-opencode-session"] for request in requests}
                    self.assertEqual(len(sessions), 1)
                    session = sessions.pop()
                    self.assertRegex(session, r"^ses_[0-9a-f]{64}$")
                    for request in requests:
                        self.assertEqual(request.url.path, base.rstrip("/").removeprefix("https://opencode.ai") + "/chat/completions")
                        self.assertEqual(request.headers["x-opencode-session-id"], session)
                        self.assertEqual(request.headers["x-opencode-client"], "paralens")
                        self.assertEqual(request.headers["user-agent"], "ParaLens/0.1.9")
                        self.assertEqual(request.headers["authorization"], "Bearer synthetic-opencode-key")
                        self.assertEqual(request.headers["x-test-preserved"], "yes")
                        self.assertNotIn("PRIVATE", str(request.headers))
                        self.assertEqual(json.loads(request.content)["model"], "glm-5.3-flash")

    def test_session_is_new_for_each_job_and_does_not_change_other_clients(self):
        with httpx.Client(transport=httpx.MockTransport(lambda _request: self.response())) as http:
            first = self.client("https://opencode.ai/zen/v1", http)
            second = self.client("https://opencode.ai/zen/v1", http)
            for translator in (first, second):
                worker.configure_provider_client(translator, {"baseURL": "https://opencode.ai/zen/v1"})
            self.assertNotEqual(first.client.default_headers["x-opencode-session"], second.client.default_headers["x-opencode-session"])
            self.assertEqual(first.client.default_headers["User-Agent"], "ParaLens/unknown")

    def test_other_hosts_and_paths_receive_no_opencode_headers(self):
        for base in (
            "https://api.openai.com/v1", "https://api.deepseek.com",
            "https://openrouter.ai/api/v1", "http://localhost:4000/v1",
            "https://opencode.ai.attacker.invalid/zen/v1",
            "https://opencode.ai/other/v1", "https://opencode.ai:8443/zen/v1",
            "https://key@opencode.ai/zen/v1", "https://opencode.ai/zen/v1?key=private",
            "http://opencode.ai/zen/v1",
        ):
            with self.subTest(base=base):
                client = object()
                translator = types.SimpleNamespace(client=client)
                self.assertFalse(worker.configure_provider_client(translator, {"baseURL": base}))
                self.assertIs(translator.client, client)

    def test_invalid_version_cannot_inject_additional_headers(self):
        with httpx.Client(transport=httpx.MockTransport(lambda _request: self.response())) as http:
            translator = self.client("https://opencode.ai/zen/v1", http)
            worker.configure_provider_client(translator, {"baseURL": "https://opencode.ai/zen/v1", "pluginVersion": "0.1.9\r\nAuthorization: private"})
            self.assertEqual(translator.client.default_headers["User-Agent"], "ParaLens/unknown")


if __name__ == "__main__":
    unittest.main()
