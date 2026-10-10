/** Backend-neutral contract. The UI never imports BabelDOC internals. */
import { UnboundMappingV1 } from "../mapping/types";

export interface TranslationJobRequest {
  sourcePath: string;
  jobDirectory: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider?: string;
  model?: string;
  customBaseURL?: string;
  concurrency?: number;
  qps?: number;
}

export interface TranslationJobProgress {
  stage: string;
  completed?: number;
  total?: number;
  message?: string;
  /** Overall worker progress (0–100), not the current stage percentage. */
  percent?: number;
}

export interface TranslationJobResult {
  translatedPdfPath: string;
  mappingDraftPath: string;
  mapping: UnboundMappingV1;
  completion?: "partial";
  /** Safe, classified failure description; never raw API output. */
  warning?: string;
}

export interface TranslationBackend {
  readonly id: string;
  readonly version: string;
  translate(
    request: TranslationJobRequest,
    onProgress?: (progress: TranslationJobProgress) => void,
  ): Promise<TranslationJobResult>;
  cancel?(): Promise<void>;
}

/**
 * Default backend metadata is data-only. BabelDocBackend implements this
 * contract; switching backends does not change Reader or mapping code.
 */
export const defaultBackend = {
  id: "babeldoc",
  version: "0.6.4",
} as const;
