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

const ACCEPTED = [
  "examples",
  "examples/lib",
  "src/prelude",
];
const REJECTED = "examples/rejected/syntax";
const GRAMMAR = "tree-sitter-blot";

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
    const compiler = frontend.ingest(await Deno.readTextFile(path)).ok;
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
  const compiler = frontend.ingest(await Deno.readTextFile(path)).ok;
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

if (disagreements > 0) {
  console.error(
    `\n${disagreements} disagreement(s). The editor grammar is lying about the language.`,
  );
  Deno.exit(1);
}
console.log("\nThe editor grammar and the compiler agree.");
