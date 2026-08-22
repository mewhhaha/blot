import { relative } from "@std/path";
import { sha256 } from "../src/compiler/artifact.ts";

const repository = new URL("../", import.meta.url);

export async function compilerInputIdentity(): Promise<string> {
  const files = [
    new URL("../rust-toolchain.toml", import.meta.url),
    new URL("../compiler/Cargo.toml", import.meta.url),
    new URL("../compiler/Cargo.lock", import.meta.url),
    new URL("../src/compiler/host_abi.ts", import.meta.url),
  ];
  await collectRustSources(new URL("../compiler/src/", import.meta.url), files);
  files.sort((left, right) => left.pathname.localeCompare(right.pathname));
  const parts: Uint8Array[] = [];
  let length = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const path = relative(repository.pathname, file.pathname).replaceAll(
      "\\",
      "/",
    );
    const bytes = await Deno.readFile(file);
    const header = encoder.encode(`${path}\0${bytes.byteLength}\0`);
    parts.push(header, bytes);
    length += header.byteLength + bytes.byteLength;
  }
  const input = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.byteLength;
  }
  return await sha256(input);
}

async function collectRustSources(
  directory: URL,
  files: URL[],
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const target = new URL(entry.name, directory);
    if (entry.isDirectory) {
      await collectRustSources(new URL(`${entry.name}/`, directory), files);
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".rs")) files.push(target);
  }
}
