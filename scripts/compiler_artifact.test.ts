import { assertRejects } from "@std/assert";
import {
  decodeCompilerArtifactManifest,
  describeCompilerArtifact,
  validateCompilerArtifact,
} from "./compiler_artifact.ts";
import { COMPILER_HOST_ABI_VERSION } from "../src/compiler/host_abi.ts";

const emptyWasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commit = "1".repeat(40);
const tree = "2".repeat(40);
const rustc = "rustc 1.97.1 (8bab26f4f 2026-07-14)";
const prelude = "3".repeat(64);
const inputs = "4".repeat(64);

Deno.test("compiler artifact manifest authenticates bytes and source tree", async () => {
  const described = await describeCompilerArtifact(
    emptyWasm,
    commit,
    tree,
    rustc,
    prelude,
    inputs,
    "production",
  );
  const manifest = decodeCompilerArtifactManifest(JSON.stringify(described));
  await validateCompilerArtifact(emptyWasm, manifest, {
    hostAbi: COMPILER_HOST_ABI_VERSION,
    preludeSha256: prelude,
    compilerInputsSha256: inputs,
    profile: "production",
  });

  await assertRejects(
    () =>
      validateCompilerArtifact(
        emptyWasm,
        { ...manifest, profile: "development-profile" },
        { profile: "production" },
      ),
    Error,
    "profile is development-profile, expected production",
  );
  await assertRejects(
    () =>
      validateCompilerArtifact(emptyWasm, manifest, {
        profile: "development-profile",
      }),
    Error,
    "profile is production, expected development-profile",
  );

  await assertRejects(
    () =>
      validateCompilerArtifact(emptyWasm, manifest, {
        compilerInputsSha256: "5".repeat(64),
      }),
    Error,
    "inputs do not match",
  );
  const changed = emptyWasm.slice();
  changed[7] = 1;
  await assertRejects(
    () => validateCompilerArtifact(changed, manifest, {}),
    Error,
    "valid WebAssembly",
  );
});
