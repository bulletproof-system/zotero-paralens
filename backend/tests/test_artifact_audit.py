"""Independent saved-artifact audit covers every page, not Chinese presence alone."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("artifact_audit", ROOT / "scripts/audit-translation-artifacts.py")
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


class ArtifactAuditTests(unittest.TestCase):
    def fixture(self, root, translated, pdf_text=None, repeated_id=False):
        prose = "The experiment analyzes the measured results and compares the values with previous reports from other researchers."
        before = {"page": [{"pdf_paragraph": [{"unicode": prose, "layout_label": "plain text", "debug_id": str(i)}]} for i in range(2)]}
        after = {"page": [{"pdf_paragraph": [{"unicode": translated, "debug_id": str(i), "pdf_paragraph_composition": [{"pdf_same_style_unicode_characters": {"unicode": translated}}]}]} for i in range(2)]}
        if repeated_id:
            after["page"][1]["pdf_paragraph"].append(dict(after["page"][1]["pdf_paragraph"][0]))
        for name, data in (("before", before), ("translated", after), ("rendered", after)):
            (root / (name + ".json")).write_text(json.dumps(data), encoding="utf8")
        (root / "mapping.json").write_text(json.dumps({"segments": [{"id": f"p-{i:04d}-0000", "status": "aligned"} for i in range(2)]}), encoding="utf8")
        with pymupdf.open() as document:
            for _ in range(2):
                page = document.new_page(width=1400, height=300)
                page.insert_text((40, 60), pdf_text or translated, fontsize=9, fontname="china-s")
            document.save(root / "translated.pdf")
        return [root / (name + ".json") for name in ("before", "translated", "rendered")] + [root / "translated.pdf", root / "mapping.json"]

    def test_complete_translation_covers_all_body_paragraphs(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = audit_module.audit(*self.fixture(Path(folder), "实验分析测量结果，并与已有研究进行比较。"))
        self.assertEqual(summary["bodySource"], 2)
        self.assertEqual(summary["bodyVerified"], 2)
        self.assertEqual(summary["bodyAligned"], 2)
        self.assertEqual(summary["bodyIdentityMissing"], 0)
        self.assertEqual(summary["remainingInRenderedIL"], 0)
        self.assertEqual(summary["unchangedSourcePassagesInPDF"], 0)

    def test_mixed_english_and_stale_published_pdf_cannot_pass(self):
        prose = "The experiment analyzes the measured results and compares the values with previous reports from other researchers."
        with tempfile.TemporaryDirectory() as folder:
            summary = audit_module.audit(*self.fixture(Path(folder), "已翻译。" + prose))
        self.assertEqual(summary["remainingInTranslation"], 2)
        self.assertEqual(summary["remainingInRenderedIL"], 2)
        self.assertEqual(summary["unchangedSourcePassagesInPDF"], 2)
        with tempfile.TemporaryDirectory() as folder:
            summary = audit_module.audit(*self.fixture(Path(folder), "译文正确。", pdf_text=prose))
        self.assertEqual(summary["remainingInRenderedIL"], 0)
        self.assertEqual(summary["unchangedSourcePassagesInPDF"], 2)

    def test_ambiguous_identity_counts_as_unverified_not_success(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = audit_module.audit(*self.fixture(Path(folder), "译文。", repeated_id=True))
        self.assertEqual(summary["bodyIdentityMissing"], 1)
        self.assertEqual(summary["bodyVerified"], 1)


if __name__ == "__main__":
    unittest.main()
