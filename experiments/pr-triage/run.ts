import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { LoadError } from "../../src/load.ts";
import { runArtifact } from "../../src/node/run.ts";

const probes = [
  "fold_input",
  "generic_result",
  "effect_composition",
  "tuple_case",
  "projected_refinement",
  "quantified_length",
  "nested_variant_display",
  "multiline_lambda",
  "multiline_union",
  "runtime_seal",
  "record_intersection",
  "control_tuple_case",
  "control_refinement_alias",
  "control_multiline_lambda",
  "control_record_spread",
];
const typeOnly = new Set(["effect_composition", "nested_variant_display"]);
const repository = new URL("../../", import.meta.url);

function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof BlotError) {
    const failure: Record<string, unknown> = {
      kind: "source-diagnostic",
      diagnostic: error.diagnostic,
    };
    if (error.origin !== null) {
      failure.path = error.origin.path.replace(
        fileURLToPath(repository),
        "",
      );
      failure.sourceAvailable = error.origin.source.length > 0;
    }
    return failure;
  }
  if (error instanceof LoadError) {
    return {
      kind: "frontend-diagnostic",
      diagnostics: error.diagnostics,
    };
  }
  let kind = "unexpected-failure";
  if (error instanceof Error) kind = error.name;
  return { kind, message: String(error) };
}

const results = [];
for (const name of probes) {
  const path = fileURLToPath(new URL(`${name}.blot`, import.meta.url));
  const contents = await readFile(path);
  const result: Record<string, unknown> = {
    name,
    sourceSha256: createHash("sha256").update(contents).digest("hex"),
  };
  const compiler = await Compiler.create();
  try {
    let accepted = false;
    try {
      result.check = await compiler.check(path);
      accepted = true;
    } catch (error) {
      result.check = describeFailure(error);
    }
    if (accepted && !typeOnly.has(name)) {
      try {
        const evaluated = await compiler.evaluate(path);
        result.evaluate = {
          display: evaluated.display,
          writes: evaluated.writes,
        };
      } catch (error) {
        result.evaluate = describeFailure(error);
      }
      try {
        const artifact = await compiler.compile(path);
        result.compile = { bytes: artifact.wasm.byteLength };
        try {
          result.wasm = { display: await runArtifact(artifact) };
        } catch (error) {
          result.wasm = describeFailure(error);
        }
      } catch (error) {
        result.compile = describeFailure(error);
      }
    }
  } finally {
    compiler.destroy();
  }
  results.push(result);
}

const compiler = await readFile(
  new URL("generated/compiler/compiler.wasm", repository),
);
console.log(JSON.stringify(
  {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    compilerSha256: createHash("sha256").update(compiler).digest("hex"),
    node: process.version,
    results,
  },
  null,
  2,
));
