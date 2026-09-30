/** PDF.js viewport transforms vary by Zotero/PDF.js release. Keep probes here. */
export interface PdfViewportLike {
  viewBox: readonly [number, number, number, number];
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): [number, number];
  convertToViewportPoint(x: number, y: number): [number, number];
}

/**
 * Coordinates in mapping.v1 are normalized against the unrotated visible PDF
 * CropBox (PDF viewBox), top-left origin. The PDF.js viewport handles rotation,
 * crop offsets, display scale and Y-axis reversal in both directions.
 */
export function viewportToNormalized(
  viewport: PdfViewportLike,
  x: number,
  y: number,
): [number, number] {
  const [x0, y0, x1, y1] = viewport.viewBox;
  const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
  return [(pdfX - x0) / (x1 - x0), (y1 - pdfY) / (y1 - y0)];
}

export function normalizedToViewport(
  viewport: PdfViewportLike,
  x: number,
  y: number,
): [number, number] {
  const [x0, y0, x1, y1] = viewport.viewBox;
  return viewport.convertToViewportPoint(
    x0 + x * (x1 - x0),
    y1 - y * (y1 - y0),
  );
}

export function isPdfViewport(value: unknown): value is PdfViewportLike {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Partial<PdfViewportLike>;
  const box = viewport.viewBox;
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > box[0] &&
    box[3] > box[1] &&
    typeof viewport.width === "number" &&
    viewport.width > 0 &&
    typeof viewport.height === "number" &&
    viewport.height > 0 &&
    typeof viewport.convertToPdfPoint === "function" &&
    typeof viewport.convertToViewportPoint === "function"
  );
}
