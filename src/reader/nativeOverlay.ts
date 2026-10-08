import {
  MappingSideName,
  MappingV1,
  NormalizedQuad,
  refsForSide,
} from "../mapping/types";
import { getPref, setPref } from "../utils/prefs";
import { counterpartScrollPoint, ScrollPoint } from "./scrollSync";
import { findHit, validateMapping } from "../mapping/validation";
import {
  isPdfViewport,
  normalizedToViewport,
  PdfViewportLike,
  viewportToNormalized,
} from "./geometry";

/** Version-specific Zotero/PDF.js internals must not escape this adapter. */
export interface NativeReaderLike {
  _iframeWindow?: Window;
  _internalReader?: { _primaryView?: { _iframeWindow?: Window } };
  type?: string;
  tabID?: string;
  _item?: { key?: string };
}

type PdfViewerApplicationLike = {
  pdfViewer?: {
    currentPageNumber?: number;
    container?: HTMLElement;
    scrollPageIntoView?(options: {
      pageNumber: number;
      destArray: unknown[];
      allowNegativeOffset?: boolean;
    }): void;
    getPageView(
      index: number,
    ): { div?: HTMLElement; viewport?: PdfViewportLike } | undefined;
  };
  eventBus?: {
    on?(event: string, handler: () => void): void;
    off?(event: string, handler: () => void): void;
  };
};

type PdfWindow = Window & { PDFViewerApplication?: PdfViewerApplicationLike };

type PageContext = {
  page: HTMLElement;
  viewport: PdfViewportLike;
  width: number;
  height: number;
};

function resolvePdfWindow(reader: NativeReaderLike): PdfWindow | undefined {
  // Zotero's outer reader iframe may differ from its PDF.js view iframe.
  for (const win of [
    reader._internalReader?._primaryView?._iframeWindow,
    reader._iframeWindow,
  ]) {
    try {
      const pdf = win as PdfWindow | undefined;
      if (
        pdf?.document &&
        typeof pdf.PDFViewerApplication?.pdfViewer?.getPageView === "function"
      )
        return pdf;
    } catch {
      // An inaccessible iframe is unsupported; do not inject into it.
    }
  }
  return undefined;
}

/** Diagnostic capability gate; false on unsupported/changed Zotero internals. */
export function supportsNativePdfOverlay(reader: NativeReaderLike): boolean {
  return reader.type === "pdf" && Boolean(resolvePdfWindow(reader));
}

/**
 * Transient page-local overlay (not a Zotero annotation). A pair of native
 * Readers can connect onHover to show the same segment on the other side.
 */
export class NativeReaderOverlay {
  private win?: PdfWindow;
  private readonly cleanup: Array<() => void> = [];
  private readonly drawn: HTMLElement[] = [];
  private activeId?: string;
  // Incoming highlights are not local pointer state: hovering an already
  // highlighted counterpart must still notify the opposite Reader.
  private localId?: string;
  private lockedId?: string;
  private ignoreScrollUntil = 0;
  private onClick?: (id: string | undefined) => void;
  private onScroll?: (point: ScrollPoint) => void;
  private onHover?: (segmentId: string | undefined) => void;

  constructor(
    private readonly reader: NativeReaderLike,
    private readonly mapping: MappingV1,
    private readonly side: MappingSideName,
  ) {}

