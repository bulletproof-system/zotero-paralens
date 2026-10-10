import { MappingV1 } from "./types";
import { validateMapping } from "./validation";

const sourceTag = (key: string) => `paralens-mapping:${key}`;
const targetTag = (key: string) => `paralens-target:${key}`;

function mappingPath(
  libraryID: number,
  sourceKey: string,
  targetKey?: string,
): string {
  if (!Number.isSafeInteger(libraryID) || libraryID <= 0)
    throw new Error("Invalid library ID");
  if (!/^[A-Z0-9]{8}$/.test(sourceKey))
    throw new Error("Invalid attachment key");
  if (targetKey !== undefined && !/^[A-Z0-9]{8}$/.test(targetKey))
    throw new Error("Invalid target attachment key");
  return PathUtils.join(
    PathUtils.profileDir,
    "paralens",
    "mappings",
    `${libraryID}-${sourceKey}${targetKey ? "-" + targetKey : ""}.json`,
  );
}

async function candidates(
  libraryID: number,
  source: Zotero.Item,
): Promise<Zotero.Item[]> {
  const parent = source.parentItemID
    ? await Zotero.Items.getAsync(source.parentItemID)
    : undefined;
  const items = parent
    ? await Zotero.Items.getAsync(parent.getAttachments())
    : await Zotero.Items.getAll(libraryID, true, false);
  return items.filter(
    (item) =>
      item.isAttachment() &&
      !item.deleted &&
      item.hasTag(sourceTag(source.key)),
  );
}

/** The JSON is an imported stored attachment beside the translated PDF, not a linked local file.
 * Both attachment files and identifying tags travel through Zotero's normal sync. */
export async function saveMapping(
  mapping: MappingV1,
  libraryID: number,
): Promise<void> {
  mapping = validateMapping(mapping);
  const path = mappingPath(
    libraryID,
    mapping.source.attachmentKey,
    mapping.completion === "partial" ? mapping.target.attachmentKey : undefined,
  );
  const source = await Zotero.Items.getByLibraryAndKeyAsync(
    libraryID,
    mapping.source.attachmentKey,
  );
  const target = await Zotero.Items.getByLibraryAndKeyAsync(
    libraryID,
    mapping.target.attachmentKey,
  );
  if (
    !source ||
    !target ||
    !source.isPDFAttachment() ||
    !target.isPDFAttachment()
  )
    throw new Error("原文或译文附件不存在，无法保存同步映射");
  const directory = PathUtils.parent(path);
  if (!directory) throw new Error("Invalid mapping path");
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  // Do not replace the legacy cache until the new imported mapping is committed.
  const draft = `${path}.attachment.json`;
  await IOUtils.writeJSON(draft, mapping, { tmpPath: `${draft}.tmp` });
  let attachment: Zotero.Item | undefined;
  try {
    attachment = await Zotero.Attachments.importFromFile({
      file: draft,
      libraryID,
      parentItemID: target.parentItemID || source.parentItemID || undefined,
      title:
        `ParaLens · 段落映射 · ${source.key} · ${target.key}` +
        (mapping.completion === "partial" ? "（部分翻译，需核对）" : ""),
      contentType: "application/json",
    });
    attachment.addTag(sourceTag(source.key));
    attachment.addTag(targetTag(target.key));
    await attachment.saveTx();
    const stored = await attachment.getFilePathAsync();
    if (!stored) throw new Error("映射附件导入失败");
    const persisted = validateMapping(await IOUtils.readJSON(stored));
    if (JSON.stringify(persisted) !== JSON.stringify(mapping))
      throw new Error("映射附件校验失败");
    // Local cache is migration-only. Synced attachments are always authoritative.
    try {
      await IOUtils.writeJSON(path, mapping, {
        tmpPath: `${path}.paralens-tmp`,
      });
    } catch {
      Zotero.debug("[ParaLens] 本地映射缓存写入失败；已保存的映射附件仍可使用");
    }
  } catch (error) {
    if (attachment) await attachment.eraseTx().catch(() => {});
    throw error;
  } finally {
    try {
      await IOUtils.remove(draft, { ignoreAbsent: true });
    } catch {
      Zotero.debug(
        "[ParaLens] 临时映射文件暂时无法清理；不影响已提交的映射附件",
      );
    }
  }
}

export async function loadMapping(
  libraryID: number,
  sourceKey: string,
  targetKey?: string,
): Promise<MappingV1 | undefined> {
  const path = mappingPath(libraryID, sourceKey, targetKey);
  const source = await Zotero.Items.getByLibraryAndKeyAsync(
    libraryID,
    sourceKey,
  );
  if (source) {
    const attachments = (await candidates(libraryID, source)).filter(
      (attachment) => !targetKey || attachment.hasTag(targetTag(targetKey)),
    );
    const mappings: MappingV1[] = [];
    let missing = false,
      damaged = false;
    for (const attachment of attachments) {
      const stored = await attachment.getFilePathAsync();
      if (!stored || !(await IOUtils.exists(stored))) {
        missing = true;
        continue;
      }
      try {
        const mapping = validateMapping(await IOUtils.readJSON(stored));
        if (
          mapping.source.attachmentKey !== sourceKey ||
          (targetKey && mapping.target.attachmentKey !== targetKey) ||
          !attachment.hasTag(targetTag(mapping.target.attachmentKey))
        )
          throw new Error("映射附件与 PDF 不一致");
        const target = await Zotero.Items.getByLibraryAndKeyAsync(
          libraryID,
          mapping.target.attachmentKey,
        );
        if (target && !target.deleted && target.isPDFAttachment())
          mappings.push(mapping);
      } catch {
        damaged = true;
      }
    }
    if (mappings.length) {
      mappings.sort(
        (a, b) =>
          Number(a.completion === "partial") -
            Number(b.completion === "partial") ||
          Date.parse(b.provenance.createdAt) -
            Date.parse(a.provenance.createdAt),
      );
      return mappings[0];
    }
    if (missing)
      throw new Error("段落映射附件尚未下载；请先同步或下载该 JSON 附件");
    if (damaged)
      throw new Error("段落映射附件损坏，请重新翻译或恢复有效的映射附件");
    // If synced mapping metadata exists, never fall back to a stale per-device cache.
    if (attachments.length) return undefined;
  }
  const cachePath = (await IOUtils.exists(path))
    ? path
    : targetKey
      ? mappingPath(libraryID, sourceKey)
      : undefined;
  if (!cachePath || !(await IOUtils.exists(cachePath))) return undefined;
  const mapping = validateMapping(await IOUtils.readJSON(cachePath));
  if (targetKey && mapping.target.attachmentKey !== targetKey) return undefined;
  if (mapping.source.attachmentKey !== sourceKey)
    throw new Error("Mapping source attachment mismatch");
  // Migrate older profile-only mappings into a stored attachment on first use.
  if (source) await saveMapping(mapping, libraryID);
  return mapping;
}
