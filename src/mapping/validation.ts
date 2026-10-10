import {
  MAPPING_SCHEMA_VERSION,
  MappingHit,
  MappingPageRef,
  MappingSegment,
  MappingSideName,
  MappingV1,
  NormalizedQuad,
  UnboundMappingV1,
  refsForSide,
} from "./types";

export interface MappingValidationOptions {
  /** Permit no aligned segments while a job is still being assembled. */
  allowEmpty?: boolean;
}

export function validateMapping(
  value: unknown,
  options: MappingValidationOptions = {},
): MappingV1 {
  if (!isRecord(value)) throw new Error("mapping must be an object");
  if (value.schemaVersion !== MAPPING_SCHEMA_VERSION) {
    throw new Error(
      `unsupported mapping schema: ${String(value.schemaVersion)}`,
    );
  }
  if (
    value.completion !== undefined &&
    value.completion !== "complete" &&
    value.completion !== "partial"
  )
    throw new Error("mapping.completion is invalid");
  const source = validateDocument(value.source, "source");
  const target = validateDocument(value.target, "target");
  if (!Array.isArray(value.segments))
    throw new Error("segments must be an array");
  if (!options.allowEmpty && value.segments.length === 0) {
    throw new Error("mapping must contain at least one segment");
  }

  const ids = new Set<string>();
  const segments = value.segments.map((item, index) => {
    const segment = validateSegment(
      item,
      index,
      source.pageCount,
      target.pageCount,
    );
    if (ids.has(segment.id))
      throw new Error(`duplicate segment id: ${segment.id}`);
    ids.add(segment.id);
    return segment;
  });
  if (
    !isRecord(value.provenance) ||
    typeof value.provenance.backend !== "string"
  ) {
    throw new Error("provenance.backend is required");
  }
  if (
    typeof value.provenance.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.provenance.createdAt))
  ) {
    throw new Error("provenance.createdAt must be an ISO date-time");
  }
  if (typeof value.provenance.adapterVersion !== "string") {
    throw new Error("provenance.adapterVersion is required");
  }
  return {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    ...(value.completion === undefined ? {} : { completion: value.completion }),
    source,
    target,
    segments,
    provenance: value.provenance as MappingV1["provenance"],
  };
}

/** Bind a backend's draft only after Zotero has imported both attachments. */
export function bindAttachmentKeys(
  draft: UnboundMappingV1,
  sourceAttachmentKey: string,
  targetAttachmentKey: string,
): MappingV1 {
  return validateMapping({
    ...draft,
    source: { ...draft.source, attachmentKey: sourceAttachmentKey },
    target: { ...draft.target, attachmentKey: targetAttachmentKey },
  });
}
export function findHit(
  mapping: MappingV1,
  side: MappingSideName,
  pageIndex: number,
  x: number,
  y: number,
): MappingHit | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  let figureHit: MappingHit | undefined;
  let figureArea = Infinity;
  for (const segment of mapping.segments) {
    if (segment.status !== "aligned") continue;
    const refs = refsForSide(segment, side);
    for (const ref of refs) {
      if (ref.pageIndex !== pageIndex) continue;
      for (let quadIndex = 0; quadIndex < ref.quads.length; quadIndex++) {
        if (pointInQuad(x, y, ref.quads[quadIndex])) {
          const hit = { segment, side, pageIndex, quadIndex };
          // Text has priority over the containing image, irrespective of order.
          if (segment.metadata?.kind !== "figure") return hit;
          // A smaller embedded image must remain hittable inside a composite
          // figure. Use polygon area, not record order or an axis-aligned box.
          const quad = ref.quads[quadIndex];
          let twiceArea = 0;
          for (let i = 0; i < 8; i += 2) {
            const next = (i + 2) % 8;
            twiceArea += quad[i] * quad[next + 1] - quad[next] * quad[i + 1];
          }
          const area = Math.abs(twiceArea) / 2;
          if (area < figureArea) {
            figureArea = area;
            figureHit = hit;
          }
        }
      }
    }
  }
  return figureHit;
}

export function isValidQuad(quad: unknown): quad is NormalizedQuad {
  return (
    Array.isArray(quad) &&
    quad.length === 8 &&
    quad.every(
      (coordinate) =>
        typeof coordinate === "number" && coordinate >= 0 && coordinate <= 1,
    )
  );
}

function validateDocument(value: unknown, label: string): MappingV1["source"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.sha256)
  ) {
    throw new Error(`${label}.sha256 must be a SHA-256 hex string`);
  }
  if (typeof value.attachmentKey !== "string" || !value.attachmentKey) {
    throw new Error(`${label}.attachmentKey is required`);
  }
  if (!isNonNegativeInteger(value.pageCount) || value.pageCount === 0) {
    throw new Error(`${label}.pageCount must be positive`);
  }
  return {
    sha256: value.sha256,
    attachmentKey: value.attachmentKey,
    pageCount: value.pageCount,
  };
}

function validateSegment(
  value: unknown,
  index: number,
  sourcePageCount: number,
  targetPageCount: number,
): MappingSegment {
  if (!isRecord(value)) throw new Error(`segments[${index}] must be an object`);
  if (typeof value.id !== "string" || !value.id)
    throw new Error(`segments[${index}].id is required`);
  if (value.level !== "paragraph" && value.level !== "sentence") {
    throw new Error(`segments[${index}].level is invalid`);
  }
  if (
    !["aligned", "skipped", "uncertain", "failed"].includes(
      String(value.status),
    )
  ) {
    throw new Error(`segments[${index}].status is invalid`);
  }
  const source = validateRefs(value.source, "source", sourcePageCount, index);
  const target = validateRefs(value.target, "target", targetPageCount, index);
  if (
    value.status === "aligned" &&
    (!source.some((ref) => ref.quads.length) ||
      !target.some((ref) => ref.quads.length))
  ) {
    throw new Error(
      `segments[${index}] aligned segment requires quads on both sides`,
    );
  }
  return {
    id: value.id,
    level: value.level,
    status: value.status,
    confidence:
      value.confidence === undefined
        ? undefined
        : validateConfidence(value.confidence),
    source,
    target,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function validateRefs(
  value: unknown,
  label: string,
  pageCount: number,
  index: number,
): MappingPageRef[] {
  if (!Array.isArray(value))
    throw new Error(`segments[${index}].${label} must be an array`);
  return value.map((item, refIndex) => {
    if (
      !isRecord(item) ||
      !isNonNegativeInteger(item.pageIndex) ||
      item.pageIndex >= pageCount
    ) {
      throw new Error(
        `segments[${index}].${label}[${refIndex}] has an invalid pageIndex`,
      );
    }
    if (!Array.isArray(item.quads) || !item.quads.every(isValidQuad)) {
      throw new Error(
        `segments[${index}].${label}[${refIndex}].quads is invalid`,
      );
    }
    return {
      pageIndex: item.pageIndex,
      quads: item.quads as NormalizedQuad[],
      text: typeof item.text === "string" ? item.text : undefined,
    };
  });
}

function validateConfidence(value: unknown): number {
  if (typeof value !== "number" || value < 0 || value > 1)
    throw new Error("confidence must be in [0, 1]");
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointInQuad(x: number, y: number, quad: NormalizedQuad): boolean {
  const points: Array<[number, number]> = [
    [quad[0], quad[1]],
    [quad[2], quad[3]],
    [quad[4], quad[5]],
    [quad[6], quad[7]],
  ];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