  attach(
    onHover?: (segmentId: string | undefined) => void,
    onClick?: (id: string | undefined) => void,
    onScroll?: (point: ScrollPoint) => void,
  ): boolean {
    if (this.win) return true;
    const win = resolvePdfWindow(this.reader);
    if (!win) return false;
    this.win = win;
    this.onHover = onHover;
    this.onClick = onClick;
    this.onScroll = onScroll;
    const move = (event: Event) => this.handlePointer(event as PointerEvent);
    const leave = (event: Event) => {
      if (event.target === win.document.documentElement)
        this.setActive(undefined);
    };
    const redraw = () => this.redraw();
    const click = (event: Event) => {
      if ((event.target as Element)?.closest?.(".paralens-reader-controls"))
        return;
      const selection = win.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      this.onClick?.(this.hitAt(event as PointerEvent));
    };
    const key = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") this.onClick?.(undefined);
    };
    const scroll = () => {
      this.redraw();
      if (Date.now() >= this.ignoreScrollUntil) {
        const point = this.scrollPoint();
        if (point) this.onScroll?.(point);
      }
    };
    win.document.addEventListener("pointermove", move, true);
    win.document.addEventListener("pointerleave", leave, true);
    win.document.addEventListener("scroll", scroll, true);
    win.document.addEventListener("click", click, true);
    win.document.addEventListener("keydown", key, true);
    win.addEventListener("resize", redraw);
    const hide = () => this.setActive(undefined);
    const unload = () => this.detach();
    win.document.addEventListener("visibilitychange", hide);
    win.addEventListener("pagehide", unload);
    this.cleanup.push(
      () => win.document.removeEventListener("visibilitychange", hide),
      () => win.removeEventListener("pagehide", unload),
      () => win.document.removeEventListener("pointermove", move, true),
      () => win.document.removeEventListener("pointerleave", leave, true),
      () => win.document.removeEventListener("scroll", scroll, true),
      () => win.document.removeEventListener("click", click, true),
      () => win.document.removeEventListener("keydown", key, true),
      () => win.removeEventListener("resize", redraw),
    );
    // PDF.js replaces page DOM during zoom/rotate. Never retain page elements.
    const bus = win.PDFViewerApplication?.eventBus;
    for (const name of [
      "pagerendered",
      "scalechanging",
      "rotationchanging",
      "updateviewarea",
    ]) {
      if (bus?.on && bus.off) {
        bus.on(name, redraw);
        this.cleanup.push(() => bus.off!(name, redraw));
      }
    }
    return true;
  }

  detach(): void {
    this.onHover = undefined;
    this.onClick = undefined;
    this.onScroll = undefined;
    this.lockedId = undefined;
    this.activeId = undefined;
    this.localId = undefined;
    for (const dispose of this.cleanup.splice(0)) {
      try {
        dispose();
      } catch {
        /* Reader iframe may already be destroyed. */
      }
    }
    this.removeDrawn();
    this.win = undefined;
  }

  /** Remote highlight does not emit hover events back to the paired Reader. */
  showSegment(id: string | undefined): void {
    this.activeId = id;
    const segment = this.mapping.segments.find((item) => item.id === id);
    if (segment?.status === "aligned") {
      const pages = refsForSide(segment, this.side).map(
        (ref) => ref.pageIndex + 1,
      );
      const viewer = this.win?.PDFViewerApplication?.pdfViewer;
      // PDF.js virtualizes distant pages. Navigate to the counterpart before
      // drawing; pagerendered will redraw once the new page DOM is available.
      // A multi-page segment should not move a page that is already in view.
      if (
        viewer &&
        typeof viewer.currentPageNumber === "number" &&
        pages.length > 0 &&
        !pages.includes(viewer.currentPageNumber)
      ) {
        this.ignoreScrollUntil = Date.now() + 350;
        viewer.currentPageNumber = pages[0];
      }
    }
    const ref =
      segment?.status === "aligned"
        ? refsForSide(segment, this.side)[0]
        : undefined;
    const viewer = this.win?.PDFViewerApplication?.pdfViewer;
    const area = viewer?.container?.getBoundingClientRect();
    const context = ref && this.getPage(ref.pageIndex);
    if (area && context && ref.quads.length) {
      const page = context.page.getBoundingClientRect();
      const [x, y] = normalizedToViewport(
        context.viewport,
        ref.quads[0][0],
        ref.quads[0][1],
      );
      const top = page.top + (y * page.height) / context.viewport.height;
      if (top < area.top || top > area.bottom - 20)
        this.scrollToPoint({
          pageIndex: ref.pageIndex,
          x: ref.quads[0][0],
          y: ref.quads[0][1],
        });
    }
    this.redraw();
  }

  private setActive(id: string | undefined): void {
    if (this.localId === id && this.activeId === id) return;
    if (this.lockedId) return;
    this.localId = id;
    this.activeId = id;
    this.redraw();
    this.onHover?.(id);
  }

  private getPage(pageIndex: number): PageContext | undefined {
    const view =
      this.win?.PDFViewerApplication?.pdfViewer?.getPageView(pageIndex);
    const viewport = view?.viewport;
    const page = view?.div;
    if (!page || !isPdfViewport(viewport) || !page.isConnected)
      return undefined;
    const rect = page.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    return { page, viewport, width: rect.width, height: rect.height };
  }

  private handlePointer(event: PointerEvent): void {
    if (this.lockedId) return;
    this.setActive(this.hitAt(event));
  }

  private hitAt(event: PointerEvent): string | undefined {
    const target = event.target;
    if (!target || !(target as Element).closest) {
      return undefined;
    }
    const page = (target as Element).closest(
      ".page[data-page-number]",
    ) as HTMLElement | null;
    const pageIndex = Number(page?.dataset.pageNumber) - 1;
    if (!page || !Number.isInteger(pageIndex) || pageIndex < 0) {
      this.setActive(undefined);
      return;
    }
    const context = this.getPage(pageIndex);
    // Gecko may wrap the same PDF.js DOM node differently across the Reader
    // iframe and an event target. Identity (===) is not stable across wrappers.
    if (!context || (context.page !== page && !context.page.isSameNode(page))) {
      return undefined; // The DOM was replaced or is unsupported.
    }
    const rect = page.getBoundingClientRect();
    // DOM may be CSS-scaled while PDF.js viewport is not yet updated.
    const [x, y] = viewportToNormalized(
      context.viewport,
      ((event.clientX - rect.left) / rect.width) * context.viewport.width,
      ((event.clientY - rect.top) / rect.height) * context.viewport.height,
    );
    return findHit(this.mapping, this.side, pageIndex, x, y)?.segment.id;
  }

  setLocked(id: string | undefined): void {
    this.lockedId = id;
    this.localId = undefined;
    this.showSegment(id);
  }
  private scrollPoint(): ScrollPoint | undefined {
    const viewer = this.win?.PDFViewerApplication?.pdfViewer;
    const container = viewer?.container;
    const index = (viewer?.currentPageNumber ?? 1) - 1;
    const context = this.getPage(index);
    if (!container || !context) return undefined;
    const page = context.page.getBoundingClientRect(),
      area = container.getBoundingClientRect();
    const [x, y] = viewportToNormalized(
      context.viewport,
      Math.max(0, Math.min(1, (area.left - page.left) / page.width)) *
        context.viewport.width,
      Math.max(
        0,
        Math.min(1, (area.top + area.height * 0.25 - page.top) / page.height),
      ) * context.viewport.height,
    );
    return { pageIndex: index, x, y };
  }
  scrollToPoint(point: ScrollPoint): void {
    const viewer = this.win?.PDFViewerApplication?.pdfViewer;
    const viewport = viewer?.getPageView(point.pageIndex)?.viewport;
    this.ignoreScrollUntil = Date.now() + 350;
    if (viewer?.scrollPageIntoView && isPdfViewport(viewport)) {
      const [x, y] = viewport.convertToPdfPoint(
        ...normalizedToViewport(viewport, point.x, point.y),
      );
      viewer.scrollPageIntoView({
        pageNumber: point.pageIndex + 1,
        destArray: [null, { name: "XYZ" }, x, y, null],
        allowNegativeOffset: true,
      });
    } else if (viewer) viewer.currentPageNumber = point.pageIndex + 1;
  }
  addControls(
    sync: () => boolean,
    toggle: (enabled: boolean) => void,
    unlock: () => void,
  ): () => void {
    const doc = this.win?.document;
    if (!doc?.body) return () => {};
    const panel = doc.createElement("div");
    panel.className = "paralens-reader-controls";
    Object.assign(panel.style, {
      position: "fixed",
      bottom: "12px",
      right: "24px",
      zIndex: "10000",
      background: "#fff",
      color: "#222",
      padding: "6px",
      border: "1px solid #999",
      borderRadius: "4px",
      font: "12px sans-serif",
    });
    const label = doc.createElement("label"),
      checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = sync();
    checkbox.className = "paralens-sync-scroll";
    checkbox.addEventListener("change", () => toggle(checkbox.checked));
    label.append(checkbox, "同步滚动");
    const button = doc.createElement("button");
    button.textContent = "解除锁定（Esc）";
    button.className = "paralens-unlock-highlight";
    button.addEventListener("click", unlock);
    panel.append(label, button);
    doc.body.appendChild(panel);
    this.cleanup.push(() => panel.remove());
    return () => {
      checkbox.checked = sync();
      button.disabled = !this.lockedId;
      panel.dataset.locked = this.lockedId ?? "";
    };
  }

  private redraw(): void {
    this.removeDrawn();
    const segment = this.mapping.segments.find(
      (item) => item.id === this.activeId,
    );
    if (!segment || segment.status !== "aligned" || !this.win) return;
    for (const ref of refsForSide(segment, this.side)) {
      const context = this.getPage(ref.pageIndex);
      if (!context) continue; // PDF.js virtualized this page; redraw on pagerendered.
      for (const quad of ref.quads) this.drawQuad(context, quad);
    }
  }

  private drawQuad(
    { page, viewport }: PageContext,
    quad: NormalizedQuad,
  ): void {
    const doc = this.win!.document;
    const overlay = doc.createElement("div");
    overlay.className = "paralens-hover-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const points: string[] = [];
    for (let i = 0; i < 8; i += 2) {
      const [x, y] = normalizedToViewport(viewport, quad[i], quad[i + 1]);
      points.push(
        `${(x / viewport.width) * 100}% ${(y / viewport.height) * 100}%`,
      );
    }
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      zIndex: "10",
      background:
        this.side === "source"
          ? "rgba(65, 150, 250, .28)"
          : "rgba(255, 193, 7, .28)",
      clipPath: `polygon(${points.join(", ")})`,
    });
    page.appendChild(overlay);
    this.drawn.push(overlay);
  }

  private removeDrawn(): void {
    for (const overlay of this.drawn.splice(0)) overlay.remove();
  }
}

