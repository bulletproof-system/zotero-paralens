import { log } from "../utils/log";
import {
  bilingualPair,
  openSavedBilingual,
  openTranslationQueue,
  subscribeBilingual,
} from "./translationWorkflow";

type SectionArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;
type SidebarPanel = { render(args: SectionArgs): void; dispose(): void };
const panels = new Map<HTMLElement, SidebarPanel>();
const localeLinks = new Set<Element>();
let sectionID: string | undefined;
const htmlNS = "http://www.w3.org/1999/xhtml";

export function sidebarAttachment(
  doc: Document,
  item?: Zotero.Item,
): Zotero.Item | undefined {
  const win = doc.defaultView as
    (Window & { Zotero_Tabs?: { selectedID?: string } }) | null;
  const tabID = win?.Zotero_Tabs?.selectedID;
  const reader = Zotero.Reader._readers.find((candidate) =>
    tabID ? candidate.tabID === tabID : candidate._window === win,
  );
  const selected = reader?._item || item;
  return selected && !selected.deleted && selected.isPDFAttachment()
    ? selected
    : undefined;
}

function createPanel(body: HTMLDivElement): SidebarPanel {
  const doc = body.ownerDocument!;
  const zh = (doc.defaultView?.navigator.language || "en")
    .toLowerCase()
    .startsWith("zh");
  const text = (chinese: string, english: string) => (zh ? chinese : english);
  const element = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag) =>
    doc.createElementNS(htmlNS, tag) as HTMLElementTagNameMap[Tag];
  const container = element("div");
  container.className = "paralens-bilingual-sidebar";
  Object.assign(container.style, {
    display: "grid",
    gap: "8px",
    padding: "4px 0",
  });
  const status = element("p");
  status.setAttribute("role", "status");
  status.style.margin = "0";
  const error = element("p");
  error.setAttribute("role", "alert");
  error.style.margin = "0";
  error.style.overflowWrap = "anywhere";
  const syncLabel = element("label");
  const sync = element("input");
  sync.type = "checkbox";
  sync.className = "paralens-sidebar-sync";
  syncLabel.append(sync, text("同步滚动", "Sync scrolling"));
  let item: Zotero.Item | undefined;
  let busy = false;
  let disposed = false;
  let context = 0;
  const actions: HTMLButtonElement[] = [];

  const action = (
    name: string,
    label: string,
    run: (selected: Zotero.Item) => void | Promise<void>,
  ) => {
    const button = element("button");
    button.type = "button";
    button.className = "paralens-sidebar-" + name;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!item || busy || disposed) return;
      const selected = item;
      const current = context;
      busy = true;
      error.textContent = "";
      update();
      void Promise.resolve()
        .then(() => run(selected))
        .catch((failure: unknown) => {
          if (!disposed && current === context)
            error.textContent =
              failure instanceof Error
                ? failure.message
                : text(
                    "操作失败，请查看 ParaLens 日志",
                    "Action failed; check the ParaLens log",
                  );
        })
        .finally(() => {
          busy = false;
          if (!disposed) update();
        });
    });
    actions.push(button);
    return button;
  };

  const open = action(
    "open",
    text("打开双语对照", "Open bilingual view"),
    (selected) => openSavedBilingual([selected]),
  );
  const unlock = action(
    "unlock",
    text("解除高亮锁定（Esc）", "Unlock highlight (Esc)"),
    (selected) => bilingualPair(selected)?.unlock(),
  );
  const tile = action(
    "tile",
    text("重新并排窗口", "Tile reader windows"),
    (selected) => {
      if (!bilingualPair(selected)?.tile())
        throw new Error(
          text(
            "当前窗口管理器不支持自动并排，请手动排列窗口",
            "Arrange the windows manually; automatic tiling is unavailable",
          ),
        );
    },
  );
  const stop = action(
    "stop",
    text("停止双语对照", "Stop bilingual view"),
    (selected) => bilingualPair(selected)?.detach(),
  );
  const queue = action("queue", text("翻译任务队列", "Translation queue"), () =>
    openTranslationQueue(doc.defaultView!),
  );
  sync.addEventListener("change", () => {
    if (item && !busy) bilingualPair(item)?.setSyncScroll(sync.checked);
  });
  container.append(status, open, syncLabel, unlock, tile, stop, queue, error);
  body.replaceChildren(container);

  function update(): void {
    const state = item ? bilingualPair(item)?.state : undefined;
    for (const button of actions) button.disabled = busy || !item;
    open.disabled ||= state?.attached === true;
    sync.disabled = busy || !state?.attached;
    sync.checked = state?.syncScroll === true;
    unlock.disabled ||= !state?.locked;
    tile.disabled ||= !state?.attached;
    stop.disabled ||= !state?.attached;
    status.textContent = !item
      ? text("请打开一个 PDF 附件", "Open a PDF attachment")
      : busy
        ? text("正在处理…", "Working…")
        : state?.attached
          ? state.locked
            ? text(
                "对照已开启 · 高亮已锁定",
                "Bilingual view active · Highlight locked",
              )
            : text(
                "对照已开启 · 悬停或点击段落进行定位",
                "Bilingual view active · Hover or click a paragraph",
              )
          : text(
              "对照未开启。请先通过附件右键菜单翻译 PDF。停止对照不会关闭 PDF 或删除附件。",
              "Bilingual view inactive. Translate the PDF from its context menu first. Stopping keeps PDFs open and attachments intact.",
            );
  }

  const unsubscribe = subscribeBilingual(update);
  return {
    render(args) {
      const selected = sidebarAttachment(args.doc, args.item);
      if (selected?.id !== item?.id) {
        context++;
        error.textContent = "";
      }
      item = selected;
      update();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      container.remove();
    },
  };
}

export function registerBilingualSidebar(): void {
  if (sectionID || !Zotero.ItemPaneManager?.registerSection) return;
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;
  const id = Zotero.ItemPaneManager.registerSection({
    paneID: "paralens-bilingual",
    pluginID: addon.data.config.addonID,
    header: { l10nID: "paralens-bilingual-header", icon },
    sidenav: { l10nID: "paralens-bilingual-sidenav", icon },
    onInit: ({ doc }) => {
      const href = "paralens-mainWindow.ftl";
      if (!doc.querySelector(`link[rel="localization"][href="${href}"]`)) {
        const link = doc.createElementNS(htmlNS, "link");
        link.setAttribute("rel", "localization");
        link.setAttribute("href", href);
        (doc.head || doc.documentElement)!.appendChild(link);
        localeLinks.add(link);
      }
    },
    onItemChange: ({ tabType, setEnabled }) => {
      setEnabled(tabType === "reader");
    },
    onRender: (args) => {
      args.setEnabled(args.tabType === "reader");
      if (args.tabType !== "reader") return;
      let panel = panels.get(args.body);
      if (!panel) {
        panel = createPanel(args.body);
        panels.set(args.body, panel);
      }
      panel.render(args);
    },
    onDestroy: ({ body, doc }) => {
      panels.get(body)?.dispose();
      panels.delete(body);
      if (![...panels.keys()].some((panel) => panel.ownerDocument === doc)) {
        for (const link of localeLinks) {
          if (link.ownerDocument === doc) {
            link.remove();
            localeLinks.delete(link);
          }
        }
      }
    },
  });
  if (id) sectionID = id;
  else log("[ParaLens] 当前 Zotero 无法注册双语侧边栏");
}

export function unregisterBilingualSidebar(): void {
  if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
  sectionID = undefined;
  panels.forEach((panel) => panel.dispose());
  panels.clear();
  localeLinks.forEach((link) => link.remove());
  localeLinks.clear();
}
