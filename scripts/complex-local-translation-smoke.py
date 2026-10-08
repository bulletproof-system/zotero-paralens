"""Run the production worker on an explicit complex PDF against a localhost API.

No saved credentials are read. The source is read-only; outputs and potentially
private third-party logs stay in a fresh OS-temporary directory, not the repo.
A child-process network guard rejects all non-loopback socket connections.
This tests complex parsing/layout/export, NOT real-provider translation quality.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def batch_response(prompt):
    decoder = json.JSONDecoder()
    for offset, character in enumerate(prompt):
        if character != "[":
            continue
        try:
            batch, _ = decoder.raw_decode(prompt[offset:])
        except json.JSONDecodeError:
            continue
        if not isinstance(batch, list) or not batch or not all(isinstance(item, dict) and "id" in item and "input" in item for item in batch):
            continue
        def replacement(item, index):
            # Keep enough text for genuine complex layout/wrapping rather than
            # making every paragraph a trivially tiny identical label.
            length = min(1800, max(20, int(len(str(item["input"])) * 0.6)))
            sentence = "这是本机离线测试的段落内容，用于验证复杂文档的解析和排版。"
            return {"id": item["id"], "output": f"测试段落{index+1}：" + (sentence * (length // len(sentence) + 1))[:length]}
        return json.dumps([replacement(item, index) for index, item in enumerate(batch)], ensure_ascii=False)
    return "这是本机离线测试的译文内容，仅用于验证文档排版。"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--auth-failure", action="store_true", help="Verify structured failure and stop after an injected localhost 401")
    options = parser.parse_args()
    source = options.source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".pdf":
        parser.error("An existing PDF is required")
    original_hash = digest(source)
    directory = Path(tempfile.mkdtemp(prefix="paralens-complex-local-"))
    job = directory / "job"
    job.mkdir()
    requests = 0
    batches = 0
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            nonlocal requests, batches
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer local-test-only":
                self.send_error(404)
                return
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if payload.get("model") != "local-complex-smoke":
                self.send_error(400)
                return
            if options.auth_failure:
                with lock:
                    requests += 1
                body = json.dumps({"error":{"message":"Invalid local-test key", "type":"authentication_error", "code":"invalid_api_key"}}).encode("utf8")
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            response = batch_response(payload["messages"][-1]["content"])
            with lock:
                requests += 1
                batches += response.startswith("[")
            body = json.dumps({"id":"local-complex-test", "object":"chat.completion", "model":"local-complex-smoke",
                "choices":[{"index":0, "finish_reason":"stop", "message":{"role":"assistant", "content":response}}],
                "usage":{"prompt_tokens":10,"completion_tokens":12,"total_tokens":22}}, ensure_ascii=False).encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = job / "config-private.json"
    config.write_text(json.dumps({"sourcePath":str(source), "jobDirectory":str(job), "sourceLanguage":"en", "targetLanguage":"zh",
        "model":"local-complex-smoke", "baseURL":f"http://127.0.0.1:{server.server_port}/v1", "apiKey":"local-test-only"}), encoding="utf8")
    guard = directory / "network-guard"
    guard.mkdir()
    (guard / "sitecustomize.py").write_text('''import sys

def local_only(event, args):
    if event == "socket.connect":
        address = args[1]
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            raise PermissionError("Local test forbids non-loopback network connections")
sys.addaudithook(local_only)
''', encoding="utf8")
    environment = {key:value for key,value in os.environ.items() if key.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    environment.update(PYTHONPATH=str(guard), HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", NO_PROXY="127.0.0.1,localhost,::1", no_proxy="127.0.0.1,localhost,::1")
    start = time.perf_counter()
    try:
        with (directory / "private-runtime.log").open("wb") as log:
            child = subprocess.Popen([sys.executable, str(ROOT / "backend" / "worker.py"), str(config)],
                stdout=log, stderr=log, env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            print("LOCAL_JOB_DIRECTORY=" + str(job), flush=True)
            print("WORKER_PID=" + str(child.pid), flush=True)
            last = None
            while child.poll() is None:
                try:
                    progress = json.loads((job / "progress.json").read_text(encoding="utf8"))
                    # Stage labels can originate in BabelDOC; report only numeric
                    # progress and a local request count, never provider text.
                    state = (progress.get("percent"), requests)
                    if state != last:
                        print(json.dumps({"percent":state[0],"localRequests":state[1]}), flush=True)
                        last = state
                except (OSError, json.JSONDecodeError):
                    pass
                time.sleep(2)
            code = child.wait()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert digest(source) == original_hash, "Source PDF changed"
    if code != 0:
        try:
            failure = json.loads((job / "error.json").read_text(encoding="utf8"))
        except (OSError,json.JSONDecodeError):
            failure = {"stage":"unknown","code":"worker_exit"}
        if options.auth_failure:
            assert failure.get("code") == "api_auth", "Injected 401 did not become a safe auth diagnostic"
            assert requests == 1, "Bad credentials must not be retried for each paragraph"
            assert not (job / "result.json").exists() and not (job / "translated.pdf").exists(), "Failed requests looked successful"
            print(json.dumps({"result":"expected-auth-failure", "code":"api_auth", "localRequests":requests, "seconds":time.perf_counter()-start, "sourceUnchanged":True}))
            return
        print(json.dumps({"result":"failed","stage":failure.get("stage"),"code":failure.get("code"),"localRequests":requests}))
        raise SystemExit(1)
    assert not options.auth_failure, "Injected authentication failure was silently ignored"
    mapping = json.loads((job / "mapping.v1.json").read_text(encoding="utf8"))
    assert requests > 0 and batches > 0, "Worker did not exercise structured localhost translation"
    assert (job / "result.json").exists() and (job / "translated.pdf").exists()
    assert not config.exists(), "Private config was not consumed"
    assert mapping["source"]["sha256"] == original_hash
    assert not any(path.name.startswith(("babeldoc-", "output-")) for path in job.iterdir()), "Temporary work files remained"
    summary={"result":"completed","seconds":time.perf_counter()-start,"sourcePages":mapping["source"]["pageCount"],
             "targetPages":mapping["target"]["pageCount"],"segments":len(mapping["segments"]),"aligned":sum(item["status"]=="aligned" for item in mapping["segments"]),
             "localRequests":requests,"structuredRequests":batches,"sourceUnchanged":True}
    (directory / "summary.json").write_text(json.dumps(summary),encoding="utf8")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
