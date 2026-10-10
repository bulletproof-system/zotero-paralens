/** A venv directory can survive an interrupted uv sync. Check the actual
 * pinned distribution; settings and installation can opt into worker import checks. */
export async function isBackendInstalled(
  projectDir: string | undefined,
  isWindows: boolean,
  exists: (path: string) => Promise<boolean>,
  execute: (path: string, args: string[]) => Promise<boolean>,
  verifyImports = false,
): Promise<boolean> {
  if (!projectDir) return false;
  const environment = PathUtils.join(projectDir, ".venv");
  const python = isWindows
    ? PathUtils.join(environment, "Scripts", "python.exe")
    : PathUtils.join(environment, "bin", "python");
  try {
    if (
      !(await exists(PathUtils.join(environment, "pyvenv.cfg"))) ||
      !(await exists(python))
    )
      return false;
    return await execute(python, [
      "-c",
      [
        "from importlib.metadata import version",
        "assert version('babeldoc') == '0.6.4'",
        "import pymupdf",
        "from babeldoc.docvision.base_doclayout import DocLayoutModel",
        "from babeldoc.format.pdf.high_level import do_translate, get_translation_stage",
        "from babeldoc.progress_monitor import ProgressMonitor",
        "from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode",
        "from babeldoc.translator.translator import OpenAITranslator, set_translate_rate_limiter",
        "from babeldoc.format.pdf.document_il.midend.add_debug_information import AddDebugInformation",
        "from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater",
        "from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import ILTranslatorLLMOnly",
      ]
        .slice(0, verifyImports ? undefined : 2)
        .join("; "),
    ]);
  } catch {
    return false;
  }
}
