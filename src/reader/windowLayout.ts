/** Keep both documents in native Zotero Reader windows and tile them on one display. */
export function tileReaderWindows(
  source: { _window?: Window },
  target: { _window?: Window },
): boolean {
  const left = source._window,
    right = target._window;
  if (!left || !right || left === right || left.closed || right.closed)
    return false;
  try {
    const screen = left.screen as Screen & {
      availLeft?: number;
      availTop?: number;
    };
    const x = screen.availLeft ?? 0,
      y = screen.availTop ?? 0;
    const width = Math.floor(screen.availWidth / 2),
      height = screen.availHeight;
    const restore = (win: Window) =>
      (win as Window & { restore?: () => void }).restore?.();
    restore(left);
    restore(right);
    left.resizeTo(width, height);
    left.moveTo(x, y);
    right.resizeTo(screen.availWidth - width, height);
    right.moveTo(x + width, y);
    return true;
  } catch {
    Zotero.debug(
      "[ParaLens] 当前窗口管理器不允许自动并排，请手动排列两个原生 Reader 窗口",
    );
    return false;
  }
}
