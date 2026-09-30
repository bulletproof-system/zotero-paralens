"""BabelDOC 0.5.20 debug IL -> unbound mapping.v1.

Only emit clickable quads when both IL identity and exact PDF text placement agree.
BabelDOC IL is not a public alignment API; ambiguous records remain uncertain.
"""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def _paragraphs(document, page_index):
    pages = document.get("page", [])
    if page_index >= len(pages):
        return []
    return pages[page_index].get("pdf_paragraph", [])


def _wrapped_cjk_refs(page, text, index, raw_cache=None):
    """Match one unique CJK paragraph across visual line wraps.

    MuPDF inserts a line separator at arbitrary Chinese character positions;
    BabelDOC IL keeps the unwrapped text. Ignore whitespace ONLY after
    verifying a complete, unique character sequence in a single PDF block.
    Never guess from a prefix or a page/paragraph ordinal.
    """
    import pymupdf

    if len(text) < 12 or not any("\u3400" <= ch <= "\u9fff" for ch in text):
        return []
    needle = "".join(text.split()).casefold()
    if len(needle) < 12:
        return []
    candidates = []
    if raw_cache is not None:
        if index not in raw_cache:
            raw_cache[index] = page.get_text("rawdict")
        raw = raw_cache[index]
    else:
        raw = page.get_text("rawdict")
    for block in raw["blocks"]:
        if block.get("type") != 0:
            continue
        characters = []
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    if not char["c"].isspace():
                        characters.append((char["c"], line, span, char))
        haystack = "".join(entry[0] for entry in characters).casefold()
        offset = haystack.find(needle)
        while offset >= 0:
            candidates.append(characters[offset:offset + len(needle)])
            if len(candidates) > 1:
                return []  # Repeated text is ambiguous even on the same page.
            offset = haystack.find(needle, offset + 1)
    if len(candidates) != 1:
        return []
    selected = candidates[0]
    # Consecutive font spans / lines produce separate quads, never a single
    # paragraph bounding box that could cover figures or adjacent columns.
    groups = []
    for _, line, span, char in selected:
        if not groups or groups[-1][0] is not line or groups[-1][1] is not span:
            groups.append((line, span, [char]))
        else:
            groups[-1][2].append(char)
    try:
        quads = [pymupdf.recover_span_quad(line["dir"], span, chars=chars)
                 for line, span, chars in groups]
        return _normalize_quads(page, quads, index)
    except (KeyError, ValueError, TypeError, RuntimeError):
        return []  # Unusual/corrupt text layer: keep the segment uncertain.


def _normalize_quads(page, found, index):
    if not found or len(found) > 100:
        return []
    crop = page.cropbox
    inverse = ~page.transformation_matrix
    crop_pdf = crop * inverse
    if crop_pdf.width <= 0 or crop_pdf.height <= 0:
        return []
    quads = []
    for q in found:
        points = (q.ul, q.ur, q.lr, q.ll)
        normalized = []
        for point in points:
            pdf = point * inverse
            x = (pdf.x - crop_pdf.x0) / crop_pdf.width
            y = (crop_pdf.y1 - pdf.y) / crop_pdf.height
            if not (-1e-5 <= x <= 1 + 1e-5 and -1e-5 <= y <= 1 + 1e-5):
                return []
            normalized.extend((round(max(0, min(1, x)), 7), round(max(0, min(1, y)), 7)))
        quads.append(normalized)
    return [{"pageIndex": index, "quads": quads}]


def _refs(page, text, index, raw_cache=None):
    """Find one entire paragraph in the actual PDF; never approximate with IL boxes."""
    text = _text(text)
    if not text or len(text) < 5:
        return []
    # Search for the whole text only: a prefix would mark the wrong paragraph.
    found = page.search_for(text, quads=True)
    if not found or len(found) > 100:
        return _wrapped_cjk_refs(page, text, index, raw_cache)
    # PyMuPDF splits a multiline hit into quads. Reject repeated independent hits.
    extracted = " ".join(_text(page.get_textbox(q.rect)) for q in found)
    if _text(extracted).casefold() != text.casefold():
        return _wrapped_cjk_refs(page, text, index, raw_cache)
    return _normalize_quads(page, found, index)


