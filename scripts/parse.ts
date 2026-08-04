// Parses a blot source file and reports diagnostics.
//
// Uses the same Baba CPU frontend and CST lowering as every compiler command,
// so syntax and semantic tooling need no WebGPU adapter.

import { dispose, parse } from "../src/syntax/parse.ts";

const sourcePath = Deno.args[0];
if (sourcePath === undefined) {
  console.error("Expected a blot source path.");
  Deno.exit(1);
}

const source = await Deno.readTextFile(sourcePath);
try {
  const result = await parse(source);
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
    `${sourcePath}: accepted, ${result.module.declarations.length} declarations.`,
  );
} finally {
  dispose();
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
