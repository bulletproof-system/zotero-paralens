import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker
from mapping_adapter import _glyph_refs, _snapshot, make_mapping, _canonical


def response(content, finish='stop'):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content), finish_reason=finish)])


class QualityTests(unittest.TestCase):
    def test_known_deepseek_translation_disables_implicit_thinking_without_mutating_other_models(self):
        original = {"model": "deepseek-flash", "extra_body": {"other": True}}
        options = worker.translation_api_options(original)
        self.assertEqual(options["extra_body"], {"other": True, "thinking": {"type": "disabled"}})
        self.assertEqual(original["extra_body"], {"other": True})
        enabled = {"model": "deepseek-v4-pro", "extra_body": {"thinking": {"type": "enabled"}}}
        self.assertEqual(worker.translation_api_options(enabled), enabled)
        for model in ("unrelated-model", "deepseek-reasoner", "deepseek-chat"):
            plain = {"model": model, "max_tokens": 8192}
            self.assertEqual(worker.translation_api_options(plain), plain)
        calls = []
        def create(**options):
            calls.append(options)
            return response("完整译文")
        translator = types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        worker.guard_api_response(translator, threading.Event())
        translator.client.chat.completions.create(**original)
        self.assertEqual(calls[0]["extra_body"]["thinking"]["type"], "disabled")

    def test_empty_reasoning_or_truncated_content_gets_one_larger_budget_retry(self):
        for bad in (response(None,'length'),response('partial','length'),response('  ')):
            calls=[]
            replies=iter((bad,response('中文完整译文')))
            def create(**options): calls.append(options);return next(replies)
            translator=types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
            worker.guard_api_response(translator,threading.Event())
            output=translator.client.chat.completions.create(model='test',max_tokens=2048,messages=[{'role':'user','content':'private'}])
            self.assertEqual(output.choices[0].message.content,'中文完整译文')
            self.assertEqual([c['max_tokens'] for c in calls],[8192,16384])
            self.assertEqual(calls[0]['messages'],calls[1]['messages'])

    def test_empty_output_fails_instead_of_publishing_original_text_and_never_leaks_output(self):
        calls=[]
        def create(**kwargs): calls.append(kwargs);return response(None)
        translator=types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        worker.guard_api_response(translator,threading.Event())
        with self.assertRaises(worker.IncompleteTranslationError) as caught:
            translator.client.chat.completions.create(messages=[{'content':'PRIVATE_TEXT'}])
        self.assertEqual(len(calls),2)
        self.assertNotIn('PRIVATE',str(caught.exception))
        self.assertEqual(worker.safe_job_error(caught.exception,'translation')['code'],'translation_incomplete')

    def test_valid_reply_does_not_retry_and_cancellation_never_calls_provider(self):
        calls=[]
        def create(**kwargs): calls.append(kwargs);return response('译文')
        translator=types.SimpleNamespace(client=types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))))
        cancel=threading.Event();worker.guard_api_response(translator,cancel)
        translator.client.chat.completions.create(max_tokens=8192)
        self.assertEqual(len(calls),1)
        cancel.set()
        with self.assertRaises(asyncio.CancelledError):translator.client.chat.completions.create()
        self.assertEqual(len(calls),1)

    def test_untranslated_prose_is_repaired_before_typesetting_using_preserved_formula_pipeline(self):
        prose='The experiment analyzes the measured results and compares the values with previous reports from other researchers. '
        paragraph=types.SimpleNamespace(unicode=prose,visible=prose)
        name=types.SimpleNamespace(unicode='Example Author',visible='Example Author')
        page=types.SimpleNamespace(pdf_paragraph=[paragraph,name],pdf_font=[],pdf_xobject=[])
        calls=[]
        engine=types.SimpleNamespace(translation_config=types.SimpleNamespace(lang_in='en',lang_out='zh'))
        def post(p,t,prepared,result):p.unicode=result;p.visible=result
        engine.il_translator=types.SimpleNamespace(pre_translate_paragraph=lambda p,*args:(p.unicode,object()),
            generate_prompt_for_llm=lambda text,*args:text,post_translate_paragraph=post)
        def translate(prompt,**kwargs):calls.append(prompt);return '实验分析测量结果，并与已有研究进行比较。'
        engine.translate_engine=types.SimpleNamespace(llm_translate=translate)
        with tempfile.TemporaryDirectory() as folder, patch('babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode',side_effect=lambda p:p.visible):
            stats=worker.repair_untranslated(engine,types.SimpleNamespace(page=[page]),Path(folder),threading.Event(),{id(paragraph):prose,id(name):name.unicode})
            self.assertEqual(stats['repaired'],1);self.assertEqual(stats['remaining'],0)
            self.assertEqual(len(calls),1)
            self.assertNotIn(prose,json.dumps(json.loads((Path(folder)/'translation-quality.json').read_text())))
            self.assertEqual(name.visible,'Example Author')

    def test_bibliography_keeps_names_but_cannot_hide_untranslated_titles_or_prose(self):
        authors = 'Alpha Author Beta Author Gamma Author Delta Author Epsilon Author Zeta Author Eta Author Theta Author Iota Author Kappa Author'
        prose = 'The experiment analyzes the measured results and compares the values with previous reports from other researchers.'
        source = ' '.join(f'[{i}] {authors}. {prose} 2020.' for i in range(1,4))
        translated = ' '.join(f'[{i}] {authors}. 实验结果分析与比较。2020.' for i in range(1,4))
        self.assertTrue(worker._untranslated_prose(translated))
        self.assertFalse(worker._untranslated_prose(translated,source))
        self.assertTrue(worker._untranslated_prose(source,source))
        mixed = translated.replace('[2] '+authors+'. 实验结果分析与比较。','[2] '+authors+'. 部分已译。'+prose)
        self.assertTrue(worker._untranslated_prose(mixed,source))
        missing = translated.replace('[2] '+authors+'. 实验结果分析与比较。','[2] '+authors)
        self.assertTrue(worker._untranslated_prose(missing,source))
        self.assertTrue(worker._untranslated_prose(translated.replace('[2]','[7]'),source))
        self.assertTrue(worker._untranslated_prose('已经翻译。'+prose,prose))
        normal = prose + ' [1] 2020 [2] 2021 [3] 2022'
        self.assertIsNone(worker._bibliography_entries(normal))
        self.assertTrue(worker._untranslated_prose(normal,normal))

    def test_mixed_chinese_does_not_hide_a_substantial_english_passage(self):
        prose = 'The experiment analyzes the measured results and compares the values with previous reports from other researchers.'
        self.assertTrue(worker._untranslated_prose('部分已翻译。' + prose + '结论。'))
        self.assertFalse(worker._untranslated_prose('实验采用 Transformer 和 GPU，参考 Smith et al. (2020)。'))
        for repaired in ('实验分析结果，并与已有研究比较。', '部分已翻译。' + prose):
            paragraph = types.SimpleNamespace(unicode='部分已翻译。' + prose, visible='部分已翻译。' + prose)
            page = types.SimpleNamespace(pdf_paragraph=[paragraph], pdf_font=[], pdf_xobject=[])
            calls = []
            def post(p, tracker, prepared, result):
                p.unicode = result
                p.visible = result
            def translate(prompt, **kwargs):
                calls.append(prompt)
                return repaired
            engine = types.SimpleNamespace(
                translation_config=types.SimpleNamespace(lang_in='en', lang_out='zh'),
                il_translator=types.SimpleNamespace(
                    pre_translate_paragraph=lambda p,*a:(p.unicode,object()),
                    generate_prompt_for_llm=lambda text,*a:text,
                    post_translate_paragraph=post),
                translate_engine=types.SimpleNamespace(llm_translate=translate))
            with tempfile.TemporaryDirectory() as folder, patch(
                'babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode',
                side_effect=lambda p:p.visible):
                if worker._untranslated_prose(repaired):
                    with self.assertRaises(worker.IncompleteTranslationError):
                        worker.repair_untranslated(engine,types.SimpleNamespace(page=[page]),Path(folder),threading.Event(),{id(paragraph):prose})
                    self.assertEqual(json.loads((Path(folder)/'translation-quality.json').read_text())['remaining'],1)
                else:
                    stats=worker.repair_untranslated(engine,types.SimpleNamespace(page=[page]),Path(folder),threading.Event(),{id(paragraph):prose})
                    self.assertEqual(stats['repaired'],1)
                self.assertEqual(len(calls),1)

    def test_real_babeldoc_preparation_skips_unicode_but_original_snapshot_remains_translatable(self):
        import copy
        import re
        from babeldoc.format.pdf.document_il.il_version_1 import PdfParagraph, PdfParagraphComposition, PdfSameStyleCharacters, PdfSameStyleUnicodeCharacters, PdfCharacter
        from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
        translator = object.__new__(ILTranslator)
        for attribute in ('_formula_placeholder_pattern','_style_left_placeholder_pattern','_style_right_placeholder_pattern'):
            setattr(translator,attribute,re.compile(r'(?!)'))
        prose = 'The experiment analyzes the measured results and compares the values with previous reports from other researchers.'
        original = PdfParagraph(unicode=prose,pdf_paragraph_composition=[PdfParagraphComposition(pdf_same_style_characters=PdfSameStyleCharacters(pdf_character=[PdfCharacter(char_unicode=char) for char in prose]))])
        saved = copy.deepcopy(original)
        original.unicode = '已译。' + prose
        original.pdf_paragraph_composition = [PdfParagraphComposition(pdf_same_style_unicode_characters=PdfSameStyleUnicodeCharacters(unicode=original.unicode))]
        self.assertIsNone(translator.get_translate_input(original))
        prepared = translator.get_translate_input(saved)
        self.assertEqual(prepared.unicode,prose)
        self.assertEqual(saved.pdf_paragraph_composition[0].pdf_same_style_unicode_characters,None)

    def test_repair_prepares_original_compositions_not_posttranslation_unicode(self):
        prose = 'The experiment analyzes the measured results and compares the values with previous reports from other researchers.'
        original = types.SimpleNamespace(unicode=prose, parsed_unicode=False, formula='v1v')
        paragraph = types.SimpleNamespace(unicode='已译。' + prose, visible='已译。' + prose, parsed_unicode=True)
        page = types.SimpleNamespace(pdf_paragraph=[paragraph], pdf_font=[], pdf_xobject=[])
        prepared_calls = []
        def pre(source, tracker, fonts, xobjects):
            prepared_calls.append(source)
            # Actual BabelDOC refuses post-translation Unicode compositions.
            if source.parsed_unicode:
                return None, None
            return source.unicode, types.SimpleNamespace(formula=source.formula)
        def post(target, tracker, prepared, translated):
            target.visible = translated
            target.formula = prepared.formula
        engine = types.SimpleNamespace(
            translation_config=types.SimpleNamespace(lang_in='en', lang_out='zh'),
            il_translator=types.SimpleNamespace(pre_translate_paragraph=pre,generate_prompt_for_llm=lambda text,*a:text,post_translate_paragraph=post),
            translate_engine=types.SimpleNamespace(llm_translate=lambda *a,**k:'实验分析结果并与已有研究比较。v1v'))
        with tempfile.TemporaryDirectory() as folder, patch('babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode', side_effect=lambda p:p.visible):
            stats=worker.repair_untranslated(engine,types.SimpleNamespace(page=[page]),Path(folder),threading.Event(),
                {id(paragraph):{'text':prose,'paragraph':original}})
        self.assertEqual(stats['repaired'],1)
        self.assertEqual(stats['remaining'],0)
        self.assertIs(prepared_calls[0],original)
        self.assertEqual(paragraph.formula,'v1v')
        self.assertEqual(original.unicode,prose)

    def test_english_returned_by_provider_does_not_pass_quality_gate(self):
        prose='The experiment analyzes the measured results and compares the values with previous reports from other researchers. '
        paragraph=types.SimpleNamespace(unicode=prose,visible=prose)
        page=types.SimpleNamespace(pdf_paragraph=[paragraph],pdf_font=[],pdf_xobject=[])
        engine=types.SimpleNamespace(translation_config=types.SimpleNamespace(lang_in='en',lang_out='zh'),
            il_translator=types.SimpleNamespace(pre_translate_paragraph=lambda p,*a:(p.unicode,object()),generate_prompt_for_llm=lambda text,*a:text),
            translate_engine=types.SimpleNamespace(llm_translate=lambda *a,**kw:prose))
        with tempfile.TemporaryDirectory() as folder, patch('babeldoc.format.pdf.document_il.utils.layout_helper.get_paragraph_unicode',side_effect=lambda p:p.visible):
            with self.assertRaises(worker.IncompleteTranslationError):
                worker.repair_untranslated(engine,types.SimpleNamespace(page=[page]),Path(folder),threading.Event(),{id(paragraph):prose})
            report=json.loads((Path(folder)/'translation-quality.json').read_text())
            self.assertEqual(report['remaining'],1)
            self.assertEqual(report['no_chinese_reply'],1)


