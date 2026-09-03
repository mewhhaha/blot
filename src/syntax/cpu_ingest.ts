import type { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";

export function ingestCpuSource(
  instance: CpuFrontend,
  source: string,
): ReturnType<CpuFrontend["ingest"]> {
  let result = instance.ingest(source);
  if (
    !result.ok &&
    result.diagnostics.length > 0 &&
    result.diagnostics.every((diagnostic) =>
      diagnostic.code === "GPU_FRONTEND_INTEGER_BOUNDS"
    )
  ) {
    // Baba owns syntax, but its compact frontend also applies an I32 policy
    // that is not part of Blot's I64 integer domain. Baba has already proved
    // these spans are integer tokens, so replacing their digits preserves token
    // identities and offsets without duplicating lexical logic in Blot.
    let syntaxSource = source;
    for (const diagnostic of [...result.diagnostics].reverse()) {
      syntaxSource = syntaxSource.slice(0, diagnostic.start) +
        "0".repeat(diagnostic.end - diagnostic.start) +
        syntaxSource.slice(diagnostic.end);
    }
    result = instance.ingest(syntaxSource);
  }
  return result;
}
