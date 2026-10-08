import json
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mapping_adapter import make_mapping, _refs, _textbox_text, _snapshot, _safe_refs, unavailable_mapping, MappingUnavailableError
import worker
from worker import safe_job_error, translation_progress


class RuntimeMappingTests(unittest.TestCase):
    def test_cached_textbox_exactly_matches_native_extraction_on_rotated_and_cropped_pages(self):
        with pymupdf.open() as doc:
            page = doc.new_page(width=500, height=500)
            page.insert_text((50, 60), 'A paragraph with several lines.', fontsize=11)
            page.insert_text((50, 80), 'Another line with formula x = 2.', fontsize=11)
            page.insert_text((290, 60), 'Text in a second column.', fontsize=11)
            page.insert_text((400, 300), 'Rotated line.', fontsize=11, rotate=90)
            page.insert_text((50, 130), '完整的中文段落在这里用于测试文字边界。', fontname='china-s', fontsize=11)
            for rotation in (0, 90, 180, 270):
                page.set_rotation(rotation)
                textpage = page.get_textpage(flags=pymupdf.TEXTFLAGS_SEARCH)
                cache = {}
                rects = [pymupdf.Rect(0, 0, 500, 500), pymupdf.Rect(52, 51, 175, 75), pymupdf.Rect(0, 80, 500, 80.01),
                         pymupdf.Rect(49, 30, 260, 105), pymupdf.Rect(380, 170, 410, 320)]
                rects += [quad.rect for quad in page.search_for('paragraph with several', quads=True, textpage=textpage)]
                for rect in rects:
                    self.assertEqual(_textbox_text(page, rect, 0, cache, textpage), page.get_textbox(rect, textpage=textpage))
            page.set_rotation(0)
            page.set_cropbox(pymupdf.Rect(30, 20, 480, 480))
            textpage = page.get_textpage(flags=pymupdf.TEXTFLAGS_SEARCH)
            rect = pymupdf.Rect(0, 0, 400, 200)
            self.assertEqual(_textbox_text(page, rect, 0, {}, textpage), page.get_textbox(rect, textpage=textpage))

    def test_search_cache_is_reused_and_repeated_paragraphs_remain_uncertain(self):
        with pymupdf.open() as doc:
            page = doc.new_page()
            text = 'An entire unique paragraph for mapping.'
            page.insert_text((50, 60), text)
            cache = {}
            refs = _refs(page, text, 0, cache)
            self.assertTrue(refs)
            lines = cache[('search-lines', 0)]
            self.assertEqual(_refs(page, text, 0, cache), refs)
            self.assertIs(cache[('search-lines', 0)], lines)
            page.insert_text((50, 100), text)
            self.assertEqual(_refs(page, text, 0, {}), [])

    def test_snapshots_keep_only_text_identity_and_debug_filter(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.json'
            path.write_text(json.dumps({'page':[{'pdf_paragraph':[{'unicode':'text', 'debug_id':'id', 'layout_id':1,
                'pdf_paragraph_composition':[{'pdf_character':{'debug_info':True, 'unused':list(range(100))}}]}], 'unused':[]}]}))
            compact = _snapshot(path)
            self.assertTrue(compact['page'][0]['pdf_paragraph'][0]['_debug_only'])
            self.assertNotIn('pdf_paragraph_composition', compact['page'][0]['pdf_paragraph'][0])
            path.write_text('{broken')
            with self.assertRaises(MappingUnavailableError): _snapshot(path)
            with self.assertRaises(MappingUnavailableError): _snapshot(path.with_name('absent.json'))

    def test_geometry_errors_are_uncertain_but_io_and_memory_errors_are_not_swallowed(self):
        for error in (ValueError('bad quad'), RuntimeError('bad text layer'), KeyError('char')):
            with patch('mapping_adapter._refs', side_effect=error):
                self.assertEqual(_safe_refs(None, 'text', 0, {}), [])
        for error in (PermissionError('private path'), MemoryError('private text')):
            with patch('mapping_adapter._refs', side_effect=error):
                with self.assertRaises(type(error)): _safe_refs(None, 'text', 0, {})

    def test_mapping_progress_cancellation_and_failed_marker_use_real_documents(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root/'source.pdf', root/'target.pdf'
            for path, text in ((source, 'Source paragraph for mapping.'), (target, 'Target paragraph for mapping.')):
                with pymupdf.open() as doc:
                    for _ in range(2): doc.new_page().insert_text((50, 60), text)
                    doc.save(path)
            stages=[]
            for i, text in enumerate(('Source paragraph for mapping.', 'Target paragraph for mapping.', 'Target paragraph for mapping.')):
                path=root/f'{i}.json'
                path.write_text(json.dumps({'page':[{'pdf_paragraph':[{'unicode':text, 'debug_id':'id'}]} for _ in range(2)]}))
                stages.append(path)
            updates=[]
            mapped=make_mapping(source,target,*stages,on_progress=lambda done,total:updates.append((done,total)))
            self.assertEqual(updates,[(0,0),(0,2),(1,2),(2,2)])
            self.assertTrue(all(s['status']=='aligned' for s in mapped['segments']))
            def cancel(done,total):
                if done==1: raise RuntimeError('cancelled')
            with self.assertRaisesRegex(RuntimeError,'cancelled'): make_mapping(source,target,*stages,on_progress=cancel)
            failed=unavailable_mapping(source,target)
            self.assertEqual(failed['source']['sha256'],mapped['source']['sha256'])
            self.assertEqual(failed['target']['pageCount'],2)
            self.assertEqual(failed['segments'][0]['status'],'failed')
            self.assertEqual(failed['segments'][0]['source'],[])
            self.assertEqual(failed['segments'][0]['target'],[])
            self.assertNotIn('Source paragraph',json.dumps(failed))

    def test_progress_is_overall_not_stage_completion_and_handles_nonfinite_values(self):
        event={'stage':'translate','stage_current':1,'stage_total':1,'overall_progress':40}
        self.assertEqual(translation_progress(event)['percent'],36)
        self.assertEqual(translation_progress(dict(event,overall_progress=100))['percent'],90)
        for value in (None,float('nan'),float('inf'),'invalid',-1):
            self.assertEqual(translation_progress(dict(event,overall_progress=value))['percent'],0)

    def test_safe_error_classification_does_not_serialize_exception_messages(self):
        AuthenticationError=type('AuthenticationError',(Exception,),{})
        for error,code in ((AuthenticationError('PRIVATE_KEY'),'api_auth'),(MemoryError('PRIVATE_TEXT'),'memory_exhausted'),
                           (PermissionError('PRIVATE_PATH'),'storage_failure'),(ValueError('PRIVATE_TEXT'),'mapping_failed')):
            status=safe_job_error(error,'mapping')
            self.assertEqual(status['code'],code)
            self.assertNotIn('PRIVATE',json.dumps(status))
            self.assertEqual(set(status),{'schemaVersion','code','stage'})
        wrapper=RuntimeError('PRIVATE_WRAPPER'); wrapper.__cause__=AuthenticationError('PRIVATE_KEY')
        self.assertEqual(safe_job_error(wrapper,'translation')['code'],'api_auth')


class WorkerErrorBoundaryTests(unittest.TestCase):
    def test_main_publishes_only_safe_stage_codes_for_failure_and_cancellation(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            async def failed(_data, _source, _job, diagnostics):
                diagnostics["stage"] = "mapping"
                raise MemoryError("PRIVATE_API_KEY / PDF_TEXT")
            with patch.object(worker, "load_config", return_value=({}, job / "source.pdf", job)), \
                 patch.object(worker, "run", side_effect=failed), patch.object(sys, "argv", ["worker.py", "config"]):
                with self.assertRaises(SystemExit) as exited: worker.main()
                self.assertEqual(exited.exception.code, 1)
                error = json.loads((job / "error.json").read_text())
                self.assertEqual(error, {"schemaVersion": 1, "stage": "mapping", "code": "memory_exhausted"})
                self.assertNotIn("PRIVATE", (job / "error.json").read_text())
                (job / "cancel").write_text("")
                with self.assertRaises(SystemExit): worker.main()
                self.assertEqual(json.loads((job / "error.json").read_text())["code"], "cancelled")
                with patch.object(worker, "atomic_json", side_effect=PermissionError("private")):
                    with self.assertRaises(SystemExit) as exited: worker.main()
                    self.assertEqual(exited.exception.code, 1)


class ProviderGuardTests(unittest.TestCase):
    def test_failed_provider_calls_are_detected_even_if_upstream_swallows_exceptions(self):
        with tempfile.TemporaryDirectory() as folder:
            job=Path(folder)
            event=threading.Event()
            class Provider:
                def translate(self, text): raise ConnectionError("PRIVATE_KEY PRIVATE_TEXT")
                def llm_translate(self, text): raise ConnectionError("PRIVATE_KEY PRIVATE_TEXT")
            provider=Provider()
            state=worker.guard_translator(provider,job,event)
            for method in (provider.translate,provider.llm_translate):
                try: method("PRIVATE_TEXT")
                except ConnectionError: pass  # Models BabelDOC's paragraph fallback.
            self.assertEqual(state["successful"],0)
            self.assertEqual(state["failed"],2)
            self.assertNotIn("PRIVATE",json.dumps(state))
            self.assertFalse(event.is_set(), "A single transient connection failure is not fatal auth")
            error=worker.ProviderJobError(state["error"])
            self.assertEqual(worker.safe_job_error(error,"mapping")["stage"],"translation")

    def test_auth_failure_stops_new_provider_requests_without_leaking_original_exception(self):
        with tempfile.TemporaryDirectory() as folder:
            job=Path(folder)
            event=threading.Event()
            AuthenticationError=type("AuthenticationError",(Exception,),{})
            class Provider:
                calls=0
                def translate(self,text):
                    self.calls+=1
                    raise AuthenticationError("PRIVATE_KEY")
            provider=Provider()
            state=worker.guard_translator(provider,job,event)
            with self.assertRaises(AuthenticationError): provider.translate("private")
            self.assertTrue(event.is_set())
            with self.assertRaises(asyncio.CancelledError): provider.translate("private")
            self.assertEqual(provider.calls,1)
            self.assertEqual(state["error"]["code"],"api_auth")
            self.assertNotIn("PRIVATE",json.dumps(state))

    def test_cancellation_is_observed_without_a_progress_callback_and_blocks_new_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            job=Path(folder)
            event=threading.Event()
            class Provider:
                calls=0
                def llm_translate(self,text): self.calls+=1; return "test output"
            provider=Provider()
            state=worker.guard_translator(provider,job,event)
            with worker.watch_cancellation(job,event):
                self.assertEqual(provider.llm_translate("test"),"test output")
                (job/"cancel").write_text("")
                self.assertTrue(event.wait(2), "Marker must be seen during a silent stage")
                with self.assertRaises(asyncio.CancelledError): provider.llm_translate("test")
            self.assertEqual(provider.calls,1)
            self.assertEqual(state["successful"],1)
            self.assertEqual(state["failed"],0)


class AtomicProgressTests(unittest.TestCase):
    def test_concurrent_callbacks_use_private_temporary_files_and_never_publish_partial_json(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"progress.json"
            failures=[]
            stop=threading.Event()
            def read():
                while not stop.is_set():
                    try:
                        value=json.loads(path.read_text(encoding="utf8"))
                        if value.get("stage")!="test" or not isinstance(value.get("percent"),int):
                            failures.append("invalid progress")
                    except (FileNotFoundError, PermissionError):
                        pass  # Frontend likewise retries transient Windows read locks.
                    except Exception as error:
                        failures.append(type(error).__name__)
                    # Poll like the frontend, rather than deliberately keeping
                    # a deny-delete Windows handle continuously open forever.
                    stop.wait(0.005)
            reader=threading.Thread(target=read)
            reader.start()
            try:
                with ThreadPoolExecutor(max_workers=8) as executor:
                    futures=[executor.submit(worker.atomic_json,path,{"stage":"test","percent":i}) for i in range(160)]
                    for future in futures: future.result()
            finally:
                stop.set();reader.join()
            self.assertEqual(failures,[])
            self.assertEqual(list(path.parent.glob("*.tmp")),[])
            self.assertEqual(json.loads(path.read_text())["stage"],"test")

    def test_failed_replace_preserves_last_complete_progress_and_removes_own_temporary_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"progress.json"
            worker.atomic_json(path,{"percent":25})
            with patch.object(worker.os,"replace",side_effect=PermissionError("private")):
                with self.assertRaises(PermissionError): worker.atomic_json(path,{"percent":50})
            self.assertEqual(json.loads(path.read_text()),{"percent":25})
            self.assertEqual(list(path.parent.glob("*.tmp")),[])

    def test_transient_windows_reader_lock_retries_but_persistent_failures_do_not_succeed(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"progress.json"
            worker.atomic_json(path,{"percent":1})
            replace=worker.os.replace
            attempts=[]
            def temporary_lock(source,target):
                attempts.append(1)
                if len(attempts)<=2: raise PermissionError("temporarily open")
                return replace(source,target)
            with patch.object(worker.os,"replace",side_effect=temporary_lock):
                worker.atomic_json(path,{"percent":2})
            self.assertEqual(len(attempts),3)
            self.assertEqual(json.loads(path.read_text()),{"percent":2})
            self.assertEqual(list(path.parent.glob("*.tmp")),[])

    def test_pinned_monitor_completion_callback_cannot_replace_provider_error_with_typeerror(self):
        from babeldoc.progress_monitor import ProgressMonitor
        event=threading.Event()
        observed=[]
        monitor=ProgressMonitor([("test",1)],cancel_event=event,finish_callback=lambda **record:observed.append(record))
        monitor.on_finish()
        self.assertTrue(event.is_set())
        self.assertEqual(observed[0]["type"],"error")


if __name__ == '__main__': unittest.main()
