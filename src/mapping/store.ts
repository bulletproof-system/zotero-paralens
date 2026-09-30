import { MappingV1 } from "./types";
import { validateMapping } from "./validation";

function mappingPath(libraryID: number, sourceKey: string): string {
  if (!Number.isSafeInteger(libraryID) || libraryID <= 0)
    throw new Error("Invalid library ID");
  // The filename comes exclusively from a Zotero attachment key, never a PDF title.
  if (!/^[A-Z0-9]{8}$/.test(sourceKey))
    throw new Error("Invalid attachment key");
  return PathUtils.join(
    PathUtils.profileDir,
    "paralens",
    "mappings",
    `${libraryID}-${sourceKey}.json`,
  );
}

export async function saveMapping(
  mapping: MappingV1,
  libraryID: number,
): Promise<void> {
  const path = mappingPath(libraryID, mapping.source.attachmentKey);
  const directory = PathUtils.parent(path);
  if (!directory) throw new Error("Invalid mapping path");
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  await IOUtils.writeJSON(path, validateMapping(mapping), {
    tmpPath: `${path}.paralens-tmp`,
  });
}

export async function loadMapping(
  libraryID: number,
  sourceKey: string,
): Promise<MappingV1 | undefined> {
  const path = mappingPath(libraryID, sourceKey);
  if (!(await IOUtils.exists(path))) return undefined;
  const mapping = validateMapping(await IOUtils.readJSON(path));
  if (mapping.source.attachmentKey !== sourceKey)
    throw new Error("Mapping source attachment mismatch");
  return mapping;
}
