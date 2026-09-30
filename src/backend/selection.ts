/** Only executable backends belong here; do not offer unavailable placeholders. */
export const BACKENDS = [{ id: "babeldoc", name: "BabelDOC" }] as const;
export type BackendId = (typeof BACKENDS)[number]["id"];

export function resolveBackend(id: string): (typeof BACKENDS)[number] {
  return BACKENDS.find((backend) => backend.id === id) || BACKENDS[0];
}

/** Provisioning is never part of startup or a translation job. */
export function backendInstallArguments(
  id: BackendId,
  projectDir: string,
): string[] {
  if (id !== "babeldoc" || !projectDir) throw new Error("Unsupported backend");
  return ["sync", "--project", projectDir, "--python", "3.12"];
}
