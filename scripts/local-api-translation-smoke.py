"""Local OpenAI-compatible API smoke test: real SDK transport, no paid API.

Runs the pinned BabelDOC layout and a localhost-only deterministic server.
No saved Zotero API key is accessed; model assets may download if not cached.
"""
import argparse
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import zipfile

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from worker import run


def translate_text(text):
    if "ocean" in text.lower():
        return "海洋今天很平静。空气很清新。"
    return "河流缓缓流淌。水很清澈。"


def translate_prompt(prompt):
    decoder = json.JSONDecoder()
    for pos, char in enumerate(prompt):
        if char != "[":
            continue
        try:
            batch, _ = decoder.raw_decode(prompt[pos:])
        except json.JSONDecodeError:
            continue
        if isinstance(batch, list) and batch and ("river" in str(batch) or "ocean" in str(batch)) and all(
            isinstance(item, dict) and "id" in item and "input" in item for item in batch
        ):
            return json.dumps([
                {"id": item["id"], "output": translate_text(item["input"])}
                for item in batch
            ], ensure_ascii=False)
    return translate_text(prompt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zotero-omni", help="Optional Zotero app/omni.ja for text extraction")
    parser.add_argument("--repeat", type=int, default=1, help="Run twice to catch shared-cache reuse")
    layouts = parser.add_mutually_exclusive_group()
    layouts.add_argument("--two-paragraphs", action="store_true", help="Require two separate aligned paragraphs")
    layouts.add_argument("--two-columns", action="store_true", help="Put two English paragraphs in separate columns")
    layouts.add_argument("--two-pages", action="store_true", help="Put the second English paragraph on page two")
    args = parser.parse_args()
    assert 1 <= args.repeat <= 2
    output = ROOT / ".scaffold" / "local-api-effect"
    output.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="run-", dir=output))
    source = directory / "short-en.pdf"
    pdf = pymupdf.open()
    page = pdf.new_page(width=595, height=400 if args.two_pages else 842)
    if args.two_pages:
        # A near-empty PDF can be misclassified as scanned by BabelDOC's
        # image-difference heuristic. Use a text-dense, legible document.
        river = "The river flows gently. The water is clear. " + (
            "The experiment measures current velocity and water clarity in spring. " * 8
        )
        space = page.insert_textbox(pymupdf.Rect(42, 35, 553, 375), river, fontsize=15)
        assert space >= 0, "First page text overflowed"
        second = pdf.new_page(width=595, height=400)
        ocean = "The ocean is calm today. The air is fresh. " + (
            "The survey measures coastal temperature and air quality in summer. " * 8
        )
        space = second.insert_textbox(pymupdf.Rect(42, 35, 553, 375), ocean, fontsize=15)
        assert space >= 0, "Second page text overflowed"
    elif args.two_columns:
        left = page.insert_textbox(pymupdf.Rect(50, 90, 278, 170),
            "The river flows gently. The water is clear.", fontsize=12)
        right = page.insert_textbox(pymupdf.Rect(318, 90, 555, 170),
            "The ocean is calm today. The air is fresh.", fontsize=12)
        assert left >= 0 and right >= 0, "The synthetic text did not fit within its column"
    else:
        page.insert_text((72, 95), "The river flows gently. The water is clear.", fontsize=14)
        if args.two_paragraphs:
            page.insert_text((72, 180), "The ocean is calm today. The air is fresh.", fontsize=14)
    pdf.save(source)
    pdf.close()
    requests = []
    job = None

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.path == "/v1/chat/completions"
            assert self.headers.get("Authorization") == "Bearer local-test-only"
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert payload["model"] == "local-smoke"
            requests.append(payload)
            answer = translate_prompt(payload["messages"][-1]["content"])
            body = json.dumps({
                "id": "local-test", "object": "chat.completion", "model": "local-smoke",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": answer}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 12, "total_tokens": 22},
            }, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass  # Never log the prompt or Authorization header.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for index in range(args.repeat):
            job = directory / f"job-{index + 1}"
            job.mkdir()
            before = len(requests)
            asyncio.run(run({
                "sourceLanguage": "en", "targetLanguage": "zh", "model": "local-smoke",
                "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                "apiKey": "local-test-only",
            }, source, job))
            assert len(requests) > before, "BabelDOC reused a cached translation without calling this API"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert requests, "OpenAI client did not make a localhost API request"
    mapping = json.loads((job / "mapping.v1.json").read_text(encoding="utf-8"))
    expected = 2 if args.two_paragraphs or args.two_columns or args.two_pages else 1
    aligned = [s for s in mapping["segments"] if s["status"] == "aligned"]
    assert len(aligned) >= expected, mapping["segments"]
    if args.two_paragraphs or args.two_columns or args.two_pages:
        assert len(aligned) == 2, aligned
        for side in ("source", "target"):
            first, second = (s[side][0] for s in aligned)
            if args.two_pages:
                assert first["pageIndex"] == 0 and second["pageIndex"] == 1
            else:
                assert first["pageIndex"] == second["pageIndex"] == 0
            def bounds(ref):
                quad = ref["quads"][0]
                return min(quad[0::2]), min(quad[1::2]), max(quad[0::2]), max(quad[1::2])
            left1, top1, right1, bottom1 = bounds(first)
            left2, top2, right2, bottom2 = bounds(second)
            if args.two_columns:
                assert right1 < left2 or right2 < left1, "Column highlights overlap"
            elif args.two_paragraphs:
                assert bottom1 < top2 or bottom2 < top1, "Two mapped paragraphs overlap"
    translated = pymupdf.open(job / "translated.pdf")
    assert len(translated) == (2 if args.two_pages else 1)
    translated[0].get_pixmap().save(directory / "translated.png")
    if args.zotero_omni:
        pdfjs = directory / "pdfjs"
        pdfjs.mkdir()
        with zipfile.ZipFile(args.zotero_omni) as archive:
            for filename in ("pdf.mjs", "pdf.worker.mjs"):
                (pdfjs / filename).write_bytes(archive.read(f"resource/reader/pdf/build/{filename}"))
        extraction = subprocess.run([
            "node", str(ROOT / "scripts" / "zotero-pdfjs-text.mjs"),
            str(pdfjs / "pdf.mjs"), str(job / "translated.pdf"),
        ], capture_output=True, text=True, encoding="utf-8", check=True)
        extracted = json.loads(extraction.stdout)["text"]
        assert "河流缓缓流淌。水很清澈。" in extracted, extracted
        if args.two_paragraphs or args.two_columns or args.two_pages:
            assert "海洋今天很平静。空气很清新。" in extracted, extracted
    print(json.dumps({"requests": len(requests), "pdf": str(job / "translated.pdf"),
                      "preview": str(directory / "translated.png"),
                      "aligned": sum(s["status"] == "aligned" for s in mapping["segments"])},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
