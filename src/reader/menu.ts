import {
  cancelActiveTranslation,
  isTranslationCancellable,
  openSavedBilingual,
  translateSelection,
} from "./translationWorkflow";

const menuItems = new Map<
  Window,
  {
    items: HTMLElement[];
    popup: Element;
    onShowing: EventListener;
    onUnload: EventListener;
  }
>();

/** Add a user-invoked action to Zotero's attachment context menu. */
export function registerTranslationMenu(win: Window): void {
  if (menuItems.has(win)) return;
  const doc = win.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return;
  const zh = (win.navigator.language || "en").toLowerCase().startsWith("zh");
  const entries: Array<
    [string, string, (items: Zotero.Item[]) => Promise<void>]
  > = [
    [
      "paralens-translate-pdf",
      zh ? "ParaLens：翻译 PDF" : "ParaLens: Translate PDF",
      (items) => translateSelection(win, items),
    ],
    [
      "paralens-open-bilingual",
      zh ? "ParaLens：打开双语对照" : "ParaLens: Open bilingual view",
      openSavedBilingual,
    ],
    [
      "paralens-cancel-translation",
      zh
        ? "ParaLens：取消正在运行的翻译"
        : "ParaLens: Cancel running translation",
      async () => {
        await cancelActiveTranslation();
      },
    ],
  ];
  const created = entries.map(([id, label, action]) => {
    const item = doc.createXULElement("menuitem") as HTMLElement;
    item.id = id;
    item.setAttribute("label", label);
    item.addEventListener("command", () => {
      const selected = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
      void action(selected).catch((error: unknown) => {
        // Never show or log the worker exception: it may include API details.
        const message = error instanceof Error ? error.message : "操作失败";
        win.alert(message);
      });
    });
    popup.appendChild(item);
    return item;
  });
  const updateVisibility = () => {
    const selected = Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
    const show =
      selected.length === 1 &&
      (selected[0].isPDFAttachment() || selected[0].isRegularItem());
    for (const item of created)
      item.hidden =
        item.id === "paralens-cancel-translation"
          ? !isTranslationCancellable()
          : !show;
  };
  popup.addEventListener("popupshowing", updateVisibility);
  const onUnload = () => unregisterTranslationMenu(win);
  menuItems.set(win, {
    items: created,
    popup,
    onShowing: updateVisibility,
    onUnload,
  });
  win.addEventListener("unload", onUnload, { once: true });
}

export function unregisterTranslationMenu(win: Window): void {
  const entry = menuItems.get(win);
  if (!entry) return;
  entry.popup.removeEventListener("popupshowing", entry.onShowing);
  win.removeEventListener("unload", entry.onUnload);
  for (const item of entry.items) item.remove();
  menuItems.delete(win);
}

export function unregisterAllTranslationMenus(): void {
  for (const win of menuItems.keys()) unregisterTranslationMenu(win);
}
