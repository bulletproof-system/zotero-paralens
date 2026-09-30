/** Deploy the Python sources included in the XPI to a writable, per-profile
 * project. Never install packages here: uv sync is an explicit user action. */
const BUNDLED_FILES = [
  "pyproject.toml",
  "worker.py",
  "mapping_adapter.py",
] as const;

export function bundledBackendProjectDir(): string {
  return PathUtils.join(PathUtils.profileDir, "paralens", "backend");
}

export async function installBundledBackend(
  addonRootURI: string,
): Promise<string> {
  if (!addonRootURI || !addonRootURI.includes(":")) {
    throw new Error("Invalid plugin resource URI");
  }
  // Read all sources before touching any installed file. Fixed filenames only;
  // neither file contents nor directories are supplied by a job or by the user.
  const contents = await Promise.all(
    BUNDLED_FILES.map(async (name) => {
      const content = await Zotero.File.getResourceAsync(
        `${addonRootURI.replace(/\/?$/, "/")}content/backend/${name}`,
      );
      if (
        !content ||
        (name === "pyproject.toml" && !content.includes("babeldoc==0.5.20"))
      ) {
        throw new Error(
          `Bundled backend file is missing or unexpected: ${name}`,
        );
      }
      return content;
    }),
  );
  const project = bundledBackendProjectDir();
  await IOUtils.makeDirectory(project, {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  for (let index = 0; index < BUNDLED_FILES.length; index++) {
    const name = BUNDLED_FILES[index];
    const destination = PathUtils.join(project, name);
    if (
      (await IOUtils.exists(destination)) &&
      (await IOUtils.readUTF8(destination)) === contents[index]
    )
      continue;
    // IOUtils tmpPath makes the replacement atomic. Only managed source files
    // are replaced; .venv, uv.lock, and user work are never removed.
    await IOUtils.writeUTF8(destination, contents[index], {
      mode: "overwrite",
      tmpPath: `${destination}.paralens-install-tmp`,
    });
  }
  return project;
}
