// Parses a blot source file and reports diagnostics.
//
// Defaults to baba's CPU path, which is the byte-parity oracle for the GPU
// frontend and needs no WebGPU adapter. `blot check` will use the same entry
// point, which is what keeps syntax and semantic tooling off the device.

import { createParser } from "../generated/wasm/mod.ts";

const sourcePath = Deno.args[0];
if (sourcePath === undefined) {
  console.error("Expected a blot source path.");
  Deno.exit(1);
}

const source = await Deno.readTextFile(sourcePath);
const parser = createParser({
  bytes: await Deno.readFile("generated/wasm/parser.wasm"),
  plan: await Deno.readFile("generated/wasm/parser.plan"),
});

try {
  const result = parser.parse(source);
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) {
      const { line, column } = locate(source, diagnostic.span.start);
      console.error(
        `${sourcePath}:${line}:${column}: ${diagnostic.code}: ${diagnostic.message}`,
      );
    }
    Deno.exit(1);
  }
  console.log(
    `${sourcePath}: accepted, ${result.cursor.children().length} top-level nodes.`,
  );
} finally {
  parser.dispose();
}

function locate(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
