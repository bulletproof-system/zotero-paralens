import { MappingV1, MappingSideName, refsForSide } from "../mapping/types";
export interface ScrollPoint {
  pageIndex: number;
  x: number;
  y: number;
}

/** Prefer aligned paragraph anchors; page-ratio fallback covers whitespace/unmapped pages. */
export function counterpartScrollPoint(
  mapping: MappingV1,
  side: MappingSideName,
  point: ScrollPoint,
): ScrollPoint {
  const opposite = side === "source" ? "target" : "source";
  let closest:
    | {
        distance: number;
        source: number[];
        target: number[];
        pageIndex: number;
      }
    | undefined;
  for (const segment of mapping.segments) {
    if (segment.status !== "aligned") continue;
    const targets = refsForSide(segment, opposite);
    if (!targets.length) continue;
    const bounds = (quads: number[][]) => {
      const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
      const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
      return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ];
    };
    const sources = refsForSide(segment, side);
    for (let i = 0; i < sources.length; i++) {
      const ref = sources[i];
      if (ref.pageIndex !== point.pageIndex || !ref.quads.length) continue;
      const source = bounds(ref.quads);
      const distance = Math.max(source[1] - point.y, 0, point.y - source[3]);
      const target = targets[Math.min(i, targets.length - 1)];
      if (!closest || distance < closest.distance)
        closest = {
          distance,
          source,
          target: bounds(target.quads),
          pageIndex: target.pageIndex,
        };
    }
  }
  if (closest) {
    const ratio = Math.max(
      0,
      Math.min(
        1,
        (point.y - closest.source[1]) /
          Math.max(0.00001, closest.source[3] - closest.source[1]),
      ),
    );
    return {
      pageIndex: closest.pageIndex,
      x: closest.target[0],
      y: closest.target[1] + ratio * (closest.target[3] - closest.target[1]),
    };
  }
  const count = mapping[side].pageCount,
    targetCount = mapping[opposite].pageCount;
  const position = Math.min(
    targetCount - 0.00001,
    ((point.pageIndex + point.y) / count) * targetCount,
  );
  return { pageIndex: Math.floor(position), x: point.x, y: position % 1 };
}
