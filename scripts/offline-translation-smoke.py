"""Real BabelDOC/PDF layout smoke test with a local, deterministic translator.

Explicit opt-in: run via an already installed backend environment. This script
makes no translation API request; BabelDOC assets may download if not cached.
"""
import argparse
import asyncio
import json
import sys
import tempfile
import subprocess
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from worker import run


def fake_llm(self, prompt, rate_limit_params=None):
    if prompt is None:
        return None
    decoder = json.JSONDecoder()
    for pos, char in enumerate(prompt):
        if char != "[":
            continue
        try:
            batch, _ = decoder.raw_decode(prompt[pos:])
        except json.JSONDecodeError:
            continue
        if (isinstance(batch, list) and batch and "river" in str(batch)
                and all(isinstance(item, dict) and "id" in item and "input" in item for item in batch)):
            return json.dumps([{"id": item["id"], "output": "河流缓缓流淌。水很清澈。"}
                               for item in batch], ensure_ascii=False)
    return "河流缓缓流淌。水很清澈。"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / ".scaffold" / "offline-effect"))
    parser.add_argument("--zotero-omni", help="Optional Zotero app/omni.ja for PDF.js text extraction")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    test_dir = Path(tempfile.mkdtemp(prefix="run-", dir=output))
    source = test_dir / "short-en.pdf"
    pdf = pymupdf.open()
    page = pdf.new_page(width=595, height=842)
    page.insert_text((72, 95), "The river flows gently. The water is clear.", fontsize=14)
    pdf.save(source)
    pdf.close()

    from babeldoc.translator.translator import OpenAITranslator
    # BabelDOC 0.5.20 has both paragraph and batch/LLM translation paths.
    OpenAITranslator.do_translate = lambda self, text, rate_limit_params=None: "河流缓缓流淌。水很清澈。"
    OpenAITranslator.do_llm_translate = fake_llm
    job = test_dir / "job"
    job.mkdir()
    asyncio.run(run({
        "sourceLanguage": "en", "targetLanguage": "zh", "model": "local-smoke",
        "baseURL": "http://127.0.0.1:1/v1", "apiKey": "local-test-only",
    }, source, job))
    mapping = json.loads((job / "mapping.v1.json").read_text(encoding="utf-8"))
    translated = pymupdf.open(job / "translated.pdf")
    assert len(translated) == 1, "expected a one-page translated PDF"
    assert sum(s["status"] == "aligned" for s in mapping["segments"]) >= 1, "no aligned segments"
    translated[0].get_pixmap().save(test_dir / "translated.png")
    if args.zotero_omni:
        pdfjs = test_dir / "pdfjs"
        pdfjs.mkdir()
        with zipfile.ZipFile(args.zotero_omni) as archive:
            for filename in ("pdf.mjs", "pdf.worker.mjs"):
                (pdfjs / filename).write_bytes(archive.read(f"resource/reader/pdf/build/{filename}"))
        extraction = subprocess.run([
            "node", str(ROOT / "scripts" / "zotero-pdfjs-text.mjs"),
            str(pdfjs / "pdf.mjs"), str(job / "translated.pdf"),
        ], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
        pdfjs_text = json.loads(extraction.stdout)
        assert "河流缓缓流淌。水很清澈。" in pdfjs_text["text"], pdfjs_text["text"]
        print("Zotero PDF.js text verified:", json.dumps(pdfjs_text["text"], ensure_ascii=True))
    print(json.dumps({"pdf": str(job / "translated.pdf"), "preview": str(test_dir / "translated.png"),
                      "pages": len(translated), "segments": len(mapping["segments"]),
                      "aligned": sum(s["status"] == "aligned" for s in mapping["segments"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
