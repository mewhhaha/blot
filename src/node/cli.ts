#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Compiler } from "../compiler.ts";
import { BlotError, render } from "../diagnostic.ts";
import { LoadError } from "../load.ts";
import { parse } from "../syntax/parse.ts";

const [command, ...paths] = process.argv.slice(2);
if (
  command === undefined ||
  paths.length === 0 ||
  !["build", "check", "ast"].includes(command)
) {
  console.error("usage: pnpm blot <build|check|ast> <path>...");
  process.exitCode = 2;
} else {
  const compiler = await Compiler.create();
  let failed = false;
  try {
    for (const path of paths) {
      try {
        if (command === "build") {
          const artifact = await compiler.compile(path);
          const output = path.replace(/\.blot$/, ".wasm");
          const manifest = `${output}.json`;
          await writeFile(output, artifact.wasm);
          await writeFile(manifest, artifact.manifestBytes);
          const imports = artifact.capabilities.length === 0
            ? ""
            : `, imports { ${artifact.capabilities.join(", ")} }`;
          console.log(
            `${output}: ${artifact.wasm.byteLength} bytes${imports}, manifest ${manifest}`,
          );
        } else if (command === "check") {
          const checked = await compiler.check(path);
          console.log(`${path}: ${checked.type}${checked.effects}`);
        } else {
          const source = await import("node:fs/promises").then((fs) =>
            fs.readFile(resolve(path), "utf8")
          );
          const parsed = await parse(source);
          if (!parsed.ok) {
            for (const diagnostic of parsed.diagnostics) {
              console.error(render(path, source, diagnostic));
            }
            failed = true;
            continue;
          }
          console.log(JSON.stringify(
            parsed.module,
            (_key, value) => typeof value === "bigint" ? `${value}n` : value,
            2,
          ));
        }
      } catch (error) {
        failed = true;
        report(path, error);
      }
    }
  } finally {
    compiler.destroy();
  }
  if (failed) process.exitCode = 1;
}

function report(path: string, error: unknown): void {
  if (error instanceof LoadError) {
    console.error(error.message);
    return;
  }
  if (error instanceof BlotError && error.origin !== null) {
    console.error(
      render(error.origin.path, error.origin.source, error.diagnostic),
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${path}: ${message}`);
}
