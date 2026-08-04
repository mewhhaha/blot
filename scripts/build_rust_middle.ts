const crateRoot = new URL("../experiments/rust-middle/", import.meta.url);
const artifact = new URL(
  "./target/wasm32-unknown-unknown/release/blot_rust_middle.wasm",
  crateRoot,
);
const published = new URL(
  "../generated/rust-middle/compiler.wasm",
  import.meta.url,
);

const build = await new Deno.Command("cargo", {
  args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
  cwd: crateRoot,
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!build.success) throw new Error("Rust middle Wasm build failed");

const bytes = await Deno.readFile(artifact);
if (Deno.args.includes("--check")) {
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
  await Deno.writeFile(published, bytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}
