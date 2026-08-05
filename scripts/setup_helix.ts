// Installs blot into Helix: the Tree-sitter grammar, the queries, and the
// `.blot` file association.
//
// Everything it writes to `languages.toml` lives between two markers naming
// this checkout, so re-running replaces the block rather than appending a
// second copy, and removing blot means deleting one delimited region.
//
// The grammar is generated from the same `grammar.baba` as the GPU parser. It
// is a second *target*, not a second grammar: if the two ever disagree, the
// editor is lying about the language.

import { dirname, fromFileUrl, join } from "@std/path";

const repository = dirname(fromFileUrl(new URL("../", import.meta.url) + "x"));
const grammarDirectory = join(repository, "tree-sitter-blot");

const home = Deno.env.get("HOME");
if (home === undefined) throw new Error("HOME is not set");

const configHome = Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config");
const helix = join(configHome, "helix");
const languagesPath = join(helix, "languages.toml");
const queryTarget = join(helix, "runtime", "queries", "blot");
const grammarTarget = join(
  helix,
  "runtime",
  "grammars",
  `blot.${libraryExtension()}`,
);

const beginMarker = `# >>> blot (managed by ${repository}) >>>`;
const endMarker = `# <<< blot (managed by ${repository}) <<<`;

function libraryExtension(): string {
  if (Deno.build.os === "linux") return "so";
  if (Deno.build.os === "darwin") return "dylib";
  if (Deno.build.os === "windows") return "dll";
  throw new Error(`Unsupported operating system: ${Deno.build.os}`);
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed`);
  }
}

// --- 1. generate the Tree-sitter target -------------------------------------

// baba refuses to overwrite a generated file that has been modified, and the
// `reserved` patch below makes `grammar.js` exactly that, so the directory is
// rebuilt from scratch each time.
await Deno.remove(grammarDirectory, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(grammarDirectory, { recursive: true });

await runCommand("deno", [
  "run",
  "--allow-read",
  "--allow-write",
  "@mewhhaha/baba/cli",
  "grammar.baba",
  "--out",
  grammarDirectory,
  "--name",
  "blot",
  "--root",
  "program",
  "--metadata",
  "baba.json",
  "--target",
  "tree-sitter",
], repository);

// baba's tree-sitter target does not reserve tokens against broader lexical
// rules, and tree-sitter's lexer is context-dependent by design. In a state
// where `IDENT` is admissible but `"return"` is not, it lexes `return` as an
// identifier, so `let x = 1 return x;` parses cleanly as juxtaposition. The same
// fallback lets OPERATOR consume structural `=` and `=>` outside the rules
// that use them. The wasm parser and the GPU frontend reserve both globally, so
// without this the editor grammar would disagree with the compiler.
//
// `word:` alone does not fix it — extraction still falls back to the word token.
// A global `reserved` set does. Field names keep working, because `.return`
// matches the reserved keyword token and `field_name` admits `keyword`.
//
// `scripts/check_grammar.ts` proves the two agree; it is the reason to trust
// this patch rather than the patch itself.
const RESERVED_TOKENS = [
  "module",
  "operators",
  "infixl",
  "infixr",
  "infix",
  "prefix",
  "let",
  "const",
  "sig",
  "return",
  "do",
  "end",
  "if",
  "then",
  "else",
  "case",
  "of",
  "rec",
  "comptime",
  "open",
  "for",
  "in",
  "break",
  "try",
  "with",
  "fn",
  "=",
  "=>",
];

const grammarJsPath = join(grammarDirectory, "grammar.js");
const grammarJs = await Deno.readTextFile(grammarJsPath);
const anchor = `name: "blot",`;
const at = grammarJs.indexOf(anchor);
if (at < 0) {
  throw new Error("grammar.js has no `name:` declaration to anchor to");
}
const cut = at + anchor.length;
const spelled = RESERVED_TOKENS.map((token) => `"${token}"`).join(", ");
await Deno.writeTextFile(
  grammarJsPath,
  `${grammarJs.slice(0, cut)}

  // Keywords and structural operators are globally reserved, matching the wasm
  // parser and the GPU frontend. Without this tree-sitter would accept programs
  // the compiler does not, because its lexer resolves tokens by parser state.
  word: $ => $.IDENT,
  reserved: {
    global: _ => [${spelled}],
  },
${grammarJs.slice(cut)}`,
);

await Deno.writeTextFile(
  join(grammarDirectory, "tree-sitter.json"),
  `${
    JSON.stringify(
      {
        grammars: [{
          name: "blot",
          camelcase: "Blot",
          scope: "source.blot",
          path: ".",
          "file-types": ["blot"],
          highlights: "queries/highlights.scm",
        }],
        metadata: {
          version: "0.1.0",
          license: "MIT",
          description: "Tree-sitter grammar for blot source files.",
        },
      },
      null,
      2,
    )
  }\n`,
);

await runCommand("tree-sitter", ["generate"], grammarDirectory);

// --- 2. assemble the queries ------------------------------------------------
//
// baba's generated highlights cover token classes and punctuation. Keywords are
// anonymous nodes, which its metadata cannot express, so the hand-written
// fragment is appended rather than replacing anything.

const generatedQueries = join(grammarDirectory, "queries");
const repositoryQueries = join(repository, "queries");

const highlights = [
  await Deno.readTextFile(join(generatedQueries, "generated-highlights.scm")),
  await Deno.readTextFile(join(repositoryQueries, "keywords.scm")),
  await Deno.readTextFile(join(repositoryQueries, "elements.scm")),
  await Deno.readTextFile(join(repositoryQueries, "calls.scm")),
].join("\n");

await Deno.mkdir(generatedQueries, { recursive: true });
await Deno.writeTextFile(join(generatedQueries, "highlights.scm"), highlights);

await Deno.mkdir(queryTarget, { recursive: true });
await Deno.writeTextFile(join(queryTarget, "highlights.scm"), highlights);
await Deno.copyFile(
  join(generatedQueries, "generated-rainbows.scm"),
  join(queryTarget, "rainbows.scm"),
);
for (const name of ["indents.scm", "textobjects.scm", "tags.scm"]) {
  await Deno.copyFile(join(repositoryQueries, name), join(queryTarget, name));
}

// --- 3. build the grammar ---------------------------------------------------

await Deno.mkdir(dirname(grammarTarget), { recursive: true });
await runCommand("tree-sitter", [
  "build",
  "--output",
  grammarTarget,
  grammarDirectory,
]);

// --- 4. register the language ----------------------------------------------

let languages = "";
try {
  languages = await Deno.readTextFile(languagesPath);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

const start = languages.indexOf(beginMarker);
if (start >= 0) {
  const end = languages.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(
      `${languagesPath} has a blot block with no closing marker; remove it by hand and re-run.`,
    );
  }
  languages = languages.slice(0, start) +
    languages.slice(end + endMarker.length);
}

const block = `${beginMarker}
[language-server.blot]
command = "deno"
args = ["run", "--allow-read", "${join(repository, "src", "cli.ts")}", "lsp"]

[[language]]
name = "blot"
language-id = "blot"
scope = "source.blot"
injection-regex = "^blot$"
file-types = ["blot"]
roots = ["AGENTS.md", "deno.json", ".git"]
comment-token = "//"
grammar = "blot"
language-servers = ["blot"]
rainbow-brackets = true
indent = { tab-width = 2, unit = "  " }

[[grammar]]
name = "blot"
source = { path = "${grammarDirectory}" }
${endMarker}
`;

await Deno.mkdir(helix, { recursive: true });
await Deno.writeTextFile(languagesPath, `${languages.trimEnd()}\n\n${block}`);

console.log(`Registered blot in ${languagesPath} (file-types = ["blot"])`);
console.log(`Installed queries in ${queryTarget}`);
console.log(`Built grammar at ${grammarTarget}`);
console.log("Check it with: hx --health blot");
