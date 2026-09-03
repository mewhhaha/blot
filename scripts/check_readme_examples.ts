import { toFileUrl } from "@std/path";
import { babaRuntime } from "../src/syntax/baba_runtime.ts";
import { elaborateLayout } from "../src/syntax/layout.ts";
import { ingestCpuSource } from "../src/syntax/cpu_ingest.ts";
import { dispose } from "../src/syntax/parse.ts";

type ExampleLanguage = "bash" | "blot" | "json" | "ts";

interface ReadmeExample {
  readonly language: ExampleLanguage;
  readonly source: string;
  readonly firstLine: number;
}

const readmePath = "README.md";
const readme = await Deno.readTextFile(readmePath);
const examples = readmeExamples(readme);

try {
  for (const example of examples) {
    if (example.language === "blot") await checkBlot(example);
    if (example.language === "json") checkJson(example);
    if (example.language === "bash") await checkBash(example);
  }
  await checkTypeScript(
    examples.filter((example) => example.language === "ts"),
  );
} finally {
  dispose();
}

const counts = new Map<ExampleLanguage, number>();
for (const example of examples) {
  let count = 1;
  const previous = counts.get(example.language);
  if (previous !== undefined) count = previous + 1;
  counts.set(example.language, count);
}
console.log(
  `README examples: ${formatCount(counts, "blot")}, ${
    formatCount(counts, "ts")
  }, ${formatCount(counts, "json")}, ${formatCount(counts, "bash")}`,
);

function readmeExamples(markdown: string): readonly ReadmeExample[] {
  const examples: ReadmeExample[] = [];
  let open:
    | {
      readonly language: ExampleLanguage;
      readonly firstLine: number;
      readonly lines: string[];
    }
    | undefined;
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (open === undefined) {
      const opening = /^```([^\s]+)\s*$/.exec(line);
      if (opening === null) continue;
      open = {
        language: exampleLanguage(opening[1], index + 1),
        firstLine: index + 2,
        lines: [],
      };
      continue;
    }
    if (line === "```") {
      examples.push({
        language: open.language,
        source: `${open.lines.join("\n")}\n`,
        firstLine: open.firstLine,
      });
      open = undefined;
      continue;
    }
    open.lines.push(line);
  }
  if (open !== undefined) {
    throw new Error(
      `${readmePath}:${open.firstLine - 1}: unclosed ${open.language} fence`,
    );
  }
  return examples;
}

function exampleLanguage(value: string, line: number): ExampleLanguage {
  if (value === "bash") return value;
  if (value === "blot") return value;
  if (value === "json") return value;
  if (value === "ts") return value;
  throw new Error(
    `${readmePath}:${line}: code fence language ${
      JSON.stringify(value)
    } has no syntax check`,
  );
}

async function checkBlot(example: ReadmeExample): Promise<void> {
  const elaborated = await elaborateLayout(example.source);
  if (!elaborated.ok) {
    throw new Error(
      elaborated.diagnostics.map((diagnostic) =>
        syntaxFailure(
          example,
          diagnostic.code,
          diagnostic.message,
          diagnostic.span.start,
        )
      ).join("\n"),
    );
  }
  const runtime = await babaRuntime();
  const lexed = runtime.wasmLexer.lex(elaborated.layout.source);
  if (lexed.diagnostics.length > 0) {
    throw new Error(
      lexed.diagnostics.map((diagnostic) =>
        syntaxFailure(
          example,
          diagnostic.code,
          diagnostic.message,
          elaborated.layout.originalOffset(diagnostic.span.start),
        )
      ).join("\n"),
    );
  }
  const parsed = ingestCpuSource(runtime.cpuParser, elaborated.layout.source);
  if (parsed.ok) return;
  throw new Error(
    parsed.diagnostics.map((diagnostic) =>
      syntaxFailure(
        example,
        diagnostic.code,
        diagnostic.message,
        elaborated.layout.originalOffset(diagnostic.start),
      )
    ).join("\n"),
  );
}

function syntaxFailure(
  example: ReadmeExample,
  code: string,
  message: string,
  offset: number,
): string {
  const line = example.firstLine + sourceLine(example.source, offset);
  return `${readmePath}:${line}: ${code}: ${message}`;
}

function checkJson(example: ReadmeExample): void {
  try {
    JSON.parse(example.source);
  } catch (cause) {
    throw new Error(
      `${readmePath}:${example.firstLine}: invalid JSON example`,
      { cause },
    );
  }
}

async function checkBash(example: ReadmeExample): Promise<void> {
  const output = await new Deno.Command("bash", {
    args: ["-n", "-c", example.source],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.success) return;
  const error = new TextDecoder().decode(output.stderr).trim();
  throw new Error(`${readmePath}:${example.firstLine}: ${error}`);
}

async function checkTypeScript(
  examples: readonly ReadmeExample[],
): Promise<void> {
  if (examples.length === 0) return;
  const temporaryDirectory = await Deno.makeTempDir({
    prefix: "blot-readme-examples-",
  });
  try {
    const rootModule = toFileUrl(`${Deno.cwd()}/mod.ts`).href;
    const compilerModule = toFileUrl(`${Deno.cwd()}/src/compiler.ts`).href;
    const paths: string[] = [];
    for (let index = 0; index < examples.length; index += 1) {
      const example = examples[index];
      const source = example.source
        .replaceAll('"@mewhhaha/blot/compiler"', JSON.stringify(compilerModule))
        .replaceAll('"@mewhhaha/blot"', JSON.stringify(rootModule));
      const path = `${temporaryDirectory}/example_${index + 1}.mts`;
      await Deno.writeTextFile(path, source);
      paths.push(path);
    }
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["check", ...paths],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.success) return;
    const error = new TextDecoder().decode(output.stderr).trim();
    const lines = examples.map((example, index) =>
      `example_${index + 1}.mts starts at ${readmePath}:${example.firstLine}`
    );
    throw new Error(`${lines.join("\n")}\n${error}`);
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
}

function sourceLine(source: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function formatCount(
  counts: ReadonlyMap<ExampleLanguage, number>,
  language: ExampleLanguage,
): string {
  let count = counts.get(language);
  if (count === undefined) count = 0;
  return `${count} ${language}`;
}
