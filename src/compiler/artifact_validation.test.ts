import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCompilerArtifactManifest,
  describeCompilerArtifact,
  sha256,
  verifyCompilerArtifactIntegrity,
} from "./artifact.ts";

const emptyWasm = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const manifest = await describeCompilerArtifact(
  emptyWasm,
  "1".repeat(40),
  "2".repeat(64),
  "rustc 1.97.1",
  "3".repeat(64),
  "4".repeat(64),
  "production",
);

test("integrity verification accepts a complete version-one header", async () => {
  await verifyCompilerArtifactIntegrity(emptyWasm, manifest, {});
  assert.deepEqual(
    decodeCompilerArtifactManifest(JSON.stringify(manifest)),
    manifest,
  );
});

for (let index = 4; index < 8; index += 1) {
  test(`integrity verification checks binary version byte ${index}`, async () => {
    const changed = emptyWasm.slice();
    changed[index] ^= 1;
    // Match the digest deliberately: this is a format failure, not corruption.
    const matching = { ...manifest, sha256: await sha256(changed) };
    await assert.rejects(
      verifyCompilerArtifactIntegrity(changed, matching, {}),
      /unsupported binary version/,
    );
  });
}

test("integrity verification rejects truncated headers and wrong magic", async () => {
  for (let length = 0; length < 8; length += 1) {
    const changed = emptyWasm.slice(0, length);
    await assert.rejects(
      verifyCompilerArtifactIntegrity(changed, {
        ...manifest,
        bytes: changed.length,
        sha256: await sha256(changed),
      }, {}),
      /no WebAssembly header/,
    );
  }
  for (let index = 0; index < 4; index += 1) {
    const changed = emptyWasm.slice();
    changed[index] ^= 1;
    await assert.rejects(
      verifyCompilerArtifactIntegrity(changed, {
        ...manifest,
        sha256: await sha256(changed),
      }, {}),
      /no WebAssembly header/,
    );
  }
});

test("Git object identities have exactly 40 or 64 hex digits", async () => {
  for (const field of ["sourceCommit", "sourceTree"] as const) {
    for (const length of [0, 39, 41, 48, 63, 65]) {
      const identity = "a".repeat(length);
      const encoded = JSON.stringify({ ...manifest, [field]: identity });
      assert.throws(
        () => decodeCompilerArtifactManifest(encoded),
        /invalid source (commit|tree)/,
      );
      let commit = manifest.sourceCommit;
      let tree = manifest.sourceTree;
      if (field === "sourceCommit") commit = identity;
      else tree = identity;
      await assert.rejects(
        describeCompilerArtifact(
          emptyWasm,
          commit,
          tree,
          manifest.rustc,
          manifest.preludeSha256,
          manifest.compilerInputsSha256,
          "production",
        ),
        /invalid source (commit|tree)/,
      );
    }
    for (const length of [40, 64]) {
      const value = { ...manifest, [field]: "a".repeat(length) };
      assert.deepEqual(
        decodeCompilerArtifactManifest(JSON.stringify(value)),
        value,
      );
    }
  }
});
