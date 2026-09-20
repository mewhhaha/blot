// Migrate legacy Blot annotation tokens using Baba's lexer, not textual replacement.
// This command is for old source where `::` was reserved for type annotations.
import { babaRuntime } from "../src/syntax/baba_runtime.ts";

export async function migrateTypeAnnotations(source: string): Promise<string> {
  const lexer = (await babaRuntime()).wasmLexer;
  const lexed = lexer.lex(source, { preserveTrivia: true });
  if (lexed.diagnostics.length > 0) {
    throw new Error("Cannot migrate a source with lexer diagnostics.");
  }
  const edits: { start: number; end: number }[] = [];
  for (let index = 0; index < lexed.tokenTape.length; index += 1) {
    const token = lexed.tokenTape.token(index);
    if (token === undefined) throw new Error(`Baba omitted token ${index}.`);
    if (token.channel !== "main" || token.text !== "::") continue;
    let start = token.span.start;
    while (
      start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")
    ) {
      start -= 1;
    }
    edits.push({ start, end: token.span.end });
  }
  for (const edit of edits.reverse()) {
    source = source.slice(0, edit.start) + ":" + source.slice(edit.end);
  }
  return source;
}

if (import.meta.main) {
  const write = Deno.args.includes("--write");
  const paths = Deno.args.filter((arg) => arg !== "--write");
  if (
    paths.length === 0 ||
    paths.some((path) => path.startsWith("-") || !path.endsWith(".blot"))
  ) {
    throw new Error(
      "Usage: migrate_type_annotations.ts [--write] file.blot ...",
    );
  }
  // Validate and compute every requested edit before writing any file.
  const changes: { path: string; source: string }[] = [];
  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const migrated = await migrateTypeAnnotations(source);
    if (migrated !== source) changes.push({ path, source: migrated });
  }
  for (const change of changes) {
    if (write) await Deno.writeTextFile(change.path, change.source);
    console.log(change.path);
  }
  if (!write && changes.length > 0) Deno.exitCode = 1;
}
