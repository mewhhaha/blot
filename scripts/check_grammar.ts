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
import { ingestCpuSource } from "../src/syntax/cpu_ingest.ts";

const ACCEPTED = [
  "examples",
  "examples/lib",
  "src/prelude",
  "editor",
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
      ingestCpuSource(frontend, elaborated.layout.source).ok;
    const editor = await treeSitterAccepts(`../${path}`);
    if (!compiler || !editor) {
      disagreements += 1;
      console.error(
        `${path}: expected both to accept; compiler accepted: ${compiler}, editor accepted: ${editor}`,
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
    ingestCpuSource(frontend, elaborated.layout.source).ok;
  const editor = await treeSitterAccepts(`../${path}`);
  if (compiler || editor) {
    disagreements += 1;
    console.error(
      `${path}: expected both to reject; compiler accepted: ${compiler}, editor accepted: ${editor}`,
    );
    continue;
  }
  console.log(`${basename(path)}: both reject`);
}

const highlightCaptures = await treeSitterCaptures(`../${HIGHLIGHT_FIXTURE}`);
const highlightSource = await Deno.readTextFile(HIGHLIGHT_FIXTURE);
const expectations = [
  ["const Number", "Number", "variable"],
  ["let transform", "transform", "function"],
  ["fn value =>", "value", "variable.parameter"],
  ["fn (left, right)", "left", "variable.parameter"],
  ["fn (left, right)", "right", "variable.parameter"],
  [".count = amount", "amount", "variable.parameter"],
  ["fn !owned", "!", "keyword.storage.modifier"],
  ["fn ~later", "~", "keyword.storage.modifier"],
  ["fn ?once", "?", "keyword.storage.modifier"],
  ["fn &shared", "&", "keyword.storage.modifier"],
  ["for case #Some", "for", "keyword.control.repeat"],
  ["for case #Some", "case", "keyword.control.conditional"],
  ["for case #Some", "Some", "constructor"],
  ["Iter.items options", "items", "function.call"],
  ["      continue", "continue", "keyword.control.repeat"],
  ["      break", "break", "keyword.control.return"],
  ["value if value", "if", "keyword.control.conditional"],
  ["case option of", "case", "keyword.control.conditional"],
  ["case option of", "of", "keyword.control.conditional"],
  ["use record.use", "use", "keyword.control"],
  ["transform 2", "transform", "function.call"],
  ["@int.add 1 2", "@int.add", "function.builtin"],
  [
    '"return fn #Some // not a comment"',
    '"return fn #Some // not a comment"',
    "string",
  ],
] as const;
for (const [context, spelling, name] of expectations) {
  const start = highlightSource.indexOf(context);
  if (start < 0 || highlightSource.indexOf(context, start + 1) >= 0) {
    throw new Error(`Highlight context must occur once: ${context}`);
  }
  const offset = start + context.indexOf(spelling);
  const before = highlightSource.slice(0, offset);
  const row = before.split("\n").length - 1;
  const column = offset - before.lastIndexOf("\n") - 1;
  if (
    !highlightCaptures.some((capture) =>
      capture.row === row && capture.column === column &&
      capture.text === spelling && capture.name === name
    )
  ) {
    disagreements += 1;
    console.error(
      `${HIGHLIGHT_FIXTURE}:${row + 1}:${
        column + 1
      }: expected ${spelling} as ${name}`,
    );
  }
}
for (
  const match of highlightSource.matchAll(
    /\.(use|return|case|const|continue)\b/g,
  )
) {
  const offset = match.index + 1;
  const before = highlightSource.slice(0, offset);
  const row = before.split("\n").length - 1;
  const column = offset - before.lastIndexOf("\n") - 1;
  const captures = highlightCaptures.filter((capture) =>
    capture.row === row && capture.column === column
  );
  if (
    !captures.some((capture) => capture.name === "variable.other.member") ||
    captures.some((capture) =>
      capture.name.startsWith("keyword") || capture.name === "function.call"
    )
  ) {
    disagreements += 1;
    console.error(
      `${HIGHLIGHT_FIXTURE}:${row + 1}: .${match[1]} must remain a member`,
    );
  }
}
console.log(
  `${
    basename(HIGHLIGHT_FIXTURE)
  }: checked ${expectations.length} highlight roles and keyword-shaped members`,
);

if (disagreements > 0) {
  console.error(
    `\n${disagreements} disagreement(s). The editor grammar is lying about the language.`,
  );
  Deno.exit(1);
}
console.log("\nThe editor grammar and the compiler agree.");