class GlyphMappingTests(unittest.TestCase):
    def paragraph(self,page,text,x=50,y=60):
        raw=page.get_text('rawdict',flags=pymupdf.TEXTFLAGS_RAWDICT&~pymupdf.TEXT_PRESERVE_IMAGES)
        chars=[c for b in raw['blocks'] if b['type']==0 for line in b['lines'] for span in line['spans'] for c in span['chars'] if abs(c['origin'][1]-y)<1 and c['origin'][0]>=x-0.01]
        glyphs=[]
        inverse=~page.transformation_matrix
        for char in chars:
            if char['c'].isspace():continue
            rect=pymupdf.Rect(char['bbox'])*inverse
            glyphs.append({'text':char['c'],'box':dict(zip(('x','y','x2','y2'),rect))})
        return {'_glyphs':glyphs,'_rendered_text':''.join(c['c'] for c in chars),'unicode':text,'debug_id':'stable'}

    def test_short_figure_labels_require_all_actual_glyphs_in_the_unique_location(self):
        for text in ('图', '输入', '输出层', '注意力层'):
            with pymupdf.open() as doc:
                page = doc.new_page()
                page.insert_text((50, 60), text, fontname='china-s', fontsize=11)
                page.insert_text((50, 100), text, fontname='china-s', fontsize=11)
                first, second = self.paragraph(page, text, y=60), self.paragraph(page, text, y=100)
                self.assertTrue(_glyph_refs(page, first, 0, {}))
                self.assertNotEqual(_glyph_refs(page, first, 0, {}), _glyph_refs(page, second, 0, {}))
                stale = copy.deepcopy(first)
                stale['_glyphs'][0]['text'] = '错'
                self.assertEqual(_glyph_refs(page, stale, 0, {}), [])
                shifted = copy.deepcopy(first)
                for glyph in shifted['_glyphs']:
                    glyph['box']['x'] += 30
                    glyph['box']['x2'] += 30
                self.assertEqual(_glyph_refs(page, shifted, 0, {}), [])

    def test_unique_geometric_glyph_identity_resolves_repeated_text_without_guessing_ordinal(self):
        with pymupdf.open() as doc:
            page=doc.new_page()
            text='Same paragraph repeated in different places.'
            page.insert_text((50,60),text);page.insert_text((50,100),text)
            first=self.paragraph(page,text,y=60);second=self.paragraph(page,text,y=100)
            refs=_glyph_refs(page,first,0,{})
            self.assertTrue(refs)
            self.assertNotEqual(refs,_glyph_refs(page,second,0,{}))
            broken=json.loads(json.dumps(first));broken['_glyphs'][0]['text']='WRONG'
            self.assertEqual(_glyph_refs(page,broken,0,{}),[])
            shifted=json.loads(json.dumps(first))
            for glyph in shifted['_glyphs']:glyph['box']['x']+=30;glyph['box']['x2']+=30
            self.assertEqual(_glyph_refs(page,shifted,0,{}),[])

    def test_glyph_mapping_uses_actual_pdf_quads_on_crop_and_rotation_and_rejects_stale_geometry(self):
        with pymupdf.open() as doc:
            page=doc.new_page(width=500,height=500)
            page.insert_text((60,80),'Paragraph with formula x = 2 and inline numbers.',fontsize=11)
            page.set_cropbox(pymupdf.Rect(20,20,480,480))
            paragraph=self.paragraph(page,'unused',x=40,y=60)
            for rotation in (0,90,180,270):
                page.set_rotation(rotation)
                refs=_glyph_refs(page,paragraph,0,{})
                self.assertTrue(refs)
                self.assertTrue(all(0<=value<=1 for ref in refs for quad in ref['quads'] for value in quad))


if __name__=='__main__':unittest.main()
