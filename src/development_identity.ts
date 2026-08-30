export interface DevelopmentRevisionUnit {
  readonly name: string;
  readonly interfaceDigest: string;
  readonly implementationDigest: string;
  readonly wasmDigest: string;
}

export async function developmentRevision(
  entryUnit: string,
  units: readonly DevelopmentRevisionUnit[],
): Promise<string> {
  const identities = units.map((unit) => ({
    name: unit.name,
    interfaceDigest: unit.interfaceDigest,
    implementationDigest: unit.implementationDigest,
    wasmDigest: unit.wasmDigest,
  }));
  identities.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  const encoded = new TextEncoder().encode(JSON.stringify({
    entryUnit,
    units: identities,
  }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
