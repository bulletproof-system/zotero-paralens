"""Replay generated BabelDOC PDF/IL through the production finalization path.

No translator, saved credentials, model loading or network requests are used.
Inputs are read-only. Outputs go to a newly-created OS temporary directory,
not the repository or original profile. Only counts/timing are printed.
"""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from worker import finalize_translation, atomic_json, safe_job_error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=Path, help="Stopped job containing saved output and IL")
    options = parser.parse_args()
    job = options.job.resolve(strict=True)
    before_candidates = list(job.glob("babeldoc-*/*/styles_and_formulas.json"))
    # Some BabelDOC working paths have no additional input-name directory.
    if not before_candidates:
        before_candidates = list(job.glob("babeldoc-*/styles_and_formulas.json"))
    outputs = list(job.glob("output-*/*.mono.pdf"))
    if len(before_candidates) != 1 or len(outputs) != 1:
        parser.error("Expected exactly one saved IL set and one monolingual PDF")
    before = before_candidates[0]
    source = before.with_name("input.pdf")
    middle = before.with_name("il_translated.json")
    after = before.with_name("typsetting.json")
    for path in (source, before, middle, after, outputs[0]):
        if not path.is_file():
            parser.error("Required replay artifact is unavailable")
    output = Path(tempfile.mkdtemp(prefix="paralens-artifact-replay-"))
    diagnostics = {}
    start = time.perf_counter()
    try:
        finalize_translation(source, outputs[0], before, middle, after, output, diagnostics)
    except Exception as error:
        status = safe_job_error(error, diagnostics.get("stage"))
        atomic_json(output / "error.json", status)
        print(json.dumps({"result": "failed", "stage": status["stage"], "code": status["code"]}))
        raise SystemExit(1) from None
    mapping = json.loads((output / "mapping.v1.json").read_text(encoding="utf8"))
    summary = {"result": "published", "seconds": time.perf_counter() - start,
               "pages": mapping["source"]["pageCount"], "segments": len(mapping["segments"]),
               "aligned": sum(item["status"] == "aligned" for item in mapping["segments"])}
    atomic_json(output / "replay-summary.json", summary)
    # A private manifest lets a local GUI replay find the original input without
    # copying it into fixtures or displaying its filename/content in console logs.
    atomic_json(output / "replay-input.json", {"sourcePath": str(source)})
    print(json.dumps(summary))
    print("REPLAY_DIRECTORY=" + str(output))


if __name__ == "__main__":
    main()
