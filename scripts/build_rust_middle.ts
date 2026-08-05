import { RustMiddle } from "../src/backend/rust_middle_wasm.ts";
import { elaborateLayout } from "../src/syntax/layout.ts";

const crateRoot = new URL("../experiments/rust-middle/", import.meta.url);
const artifact = new URL(
  "./target/wasm32-unknown-unknown/release/blot_rust_middle.wasm",
  crateRoot,
);
const published = new URL(
  "../generated/rust-middle/compiler.wasm",
  import.meta.url,
);
const prelude = new URL("../src/prelude/prelude.blot", import.meta.url);
const preludeSnapshot = new URL(
  "../generated/rust-middle/prelude.snapshot",
  import.meta.url,
);

await buildRustMiddle();
const bytes = await Deno.readFile(artifact);
const preludeSource = await Deno.readTextFile(prelude);
const preludeLayout = await elaborateLayout(preludeSource);
if (!preludeLayout.ok) {
  throw new Error("layout elaboration rejected the prelude");
}
const rust = await RustMiddle.load(bytes);
const session = rust.createCompilerSession();
const snapshotPath = "snapshot:prelude";
let expectedSnapshot: Uint8Array;
try {
  const added = rust.addCompilerSessionModule(
    session,
    snapshotPath,
    preludeLayout.layout.source,
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

if (Deno.args.includes("--check")) {
  let currentSnapshot: Uint8Array;
  try {
    currentSnapshot = await Deno.readFile(preludeSnapshot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "generated/rust-middle/prelude.snapshot is missing; run `deno task build:rust-middle`",
      );
    }
    throw error;
  }
  if (!bytesEqual(currentSnapshot, expectedSnapshot)) {
    throw new Error(
      "generated/rust-middle/prelude.snapshot is stale; run `deno task build:rust-middle`",
    );
  }
  let checked: Uint8Array;
  try {
    checked = await Deno.readFile(published);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "generated/rust-middle/compiler.wasm is missing; run `deno task build:rust-middle`",
      );
    }
    throw error;
  }
  if (!bytesEqual(bytes, checked)) {
    throw new Error(
      "generated/rust-middle/compiler.wasm is stale; run `deno task build:rust-middle`",
    );
  }
} else {
  await Deno.mkdir(new URL("../generated/rust-middle/", import.meta.url), {
    recursive: true,
  });
  await Deno.writeFile(preludeSnapshot, expectedSnapshot);
  await Deno.writeFile(published, bytes);
}

async function buildRustMiddle(): Promise<void> {
  const build = await new Deno.Command("cargo", {
    args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
    cwd: crateRoot,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) throw new Error("Rust middle Wasm build failed");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}
