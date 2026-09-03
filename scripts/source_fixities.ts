import { babaRuntime } from "../src/syntax/baba_runtime.ts";
import { materializeCpuCst } from "../src/syntax/cpu_cst.ts";
import { declaredFixities } from "../src/syntax/source_fixity.ts";
import { elaborateLayout } from "../src/syntax/layout.ts";
import { ingestCpuSource } from "../src/syntax/cpu_ingest.ts";

export interface SourceFixity {
  readonly operator: string;
  readonly associativity: "left" | "right" | "none" | "prefix";
  readonly precedence: number;
  readonly target: string;
}

export async function readSourceFixities(
  path = "src/prelude/prelude.blot",
): Promise<readonly SourceFixity[]> {
  return await parseSourceFixities(await Deno.readTextFile(path), path);
}

export async function parseSourceFixities(
  source: string,
  path = "source",
): Promise<readonly SourceFixity[]> {
  const elaborated = await elaborateLayout(source);
  if (!elaborated.ok) {
    throw new Error(
      `${path}: ${
        elaborated.diagnostics.map((diagnostic) => diagnostic.message).join(
          "; ",
        )
      }`,
    );
  }
  const runtime = await babaRuntime();
  const parsed = ingestCpuSource(runtime.cpuParser, elaborated.layout.source);
  if (!parsed.ok) {
    throw new Error(
      `${path}: ${
        parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
      }`,
    );
  }
  const cst = materializeCpuCst(
    runtime.cpuParser,
    parsed.program,
    elaborated.layout.source,
    elaborated.layout.originalOffset,
  );
  const fixities = declaredFixities(cst).map((fixity) => ({
    operator: fixity.operator,
    associativity: fixity.associativity,
    precedence: fixity.precedence,
    target: fixity.target.join("."),
  }));
  if (fixities.length === 0) {
    throw new Error(`${path}: no source fixity declarations found`);
  }

  const keys = new Set<string>();
  for (const fixity of fixities) {
    let form = "infix";
    if (fixity.associativity === "prefix") form = "prefix";
    const key = `${form}:${fixity.operator}`;
    if (keys.has(key)) throw new Error(`${path}: duplicate operator ${key}`);
    keys.add(key);
  }
  return fixities;
}
