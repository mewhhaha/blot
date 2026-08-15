import { assertRejects } from "@std/assert";
import {
  decodeCompilerArtifactManifest,
  describeCompilerArtifact,
  validateCompilerArtifact,
} from "./compiler_artifact.ts";

const emptyWasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commit = "1".repeat(40);
const tree = "2".repeat(40);
const rustc = "rustc 1.97.1 (8bab26f4f 2026-07-14)";

Deno.test("compiler artifact manifest authenticates bytes and source tree", async () => {
  const described = await describeCompilerArtifact(
    emptyWasm,
    commit,
    tree,
    rustc,
  );
  const manifest = decodeCompilerArtifactManifest(JSON.stringify(described));
  await validateCompilerArtifact(emptyWasm, manifest, tree);

  await assertRejects(
    () => validateCompilerArtifact(emptyWasm, manifest, "3".repeat(40)),
    Error,
    "belongs to source tree",
  );
  const changed = emptyWasm.slice();
  changed[7] = 1;
  await assertRejects(
    () => validateCompilerArtifact(changed, manifest, tree),
    Error,
    "valid WebAssembly",
  );
});
