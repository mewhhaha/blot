import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { render } from "../src/diagnostic.ts";
import { formatSource } from "../src/tooling/formatter.ts";

const paths = new Set<string>();
let write = false;
const arguments_ = process.argv.slice(2);
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === "--check" || argument === "--") continue;
  if (argument === "--write") {
    write = true;
    continue;
  }
  if (argument === "--base") {
    const base = arguments_[index + 1];
    if (base === undefined) throw new Error("--base requires a Git revision.");
    index += 1;
    const changed = execFileSync("git", [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      base,
      "--",
      "*.blot",
    ], { encoding: "utf8" });
    for (const path of changed.split("\0")) {
      if (
        (path.startsWith("examples/") || path.startsWith("src/prelude/") ||
          path.startsWith("case-studies/")) &&
        !path.startsWith("examples/rejected/syntax/")
      ) paths.add(path);
    }
    continue;
  }
  if (argument.startsWith("--")) {
    throw new Error(`Unknown format option: ${argument}`);
  }
  paths.add(argument);
}

if (arguments_.length === 0) {
  throw new Error(
    "Usage: format_blot.ts [--check | --write] [--base REV] PATH...",
  );
}

let failures = 0;
let changed = 0;
for (const path of [...paths].sort()) {
  const source = await readFile(path, "utf8");
  const formatted = await formatSource(source);
  if (!formatted.ok) {
    for (const diagnostic of formatted.diagnostics) {
      console.error(render(path, source, diagnostic));
    }
    failures += 1;
    continue;
  }
  if (formatted.source === source) continue;
  changed += 1;
  if (write) {
    await writeFile(path, formatted.source);
    console.log(`Formatted ${path}`);
  } else {
    console.error(`${path}: run pnpm format -- ${path}`);
    failures += 1;
  }
}
console.log(
  `Checked ${paths.size} Blot files; ${changed} required formatting.`,
);
if (failures > 0) process.exitCode = 1;
