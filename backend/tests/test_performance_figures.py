"""Synthetic inputs only: API bounds and actual PDF figure geometry."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker
from mapping_adapter import _figure_segments, make_mapping


def response(content):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(
        message=types.SimpleNamespace(content=content), finish_reason='stop')])


class PerformanceTests(unittest.TestCase):
    def test_bounds_reject_invalid_job_configs(self):
        self.assertEqual(worker.performance_options({}), {'concurrency': 4, 'qps': 2})
        self.assertEqual(worker.performance_options({'concurrency': 16, 'qps': 1}), {'concurrency': 16, 'qps': 1})
        for field, maximum in [('concurrency', 16), ('qps', 10)]:
            for value in [True, 0, -1, 1.5, '4', None, maximum + 1]:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    worker.performance_options({field: value})

    def test_actual_attempts_across_pools_and_empty_retries_share_one_gate(self):
        lock = threading.Lock()
        active = maximum = 0
        starts, counts = [], {}
        def create(**kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                starts.append(time.monotonic())
                identity = kwargs['messages'][0]['content']
                count = counts.get(identity, 0)
                counts[identity] = count + 1
            try:
                time.sleep(0.24)
                return response(None if count == 0 else '译文')
            finally:
                with lock:
                    active -= 1
        translator = types.SimpleNamespace(client=types.SimpleNamespace(
            max_retries=2, chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        worker.guard_api_response(translator, threading.Event(), {'concurrency': 2, 'qps': 10})
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(translator.client.chat.completions.create,
                                   messages=[{'content': str(i)}]) for i in range(6)]
            for future in futures:
                self.assertEqual(future.result().choices[0].message.content, '译文')
        self.assertEqual(translator.client.max_retries, 0)
        self.assertEqual(len(starts), 12)
        self.assertEqual(maximum, 2)
        self.assertTrue(all(b-a >= 0.095 for a, b in zip(starts, starts[1:])))
        self.assertTrue(all(count == 2 for count in counts.values()))

    def test_real_sdk_server_retry_is_bounded_gated_and_auth_is_not_retried(self):
        import httpx
        import openai
        for first_status in (500, 401):
            with self.subTest(status=first_status):
                starts = []
                def handle(request):
                    starts.append(time.monotonic())
                    if len(starts) == 1:
                        return httpx.Response(first_status, json={"error": {"message": "synthetic", "type": "synthetic"}})
                    return httpx.Response(200, json={"id": "test", "object": "chat.completion", "created": 0,
                        "model": "test", "choices": [{"index": 0, "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "译文"}}]})
                with openai.OpenAI(api_key='synthetic', base_url='https://synthetic.invalid/v1',
                                   http_client=httpx.Client(transport=httpx.MockTransport(handle))) as client:
                    worker.guard_api_response(types.SimpleNamespace(client=client), threading.Event(), {'concurrency': 2, 'qps': 10})
                    if first_status == 401:
                        with self.assertRaises(openai.AuthenticationError):
                            client.chat.completions.create(model='test', messages=[{'role': 'user', 'content': 'synthetic'}])
                        self.assertEqual(len(starts), 1)
                    else:
                        result = client.chat.completions.create(model='test', messages=[{'role': 'user', 'content': 'synthetic'}])
                        self.assertEqual(result.choices[0].message.content, '译文')
                        self.assertEqual(len(starts), 2)
                        self.assertGreaterEqual(starts[1]-starts[0], 0.49)
                    self.assertEqual(client.max_retries, 0)

    def test_cancelled_waiters_never_call_provider_and_exception_releases_slot(self):
        cancel = threading.Event()
        gate = worker.RequestGate(1, 10, cancel)
        with self.assertRaises(RuntimeError):
            with gate.request():
                raise RuntimeError('synthetic')
        self.assertEqual(gate.active, 0)
        acquired, calls = threading.Event(), []
        def waiter():
            acquired.set()
            with gate.request():
                calls.append(True)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with gate.request():
                future = pool.submit(waiter)
                self.assertTrue(acquired.wait(1))
                cancel.set()
            with self.assertRaises(asyncio.CancelledError):
                future.result(timeout=1)
        self.assertEqual(calls, [])
        self.assertEqual(gate.active, 0)


class FigureTests(unittest.TestCase):
    def png(self, color=100):
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.Rect(0, 0, 40, 30), False)
        pixmap.clear_with(color)
        return pixmap.tobytes('png')

    def test_unique_image_uses_actual_crop_rotation_and_transform_quads(self):
        with pymupdf.open() as source, pymupdf.open() as target:
            source.new_page(width=500, height=500).insert_image(pymupdf.Rect(60, 80, 220, 200), stream=self.png())
            target.new_page(width=500, height=500).insert_image(pymupdf.Rect(100, 100, 220, 260), stream=self.png(), rotate=90)
            for doc in (source, target):
                doc[0].set_cropbox(pymupdf.Rect(20, 30, 480, 490))
            baseline = _figure_segments(source, target)
            self.assertEqual(len(baseline), 1)
            figure = baseline[0]
            self.assertEqual(figure['metadata']['kind'], 'figure')
            for rotation in (0, 90, 180, 270):
                source[0].set_rotation(rotation)
                target[0].set_rotation(rotation)
                self.assertEqual(_figure_segments(source, target), baseline)
            for side, doc in [('source', source), ('target', target)]:
                quad = figure[side][0]['quads'][0]
                box = doc[0].get_image_info(hashes=True)[0]['bbox']
                self.assertAlmostEqual(min(quad[::2]), box[0] / 460, places=6)
                self.assertAlmostEqual(max(quad[::2]), box[2] / 460, places=6)
                self.assertAlmostEqual(min(quad[1::2]), box[1] / 460, places=6)
                self.assertAlmostEqual(max(quad[1::2]), box[3] / 460, places=6)

    def test_global_duplicate_changed_and_clipped_rasters_are_not_guessed(self):
        for duplicate_side in ('source', 'target', 'changed', 'clipped'):
            with self.subTest(kind=duplicate_side), pymupdf.open() as source, pymupdf.open() as target:
                source.new_page(width=500, height=500).insert_image(pymupdf.Rect(60, 80, 220, 200), stream=self.png())
                target.new_page(width=500, height=500).insert_image(pymupdf.Rect(60, 80, 220, 200), stream=self.png(200 if duplicate_side == 'changed' else 100))
                if duplicate_side in ('source', 'target'):
                    doc = source if duplicate_side == 'source' else target
                    doc.new_page(width=500, height=500).insert_image(pymupdf.Rect(60, 80, 220, 200), stream=self.png())
                if duplicate_side == 'clipped':
                    source[0].set_cropbox(pymupdf.Rect(100, 100, 480, 490))
                self.assertEqual(_figure_segments(source, target), [])

    def test_figure_records_are_published_from_real_pdfs_without_text_box_fabrication(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            paths = [directory / name for name in ('source.pdf', 'target.pdf')]
            for path in paths:
                with pymupdf.open() as doc:
                    doc.new_page().insert_image(pymupdf.Rect(60, 80, 220, 200), stream=self.png())
                    doc.save(path)
            stages = [directory / name for name in ('before.json', 'middle.json', 'after.json')]
            for path in stages:
                path.write_text(json.dumps({'page': [{'pdf_paragraph': []}]}), encoding='utf8')
            mapping = make_mapping(*paths, *stages)
            self.assertEqual(len(mapping['segments']), 1)
            self.assertEqual(mapping['segments'][0]['status'], 'aligned')
            self.assertEqual(mapping['provenance']['adapterVersion'], '3')


if __name__ == '__main__':
    unittest.main()
