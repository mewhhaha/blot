import { Compiler } from "../src/compiler/session.ts";
import { locate } from "../src/diagnostic.ts";
import { DEFAULT_LINT_RULES, lintModule } from "../src/tooling/lint.ts";

interface AuditFinding {
  readonly path: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
  readonly fixable: boolean;
}

const excludedDirectories = new Set(["pending", "rejected", "traps"]);
const files: string[] = [];
await collectBlotFiles("examples", files);
await collectBlotFiles("case-studies", files);
files.sort();

const compiler = await Compiler.create();
const findings: AuditFinding[] = [];
try {
  for (const path of files) {
    const source = await Deno.readTextFile(path);
    try {
      const analysis = await compiler.analyze(path);
      const syntax = await compiler.syntaxSnapshot(path, source);
      const diagnostics = lintModule(
        syntax.module,
        source,
        syntax.cst,
        DEFAULT_LINT_RULES,
        {
          specializations: analysis.specializations,
          simplifications: analysis.simplifications,
          readability: analysis.readability,
        },
      );
      for (const diagnostic of diagnostics) {
        const position = locate(source, diagnostic.span.start);
        findings.push({
          path,
          offset: diagnostic.span.start,
          line: position.line,
          column: position.column,
          code: diagnostic.code,
          message: diagnostic.message,
          fixable: diagnostic.fix !== null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`lint audit could not analyze ${path}: ${message}`, {
        cause: error,
      });
    }
  }
} finally {
  compiler.destroy();
}

findings.sort((left, right) => {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  if (left.offset !== right.offset) return left.offset - right.offset;
  return left.code.localeCompare(right.code);
});

for (const finding of findings) {
  let action = "";
  if (finding.fixable) action = " [fix]";
  console.log(
    `${finding.path}:${finding.line}:${finding.column}: ${finding.code}: ${finding.message}${action}`,
  );
}

const counts = new Map<string, number>();
for (const finding of findings) {
  const previous = counts.get(finding.code);
  if (previous === undefined) counts.set(finding.code, 1);
  else counts.set(finding.code, previous + 1);
}
console.log(`\n${findings.length} findings in ${files.length} accepted files`);
for (
  const [code, count] of [...counts].sort((left, right) =>
    left[0].localeCompare(right[0])
  )
) {
  console.log(`${code}: ${count}`);
}

async function collectBlotFiles(
  root: string,
  collected: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      if (!excludedDirectories.has(entry.name)) {
        await collectBlotFiles(path, collected);
      }
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".blot")) collected.push(path);
  }
}
