"""BabelDOC 0.6.4 debug IL -> unbound mapping.v1.

Only emit clickable quads when both IL identity and exact PDF text placement agree.
BabelDOC IL is not a public alignment API; ambiguous records remain uncertain.
"""
import hashlib
import json
import math
import unicodedata
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


class MappingUnavailableError(ValueError):
    """Only alignment snapshots are unusable; the translated PDF may still be valid."""


def _composition_characters(paragraph):
    result = []
    for composition in paragraph.get("pdf_paragraph_composition", []):
        for key, value in composition.items():
            if not isinstance(value, dict):
                continue
            if key == "pdf_character":
                result.append(value)
            else:
                result.extend(value.get("pdf_character") or [])
    return result


def _glyphs(paragraph):
    # Pin only rendered character identities and positions, not IL drawings or
    # paragraph bounding rectangles. Quads will come from the ACTUAL PDF.
    return [{"text": char.get("char_unicode"), "box": char.get("box")}
            for char in _composition_characters(paragraph)
            if char.get("char_unicode") and not char.get("debug_info")
            and not char["char_unicode"].isspace()]


def _composition_text(paragraph):
    parts = []
    for composition in paragraph.get("pdf_paragraph_composition", []):
        for key, value in composition.items():
            if not isinstance(value, dict):
                continue
            if key == "pdf_character": parts.append(value.get("char_unicode") or "")
            elif key == "pdf_same_style_unicode_characters": parts.append(value.get("unicode") or "")
            else: parts.extend(char.get("char_unicode") or "" for char in value.get("pdf_character", []))
    return "".join(parts)


def _canonical(value):
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def _snapshot(path):
    # Release each large debug snapshot before loading the next one. Geometry
    # consumes only paragraph identity/text, not millions of drawing objects.
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
        pages = document["page"]
        if not isinstance(pages, list):
            raise ValueError("Invalid snapshot pages")
        compact = []
        for page in pages:
            paragraphs = page.get("pdf_paragraph", [])
            if not isinstance(paragraphs, list):
                raise ValueError("Invalid snapshot paragraphs")
            kept = []
            for p in paragraphs:
                if not isinstance(p, dict) or not isinstance(p.get("unicode", ""), (str, type(None))):
                    raise ValueError("Invalid snapshot paragraph")
                if any(not isinstance(p.get(key), (str, int, type(None))) for key in ("debug_id", "layout_id")):
                    raise ValueError("Invalid paragraph identity")
                kept.append({"unicode": p.get("unicode"), "debug_id": p.get("debug_id"),
                             "layout_id": p.get("layout_id"), "_debug_only": _is_debug_only(p),
                             "_glyphs": _glyphs(p), "_rendered_text": _composition_text(p)})
            compact.append({"pdf_paragraph": kept})
        return {"page": compact}
    except (json.JSONDecodeError, UnicodeError, KeyError, TypeError, ValueError, AttributeError, FileNotFoundError) as error:
        # No exception message/PDF text is copied into the result.
        raise MappingUnavailableError("BabelDOC alignment snapshots unavailable") from error


def _paragraphs(document, page_index):
    pages = document.get("page", [])
    if page_index >= len(pages):
        return []
    return pages[page_index].get("pdf_paragraph", [])