def _is_debug_only(paragraph):
    compositions = paragraph.get("pdf_paragraph_composition", [])
    return bool(compositions) and all(
        (item.get("pdf_character") or {}).get("debug_info") is True
        for item in compositions
    )


def make_mapping(source_path, translated_path, before_path, translated_il_path, after_path):
    import pymupdf

    before = json.loads(Path(before_path).read_text(encoding="utf-8"))
    middle = json.loads(Path(translated_il_path).read_text(encoding="utf-8"))
    after = json.loads(Path(after_path).read_text(encoding="utf-8"))
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as target:
        segments = []
        source_cache, target_cache = {}, {}
        for index in range(len(source)):
            # Reuse a page text layer across paragraphs, without retaining an
            # entire book worth of raw character dicts in the job process.
            source_cache.clear()
            target_cache.clear()
            rendered_all = _paragraphs(after, index)
            debug_offsets = {
                offset for offset, paragraph in enumerate(rendered_all)
                if _is_debug_only(paragraph)
            }
            # Debug helpers are introduced before the translated IL is written,
            # but receive debug_info only in the final typsetting snapshot.
            originals = [p for i, p in enumerate(_paragraphs(before, index)) if i not in debug_offsets]
            translations = [p for i, p in enumerate(_paragraphs(middle, index)) if i not in debug_offsets]
            rendered = [p for i, p in enumerate(rendered_all) if i not in debug_offsets]
            structure_unchanged = len(originals) == len(translations) == len(rendered)
            for offset, original in enumerate(originals):
                candidate = translations[offset] if offset < len(translations) else {}
                output = rendered[offset] if offset < len(rendered) else {}
                source_text = _text(original.get("unicode"))
                target_text = _text(candidate.get("unicode"))
                ids = [item.get("debug_id") for item in (original, candidate, output)]
                labels = [item.get("layout_id") for item in (original, candidate, output)]
                # Ordinal alone is unsafe: BabelDOC can batch or rearrange paragraphs.
                debug_match = (
                    all(ids) and len(set(ids)) == 1
                    and all(
                        sum(p.get("debug_id") == ids[0] for p in stage) == 1
                        for stage in (originals, translations, rendered)
                    )
                )
                layout_match = (
                    all(label is not None for label in labels)
                    and len(set(labels)) == 1
                    and all(
                        sum(p.get("layout_id") == labels[0] for p in stage) == 1
                        for stage in (originals, translations, rendered)
                    )
                )
                identity = structure_unchanged and (debug_match or layout_match)
                src = _refs(source[index], source_text, index, source_cache) if identity else []
                dst = _refs(target[index], target_text, index, target_cache) if identity and index < len(target) else []
                aligned = bool(src and dst and source_text != target_text)
                segments.append({
                    "id": f"p-{index:04d}-{offset:04d}",
                    "level": "paragraph",
                    "status": "aligned" if aligned else "uncertain",
                    "confidence": 0.8 if aligned else 0,
                    "source": src,
                    "target": dst,
                })
        if not segments:
            raise ValueError("BabelDOC did not produce any paragraphs (scanned PDF?)")
        return {
            "schemaVersion": 1,
            "source": {"sha256": digest(source_path), "pageCount": len(source)},
            "target": {"sha256": digest(translated_path), "pageCount": len(target)},
            "segments": segments,
            "provenance": {
                "backend": "babeldoc", "backendVersion": "0.5.20",
                "adapterVersion": "1", "createdAt": datetime.now(timezone.utc).isoformat(),
                "sourceFormat": "BabelDOC debug IL + PDF text (monolingual)",
            },
        }