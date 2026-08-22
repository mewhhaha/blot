import { CompilerWasm } from "../src/compiler/wasm.ts";

const crateRoot = new URL("../compiler/", import.meta.url);
const artifact = new URL(
  "./target/wasm32-unknown-unknown/release/blot_compiler.wasm",
  crateRoot,
);
const published = new URL(
  "../generated/compiler/compiler.wasm",
  import.meta.url,
);
const prelude = new URL("../src/prelude/prelude.blot", import.meta.url);
const preludeSnapshot = new URL(
  "../generated/compiler/prelude.snapshot",
  import.meta.url,
);

await buildCompilerWasm();
const bytes = await Deno.readFile(artifact);
const preludeSource = await Deno.readTextFile(prelude);
const rust = await CompilerWasm.load(bytes);
const session = rust.createCompilerSession();
const snapshotPath = "snapshot:prelude";
let expectedSnapshot: Uint8Array;
try {
  const added = rust.addCompilerSessionModule(
    session,
    snapshotPath,
    preludeSource,
  );
  if (!added.ok) {
    let message = added.message;
    if (message === undefined) {
      message = "the Rust frontend rejected the prelude";
    }
    throw new Error(message);
  }
  if (added.module.imports.length > 0 || added.module.includes.length > 0) {
    throw new Error("the distributed prelude snapshot must be dependency-free");
  }
  rust.configureCompilerSessionModule(session, snapshotPath, {
    imports: {},
    includes: {},
  });
  expectedSnapshot = rust.exportCompilerSessionModuleSnapshot(
    session,
    snapshotPath,
  );
} finally {
  rust.destroyCompilerSession(session);
}

await Deno.mkdir(new URL("../generated/compiler/", import.meta.url), {
  recursive: true,
});

if (Deno.args.includes("--check")) {
  let currentSnapshot: Uint8Array;
  try {
    currentSnapshot = await Deno.readFile(preludeSnapshot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "generated/compiler/prelude.snapshot is missing; run `pnpm compiler:build`",
      );
    }
    throw error;
  }
  if (!bytesEqual(currentSnapshot, expectedSnapshot)) {
    throw new Error(
      "generated/compiler/prelude.snapshot is stale; run `pnpm compiler:build`",
    );
  }
} else {
  await Deno.writeFile(preludeSnapshot, expectedSnapshot);
}
await Deno.writeFile(published, bytes);
await import("./package_compiler_artifact.ts");

/**
 * Builds the compiler Wasm with every machine-specific path remapped out of it.
 *
 * A dependency's panic locations reach the binary as literal source paths, so
 * without this the artifact records the registry directory it was built from.
 * The remapped names are arbitrary; what matters is that they are the same
 * everywhere. CI records the resulting artifact's digest and source tree; local
 * builds use the repository's pinned Rust release.
 */
async function buildCompilerWasm(): Promise<void> {
  let home = Deno.env.get("CARGO_HOME");
  if (home === undefined) {
    const userHome = Deno.env.get("HOME");
    if (userHome === undefined) {
      throw new Error("Rust middle Wasm build requires CARGO_HOME or HOME");
    }
    home = `${userHome}/.cargo`;
  }
  const build = await new Deno.Command("cargo", {
    args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
    cwd: crateRoot,
    env: {
      RUSTFLAGS: [
        `--remap-path-prefix=${home}=/cargo`,
        `--remap-path-prefix=${new URL(".", crateRoot).pathname}=/crate`,
      ].join(" "),
    },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) throw new Error("Rust middle Wasm build failed");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}