def _raw_text(page):
    """Exclude image payloads from geometry-only character extraction."""
    import pymupdf
    if hasattr(pymupdf, "TEXTFLAGS_RAWDICT"):
        return page.get_text("rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
    return page.get_text("rawdict")


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
            raw_cache[index] = _raw_text(page)
        raw = raw_cache[index]
    else:
        raw = _raw_text(page)
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
    # MuPDF text quads are relative to the top-left of the UNROTATED visible
    # page, not the absolute CropBox position. Do not apply the CropBox offset
    # twice or let page rotation alter normalization.
    if crop.width <= 0 or crop.height <= 0:
        return []
    quads = []
    for q in found:
        points = (q.ul, q.ur, q.lr, q.ll)
        normalized = []
        for point in points:
            x = point.x / crop.width
            y = point.y / crop.height
            if not (-1e-5 <= x <= 1 + 1e-5 and -1e-5 <= y <= 1 + 1e-5):
                return []
            normalized.extend((round(max(0, min(1, x)), 7), round(max(0, min(1, y)), 7)))
        quads.append(normalized)
    return [{"pageIndex": index, "quads": quads}]


def _textbox_text(page, rect, index, cache, textpage):
    """Match TextPage.extractTextbox's strict bbox-overlap rule, without SWIG
    traversing every page character again for every returned search quad.
    Use the SAME search TextPage/flags, not a separately parsed text layer.
    """
    if cache is None or textpage is None or not hasattr(textpage, "extractRAWDICT"):
        return page.get_textbox(rect, textpage=textpage) if textpage is not None else page.get_textbox(rect)
    key = ("search-lines", index)
    if key not in cache:
        lines = []
        for block in textpage.extractRAWDICT()["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                chars = [(char["c"], char["bbox"]) for span in line.get("spans", []) for char in span.get("chars", [])]
                if not chars:
                    continue
                bounds = (min(b[0] for _, b in chars), min(b[1] for _, b in chars),
                          max(b[2] for _, b in chars), max(b[3] for _, b in chars))
                lines.append((bounds, chars))
        cache[key] = lines
    x0, y0, x1, y1 = rect.x0, rect.y0, rect.x1, rect.y1
    def overlaps(bounds):
        return x0 < bounds[2] and y0 < bounds[3] and x1 > bounds[0] and y1 > bounds[1]
    selected = []
    for bounds, chars in cache[key]:
        if overlaps(bounds):
            text = "".join(char for char, bounds in chars if overlaps(bounds))
            if text:
                selected.append(text)
    return "\n".join(selected)


def _refs(page, text, index, raw_cache=None):
    """Find one entire paragraph in the actual PDF; never approximate with IL boxes."""
    text = _text(text)
    if not text or len(text) < 5:
        return []
    # Search for the whole text only: a prefix would mark the wrong paragraph.
    # Reuse one MuPDF TextPage per page instead of parsing a complex page
    # separately for every paragraph AND every returned line quad.
    import pymupdf
    textpage = None
    if raw_cache is not None and hasattr(page, "get_textpage"):
        key = ("search-textpage", index)
        if key not in raw_cache:
            raw_cache[key] = page.get_textpage(flags=pymupdf.TEXTFLAGS_SEARCH)
        textpage = raw_cache[key]
    found = page.search_for(text, quads=True, textpage=textpage) if textpage is not None else page.search_for(text, quads=True)
    if not found or len(found) > 100:
        return _wrapped_cjk_refs(page, text, index, raw_cache)
    # PyMuPDF splits a multiline hit into quads. Reject repeated independent hits.
    extracted = " ".join(_text(_textbox_text(page, q.rect, index, raw_cache, textpage)) for q in found)
    if _text(extracted).casefold() != text.casefold():
        return _wrapped_cjk_refs(page, text, index, raw_cache)
    return _normalize_quads(page, found, index)


def _is_debug_only(paragraph):
    if "_debug_only" in paragraph:
        return paragraph["_debug_only"]
    compositions = paragraph.get("pdf_paragraph_composition", [])
    return bool(compositions) and all(
        (item.get("pdf_character") or {}).get("debug_info") is True
        for item in compositions
    )


def _glyph_refs(page, paragraph, index, cache):
    """Verify IL glyphs against actual PDF chars at the same location.

    Whitespace/formula placeholders/reading-order changes are irrelevant here,
    but text identity AND geometric uniqueness are mandatory. Never emit IL
    boxes themselves or accept a paragraph merely because a rectangle exists.
    """
    import pymupdf
    glyphs = paragraph.get("_glyphs", [])
    if not glyphs:
        return []
    expected = _canonical(paragraph.get("_rendered_text") or "")
    if expected != _canonical("".join(glyph["text"] for glyph in glyphs)):
        return []  # Some visible text has no glyph provenance.
    key = ("glyph-index", index)
    if key not in cache:
        if index not in cache:
            cache[index] = _raw_text(page)
        buckets = {}
        ordinal = 0
        for block in cache[index]["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    for char in span.get("chars", []):
                        if char["c"].isspace():
                            continue
                        bucket = (_canonical(char["c"]), math.floor(char["bbox"][0] * 2))
                        buckets.setdefault(bucket, []).append((ordinal, line, span, char))
                        ordinal += 1
        cache[key] = buckets
    transform_key = ("unrotated-pdf-matrix", index)
    if transform_key not in cache:
        rotation = getattr(page, "rotation", 0)
        try:
            if rotation: page.set_rotation(0)
            cache[transform_key] = page.transformation_matrix
        finally:
            if rotation: page.set_rotation(rotation)
    selected = {}
    for glyph in glyphs:
        box = glyph.get("box")
        if not isinstance(box, dict):
            continue
        coords = [box.get(name) for name in ("x", "y", "x2", "y2")]
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in coords):
            continue
        rect = pymupdf.Rect(*coords) * cache[transform_key]
        if rect.width < 0 or rect.height <= 0:
            continue
        text, bucket = _canonical(glyph["text"]), math.floor(rect.x0 * 2)
        matches = []
        for xbin in range(bucket - 2, bucket + 3):
            for entry in cache[key].get((text, xbin), []):
                bounds = entry[3]["bbox"]
                height = max(rect.height, bounds[3] - bounds[1])
                if (abs(bounds[0] - rect.x0) <= 0.7 and abs(bounds[2] - rect.x1) <= 0.7
                        and abs((bounds[1] + bounds[3] - rect.y0 - rect.y1) / 2) <= height * 0.65):
                    matches.append(entry)
        if len(matches) == 1:
            ordinal, line, span, char = matches[0]
            if ordinal in selected:
                return []  # Two IL glyphs cannot claim the same PDF character.
            selected[ordinal] = (line, span, char)
        elif len(matches) > 1:
            return []  # Nearby identical characters cannot be disambiguated safely.
    # Missing glyphs (unsupported text layer/font) stay unhighlighted. Reject
    # a substantially partial paragraph rather than treating a prefix as full.
    # Short figure labels must verify EVERY glyph, not meet a five-character
    # floor. Long paragraphs retain the strict 98% geometry coverage rule.
    required = len(glyphs) if len(glyphs) < 5 else math.ceil(len(glyphs) * 0.98)
    if not glyphs or len(selected) < required:
        return []
    groups = []
    previous = None
    for ordinal, (line, span, char) in sorted(selected.items()):
        if (not groups or groups[-1][0] is not line or groups[-1][1] is not span
                or ordinal != previous + 1):
            groups.append((line, span, [char]))
        else:
            groups[-1][2].append(char)
        previous = ordinal
    try:
        quads = [pymupdf.recover_span_quad(line["dir"], span, chars=chars) for line, span, chars in groups]
        return _normalize_quads(page, quads, index)
    except (KeyError, ValueError, TypeError, RuntimeError):
        return []


def _paragraph_refs(page, paragraph, fallback_text, index, cache):
    try:
        verified = _glyph_refs(page, paragraph, index, cache)
    except (KeyError, ValueError, TypeError, RuntimeError):
        verified = []
    if verified:
        return verified
    text = paragraph.get("_rendered_text") or fallback_text
    return _safe_refs(page, text, index, cache)


def _safe_refs(page, text, index, cache):
    try:
        return _refs(page, text, index, cache)
    except (KeyError, ValueError, TypeError, RuntimeError):
        # A malformed text layer must not discard an otherwise readable PDF.
        # Never catch cancellation, IO failures, or an exhausted memory budget.
        return []


def _unique_images(document):
    """Match only decoded image identities unique across the whole PDF.

    Derive the quad from the actual image transform, not a guessed figure/IL
    rectangle. Repeated logos, changed rasters and ambiguous placements fail
    closed. Vector-only diagrams are intentionally not claimed here.
    """
    import pymupdf
    images = {}
    for index in range(len(document)):
        page = document[index]
        for image in page.get_image_info(hashes=True):
            identity = image.get("digest")
            if not identity:
                continue
            transform = pymupdf.Matrix(image["transform"])
            points = [pymupdf.Point(x, y) * transform for x, y in ((0, 0), (1, 0), (0, 1), (1, 1))]
            quad = pymupdf.Quad(*points)
            refs = _normalize_quads(page, [quad], index)
            if quad.rect.width < 12 or quad.rect.height < 12:
                refs = []
            images.setdefault(identity, []).append(refs)
    return {identity: refs[0] for identity, refs in images.items() if len(refs) == 1 and refs[0]}


def _figure_segments(source, target):
    originals, translations = _unique_images(source), _unique_images(target)
    return [{"id": f"figure-{offset:04d}", "level": "paragraph", "status": "aligned",
             "confidence": 1, "source": refs, "target": translations[identity],
             "metadata": {"kind": "figure", "identity": "unique-decoded-image"}}
            for offset, (identity, refs) in enumerate(originals.items()) if identity in translations]


def unavailable_mapping(source_path, translated_path):
    """A document-scoped failure marker, never an invented paragraph/quad."""
    import pymupdf
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as target:
        return {
            "schemaVersion": 1,
            "source": {"sha256": digest(source_path), "pageCount": len(source)},
            "target": {"sha256": digest(translated_path), "pageCount": len(target)},
            "segments": [{"id": "mapping-unavailable", "level": "paragraph", "status": "failed",
                          "source": [], "target": [], "metadata": {"scope": "document", "reason": "mapping_unavailable"}}],
            "provenance": {"backend": "babeldoc", "backendVersion": "0.6.4", "adapterVersion": "1",
                           "createdAt": datetime.now(timezone.utc).isoformat(),
                           "sourceFormat": "Alignment unavailable; no inferred geometry"},
        }


def make_mapping(source_path, translated_path, before_path, translated_il_path, after_path, on_progress=None):
    import pymupdf

    if on_progress:
        on_progress(0, 0)
    before = _snapshot(before_path)
    middle = _snapshot(translated_il_path)
    after = _snapshot(after_path)
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as target:
        segments = []
        source_cache, target_cache = {}, {}
        if on_progress:
            on_progress(0, len(source))
        for index in range(len(source)):
            source_page = source[index]
            target_page = target[index] if index < len(target) else None
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
                src = _paragraph_refs(source_page, original, source_text, index, source_cache) if identity else []
                dst = _paragraph_refs(target_page, output, target_text, index, target_cache) if identity and index < len(target) else []
                aligned = bool(src and dst and source_text != target_text)
                segments.append({
                    "id": f"p-{index:04d}-{offset:04d}",
                    "level": "paragraph",
                    "status": "aligned" if aligned else "uncertain",
                    "confidence": 0.8 if aligned else 0,
                    "source": src,
                    "target": dst,
                })
            if on_progress:
                on_progress(index + 1, len(source))
        segments.extend(_figure_segments(source, target))
        if not segments:
            raise ValueError("BabelDOC did not produce any paragraphs (scanned PDF?)")
        return {
            "schemaVersion": 1,
            "source": {"sha256": digest(source_path), "pageCount": len(source)},
            "target": {"sha256": digest(translated_path), "pageCount": len(target)},
            "segments": segments,
            "provenance": {
                "backend": "babeldoc", "backendVersion": "0.6.4",
                "adapterVersion": "3", "createdAt": datetime.now(timezone.utc).isoformat(),
                "sourceFormat": "BabelDOC IL glyph identity and unique raster identity verified against actual PDF geometry",
            },
        }