/** Both tabs remain native Zotero Readers; neither side creates annotations. */
export class NativeReaderPair {
  readonly source: NativeReaderOverlay;
  readonly target: NativeReaderOverlay;

  private readonly attachmentKeysMatch: boolean;
  private lockedId?: string;
  private sync = false;
  private updates: Array<() => void> = [];
  private readonly mapping: MappingV1;

  constructor(
    sourceReader: NativeReaderLike,
    targetReader: NativeReaderLike,
    mapping: MappingV1,
  ) {
    this.mapping = mapping;
    this.sync = getPref("syncScroll") === true;
    this.attachmentKeysMatch =
      sourceReader._item?.key === mapping.source.attachmentKey &&
      targetReader._item?.key === mapping.target.attachmentKey;
    this.source = new NativeReaderOverlay(sourceReader, mapping, "source");
    this.target = new NativeReaderOverlay(targetReader, mapping, "target");
  }

  attach(): boolean {
    if (!this.attachmentKeysMatch) return false;
    const click = (id: string | undefined) => {
      this.lockedId = id === this.lockedId ? undefined : id;
      this.source.setLocked(this.lockedId);
      this.target.setLocked(this.lockedId);
      this.updates.forEach((update) => update());
    };
    const source = this.source.attach(
      (id) => {
        if (!this.lockedId) this.target.showSegment(id);
      },
      click,
      (point) => {
        if (this.sync)
          this.target.scrollToPoint(
            counterpartScrollPoint(this.mapping, "source", point),
          );
      },
    );
    const target = this.target.attach(
      (id) => {
        if (!this.lockedId) this.source.showSegment(id);
      },
      click,
      (point) => {
        if (this.sync)
          this.source.scrollToPoint(
            counterpartScrollPoint(this.mapping, "target", point),
          );
      },
    );
    if (source && target) {
      const toggle = (enabled: boolean) => {
        this.sync = enabled;
        setPref("syncScroll", enabled);
        this.updates.forEach((update) => update());
      };
      this.updates = [
        this.source.addControls(
          () => this.sync,
          toggle,
          () => click(undefined),
        ),
        this.target.addControls(
          () => this.sync,
          toggle,
          () => click(undefined),
        ),
      ];
      this.updates.forEach((update) => update());
      return true;
    }
    this.detach();
    return false;
  }

  detach(): void {
    this.updates = [];
    this.lockedId = undefined;
    this.source.detach();
    this.target.detach();
  }
}
