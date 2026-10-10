/**
 * Front-end mapping contract consumed by the native Zotero Reader overlay.
 *
 * Backends may use any internal representation, but they must export this
 * versioned, normalized format before the mapping enters the plugin UI.
 */
export const MAPPING_SCHEMA_VERSION = 1 as const;

export type MappingSchemaVersion = typeof MAPPING_SCHEMA_VERSION;
export type MappingSideName = "source" | "target";
export type SegmentStatus = "aligned" | "skipped" | "uncertain" | "failed";

/** A normalized PDF page quad: x/y pairs, clockwise, in [0, 1]. */
export type NormalizedQuad = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface MappingPageRef {
  /** Zero-based PDF page index. */
  pageIndex: number;
  /** One or more line quads; a paragraph may span pages and columns. */
  quads: NormalizedQuad[];
  /** Optional text retained for diagnostics and accessibility. */
  text?: string;
}

export interface MappingDocument {
  sha256: string;
  /** Zotero attachment key. Kept outside the backend-specific payload. */
  attachmentKey: string;
  pageCount: number;
}

export interface MappingSegment {
  /** Stable only within this translation job and mapping file. */
  id: string;
  level: "paragraph" | "sentence";
  status: SegmentStatus;
  confidence?: number;
  source: MappingPageRef[];
  target: MappingPageRef[];
  metadata?: Record<string, unknown>;
}

export interface MappingProvenance {
  backend: string;
  backendVersion?: string;
  adapterVersion: string;
  createdAt: string;
  sourceFormat?: string;
  /** Backend IDs are diagnostic only and must not be used as stable IDs. */
  backendIds?: Record<string, string>;
}

export interface MappingV1 {
  schemaVersion: MappingSchemaVersion;
  /** Translation completeness; absent values denote a complete result. */
  completion?: "complete" | "partial";
  source: MappingDocument;
  target: MappingDocument;
  segments: MappingSegment[];
  provenance: MappingProvenance;
}

/** Worker geometry before Zotero imports the translated attachment. */
export type UnboundMappingDocument = Omit<MappingDocument, "attachmentKey">;
export type UnboundMappingV1 = Omit<MappingV1, "source" | "target"> & {
  source: UnboundMappingDocument;
  target: UnboundMappingDocument;
};
export interface MappingHit {
  segment: MappingSegment;
  side: MappingSideName;
  pageIndex: number;
  quadIndex: number;
}

export function refsForSide(
  segment: MappingSegment,
  side: MappingSideName,
): MappingPageRef[] {
  return side === "source" ? segment.source : segment.target;
}
