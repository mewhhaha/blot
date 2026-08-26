// Does the editor grammar agree with the compiler about what blot is?
//
// `tree-sitter-blot/` and `generated/wasm/` come from the same `grammar.baba`,
// but through different targets, and the targets do not make the same lexical
// choices. baba's tree-sitter output carries no `word:` declaration, so without
// the patch in `setup_helix.ts` tree-sitter does not reserve keywords and
// accepts `let x = 1 return x;` as juxtaposition. Nothing in generation catches
// that; this does.
//
// Run it after `just install`. It needs the `tree-sitter` CLI on PATH.

import { basename } from "@std/path";
import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import { elaborateLayout } from "../src/syntax/layout.ts";

const ACCEPTED = [
  "examples",
  "examples/lib",
  "src/prelude",
];
const REJECTED = "examples/rejected/syntax";
const GRAMMAR = "tree-sitter-blot";
const HIGHLIGHT_FIXTURE = "editor/highlights.blot";

interface HighlightCapture {
  name: string;
  text: string;
  row: number;
  column: number;
}

const frontend = CpuFrontend.create(
  await Deno.readFile("generated/wasm/parser.plan"),
);

async function treeSitterAccepts(path: string): Promise<boolean> {
  const status = await new Deno.Command("tree-sitter", {
    args: ["parse", "-q", path],
    cwd: GRAMMAR,
    stdout: "null",
    stderr: "null",
  }).spawn().status;
  return status.success;
}

async function treeSitterCaptures(path: string): Promise<HighlightCapture[]> {
  const output = await new Deno.Command("tree-sitter", {
    args: [
      "query",
      "--grammar-path",
      ".",
      "--captures",
      "queries/highlights.scm",
      path,
    ],
    cwd: GRAMMAR,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`tree-sitter could not highlight ${path}: ${error}`);
  }

  const captures: HighlightCapture[] = [];
  const capturePattern =
    /capture: \d+ - ([^,]+), start: \((\d+), (\d+)\),.*text: `([^`]*)`/g;
  const captureOutput = new TextDecoder().decode(output.stdout);
  for (const match of captureOutput.matchAll(capturePattern)) {
    captures.push({
      name: match[1],
      row: Number(match[2]),
      column: Number(match[3]),
      text: match[4],
    });
  }
  return captures;
}

async function blotFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".blot")) {
      found.push(`${directory}/${entry.name}`);
    }
  }
  return found.sort();
}

let disagreements = 0;

for (const directory of ACCEPTED) {
  for (const path of await blotFiles(directory)) {
    const source = await Deno.readTextFile(path);
    const elaborated = await elaborateLayout(source);
    const compiler = elaborated.ok &&
      frontend.ingest(elaborated.layout.source).ok;
    const editor = await treeSitterAccepts(`../${path}`);
    if (compiler !== editor) {
      disagreements += 1;
      console.error(
        `${path}: compiler ${compiler ? "accepts" : "rejects"}, editor ${
          editor ? "accepts" : "rejects"
        }`,
      );
      continue;
    }
    console.log(`${basename(path)}: both accept`);
  }
}

for (const path of await blotFiles(REJECTED)) {
  const source = await Deno.readTextFile(path);
  const elaborated = await elaborateLayout(source);
  const compiler = elaborated.ok &&
    frontend.ingest(elaborated.layout.source).ok;
  const editor = await treeSitterAccepts(`../${path}`);
  if (compiler || editor) {
    disagreements += 1;
    console.error(
      `${path}: expected both to reject, compiler ${
        compiler ? "accepted" : "rejected"
      }, editor ${editor ? "accepted" : "rejected"}`,
    );
    continue;
  }
  console.log(`${basename(path)}: both reject`);
}

const highlightCaptures = await treeSitterCaptures(`../${HIGHLIGHT_FIXTURE}`);
const keywordUses = highlightCaptures.filter((capture) =>
  capture.name === "keyword.control" && capture.text === "use"
);
const memberUses = highlightCaptures.filter((capture) =>
  capture.name === "variable.other.member" && capture.text === "use"
);
const memberUsePositions = new Set(
  memberUses.map((capture) => `${capture.row}:${capture.column}`),
);
if (keywordUses.length !== 1 || memberUsePositions.size !== 3) {
  disagreements += 1;
  console.error(
    `${HIGHLIGHT_FIXTURE}: expected one keyword and three member positions for ` +
      `"use", found ${keywordUses.length} keyword and ${memberUsePositions.size} member`,
  );
} else {
  console.log(`${basename(HIGHLIGHT_FIXTURE)}: use highlighting is scoped`);
}

if (disagreements > 0) {
  console.error(
    `\n${disagreements} disagreement(s). The editor grammar is lying about the language.`,
  );
  Deno.exit(1);
}
console.log("\nThe editor grammar and the compiler agree.");
