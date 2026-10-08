"""Read-only, offline quality audit of saved BabelDOC artifacts.

Only aggregate counts are emitted: no PDF text, credentials or exception details.
Unlike a first-page Chinese check, this inspects every substantial body/caption
paragraph and checks unchanged source passages against the published PDF.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from mapping_adapter import _snapshot, _canonical
from worker import _english_prose, _untranslated_prose

ALLOWED_LABELS = {"text", "plain text", "figure_caption", "table_caption", "title", "paragraph_title"}


def audit(before_path, translated_path, rendered_path, pdf_path, mapping_path):
    import pymupdf
    # Preserve source category/identity, releasing the full IL before PDF work.
    document = json.loads(Path(before_path).read_text(encoding="utf8"))
    source = [[{"text": p.get("unicode") or "", "id": p.get("debug_id"), "offset": i, "unique": sum(other.get("debug_id") == p.get("debug_id") for other in page.get("pdf_paragraph", [])) == 1}
               for i, p in enumerate(page.get("pdf_paragraph", []))
               if p.get("layout_label") in ALLOWED_LABELS and _english_prose(p.get("unicode"))]
              for page in document["page"]]
    del document
    middle = _snapshot(translated_path)
    rendered = _snapshot(rendered_path)
    mapping = json.loads(Path(mapping_path).read_text(encoding="utf8"))
    segments = {s["id"]: s for s in mapping["segments"]}
    stats = Counter(bodySource=0, bodyVerified=0, bodyIdentityMissing=0,
                    remainingInTranslation=0, remainingInRenderedIL=0, bibliographyMetadataParagraphs=0,
                    unchangedSourcePassagesInPDF=0, bodyAligned=0,
                    aligned=sum(s["status"] == "aligned" for s in mapping["segments"]),
                    segments=len(mapping["segments"]))
    with pymupdf.open(pdf_path) as pdf:
        target_text = _canonical("".join(page.get_text() for page in pdf))
        for page_index, paragraphs in enumerate(source):
            stages = []
            for stage in (middle, rendered):
                items = stage["page"][page_index]["pdf_paragraph"] if page_index < len(stage["page"]) else []
                ids = Counter(p.get("debug_id") for p in items if p.get("debug_id") is not None)
                stages.append({p["debug_id"]: p for p in items if p.get("debug_id") is not None and ids[p["debug_id"]] == 1})
            for original in paragraphs:
                stats["bodySource"] += 1
                translations = [stage.get(original["id"]) for stage in stages]
                if original["id"] is None or not original["unique"] or any(p is None for p in translations):
                    stats["bodyIdentityMissing"] += 1
                    continue
                stats["bodyVerified"] += 1
                translated, output = translations
                translated_text = translated.get("_rendered_text") or translated.get("unicode")
                rendered_text = output.get("_rendered_text") or output.get("unicode")
                stats["remainingInTranslation"] += _untranslated_prose(translated_text, original["text"])
                stats["remainingInRenderedIL"] += _untranslated_prose(rendered_text, original["text"])
                stats["bibliographyMetadataParagraphs"] += bool(_untranslated_prose(rendered_text) and not _untranslated_prose(rendered_text, original["text"]))
                # Adapter segment offsets omit debug-only helper paragraphs.
                source_all = rendered["page"][page_index]["pdf_paragraph"]
                debug_before = sum(p["_debug_only"] for p in source_all[:original["offset"]])
                segment_id = f"p-{page_index:04d}-{original['offset']-debug_before:04d}"
                stats["bodyAligned"] += segments.get(segment_id, {}).get("status") == "aligned"
                passages = re.split(r"[\u3400-\u9fff]+", original["text"])
                stats["unchangedSourcePassagesInPDF"] += any(
                    _english_prose(passage) and _canonical(passage) in target_text for passage in passages)
    return dict(stats)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "translated", "rendered", "pdf", "mapping"):
        parser.add_argument("--" + name, required=True, type=Path)
    options = parser.parse_args()
    try:
        summary = audit(options.before, options.translated, options.rendered, options.pdf, options.mapping)
    except Exception:
        print(json.dumps({"result": "audit_failed"}))
        return 1
    print(json.dumps(summary))
    return int(bool(summary["bodyIdentityMissing"] or summary["remainingInTranslation"]
                    or summary["remainingInRenderedIL"] or summary["unchangedSourcePassagesInPDF"]))


if __name__ == "__main__":
    raise SystemExit(main())
