import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { Compiler } from "../../src/compiler/session.ts";

let samples = 3;
const sizes = [8, 16, 32, 64, 128, 256] as const;
const phases = ["frontend", "check", "prepare", "compile"] as const;
const generators = {
  ordinary: ordinarySource,
  structural: structuralSource,
  union: unionSource,
  polymorphic: polymorphicSource,
  refinement: refinementSource,
  wrapper: wrapperSource,
  measure: measureSource,
  evidence: evidenceSource,
} as const;

type Phase = typeof phases[number];
type Family = keyof typeof generators;

const requested = process.argv.slice(2).filter((argument) => argument !== "--");
const familyArguments: string[] = [];
for (const argument of requested) {
  if (argument.startsWith("--samples=")) {
    samples = Number.parseInt(argument.slice("--samples=".length), 10);
    if (!Number.isSafeInteger(samples) || samples < 1 || samples % 2 === 0) {
      throw new Error("type-scaling samples must be a positive odd integer");
    }
    continue;
  }
  familyArguments.push(argument);
}

let selectedFamilies = Object.keys(generators) as Family[];
if (familyArguments.length > 0) {
  const requested = familyArguments;
  for (const family of requested) {
    if (!(family in generators)) {
      throw new Error(`unknown type-scaling family ${JSON.stringify(family)}`);
    }
  }
  selectedFamilies = requested as Family[];
}

interface Case {
  readonly family: Family;
  readonly size: number;
  readonly path: string;
  readonly source: string;
  astBytes: number;
  hirNodes: number;
  wasmBytes: number;
  work: Awaited<ReturnType<Compiler["analyze"]>>["work"];
}

interface Timings {
  readonly frontend: number[];
  readonly check: number[];
  readonly prepare: number[];
  readonly compile: number[];
}

const directory = await mkdtemp(join(tmpdir(), "blot-type-scaling-"));
try {
  const cases: Case[] = [];
  for (
    const [family, generate] of Object.entries(generators) as (
      readonly [Family, (size: number) => string]
    )[]
  ) {
    if (!selectedFamilies.includes(family)) continue;
    for (const size of sizes) {
      const source = generate(size);
      const path = join(directory, `${family}-${size}.blot`);
      await writeFile(path, source);
      cases.push({
        family,
        size,
        path,
        source,
        astBytes: 0,
        hirNodes: 0,
        wasmBytes: 0,
        work: null,
      });
    }
  }

  // Qualify every generated program before timing it. These calls also warm
  // the host process without warming any session used for a sample.
  for (const item of cases) {
    const compiler = await Compiler.create();
    try {
      const ast = await compiler.portableAst(item.path);
      const analysis = await compiler.analyze(item.path);
      const hir = await compiler.prepare(item.path);
      const artifact = await compiler.compile(item.path);
      item.astBytes = Buffer.byteLength(ast);
      item.hirNodes = hirNodeCount(hir);
      item.wasmBytes = artifact.wasm.byteLength;
      item.work = analysis.work;
      const observed = await runDefault(artifact.wasm);
      if (observed !== BigInt(item.size)) {
        throw new Error(
          `${item.family}/${item.size} returned ${observed}; expected ${item.size}`,
        );
      }
    } finally {
      compiler.destroy();
    }
  }

  const timings = new Map<string, Timings>();
  for (const item of cases) timings.set(caseKey(item), emptyTimings());

  for (let sample = 0; sample < samples; sample += 1) {
    const orderedCases = [...cases];
    const orderedPhases = [...phases];
    if (sample % 2 !== 0) {
      orderedCases.reverse();
      orderedPhases.reverse();
    }
    for (const phase of orderedPhases) {
      const compiler = await Compiler.create();
      try {
        for (const item of orderedCases) {
          const started = performance.now();
          await runPhase(compiler, item.path, phase);
          requiredTimings(timings, item)[phase].push(
            performance.now() - started,
          );
        }
      } finally {
        compiler.destroy();
      }
    }
  }

  const rows = cases.map((item) => {
    const measured = requiredTimings(timings, item);
    return {
      family: item.family,
      size: item.size,
      source_bytes: Buffer.byteLength(item.source),
      portable_ast_bytes: item.astBytes,
      runtime_hir_nodes: item.hirNodes,
      wasm_bytes: item.wasmBytes,
      work: item.work,
      semantic_decisions: semanticDecisions(item.work),
      median_ms: {
        frontend: median(measured.frontend),
        check: median(measured.check),
        prepare: median(measured.prepare),
        compile: median(measured.compile),
      },
      samples_ms: measured,
    };
  });

  const slopes: Record<string, Record<Phase, number>> = {};
  for (const family of selectedFamilies) {
    const familyRows = rows.filter((row) => row.family === family);
    const byPhase = {} as Record<Phase, number>;
    for (const phase of phases) {
      byPhase[phase] = logSlope(
        familyRows.map((row) => row.size),
        familyRows.map((row) => row.median_ms[phase]),
      );
    }
    slopes[family] = byPhase;
  }

  const workGate = scalingGate(rows);
  const failedWorkGate = workGate.find((gate) => !gate.passed);

  const compilerBytes = await readFile(
    resolve("generated/compiler/compiler.wasm"),
  );
  console.log(JSON.stringify(
    {
      boundary: {
        class: "warm compiler session with an uncached measured module",
        includes:
          "source loading and graph sync; each cumulative phase includes all semantic prerequisites",
        excludes:
          "Compiler.create, source generation, qualification, and execution; each measured path is visited once per session",
        samples,
        aggregation: "median",
        sizes,
        node: process.version,
        compiler_sha256: sha256(compilerBytes),
      },
      theory: {
        ordinary: "O(N) declaration and expression nodes",
        structural:
          "O(N) members in one exact record and one width requirement",
        union: "O(N) constructors and one-column case arms",
        polymorphic: "O(N) independent instantiations of one principal type",
        refinement: "O(N) fixed-size predicates normalized to integer regions",
        wrapper: "O(N) wrapper bodies with identity relationships",
        measure: "O(N) wrapper depth transporting one measured array length",
        evidence: "O(N) independent structural proof packages",
      },
      work_gate: workGate,
      estimated_log_log_slope: slopes,
      rows,
    },
    null,
    2,
  ));
  if (failedWorkGate !== undefined) {
    throw new Error(
      `${failedWorkGate.family} semantic decision work grew ${
        failedWorkGate.last_doubling.toFixed(3)
      }x; expected at most 2.25x`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function runPhase(
  compiler: Compiler,
  path: string,
  phase: Phase,
): Promise<void> {
  if (phase === "frontend") {
    await compiler.portableAst(path);
    return;
  }
  if (phase === "check") {
    await compiler.check(path);
    return;
  }
  if (phase === "prepare") {
    await compiler.prepare(path);
    return;
  }
  await compiler.compile(path);
}

function ordinarySource(size: number): string {
  const declarations = ["let value0 = 0"];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(`let value${index} = value${index - 1} + 1`);
  }
  return moduleSource(declarations, `value${size}`);
}

function structuralSource(size: number): string {
  const typeFields: string[] = [];
  const valueFields: string[] = [];
  for (let index = 0; index < size; index += 1) {
    typeFields.push(`.field${index} = Int;`);
    valueFields.push(`.field${index} = ${index + 1};`);
  }
  return moduleSource([
    `const Requirement = { ${typeFields.join(" ")} }`,
    `let value = { ${valueFields.join(" ")} }`,
    "let checked = @satisfies value Requirement",
  ], `checked.field${size - 1}`);
}

function unionSource(size: number): string {
  const members: string[] = [];
  const arms: string[] = [];
  for (let index = 0; index < size; index += 1) {
    members.push(`#Event${index} Int`);
    arms.push(`  #Event${index} value => value`);
  }
  return moduleSource([
    `const Event = ${members.join(" | ")}`,
    "sig read = Event -> Int",
    `let read = fn event => case event of\n${arms.join("\n")}`,
  ], `read (#Event${size - 1} ${size})`);
}

function polymorphicSource(size: number): string {
  const declarations = ["let identity = fn value => value", "let value0 = 0"];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(
      `let value${index} = identity (value${index - 1} + 1)`,
    );
  }
  return moduleSource(declarations, `value${size}`);
}

function refinementSource(size: number): string {
  const declarations: string[] = [];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(
      `const Range${index} = refine (Int, fn value => value >= 0 && value <= ${index})`,
      `sig keep${index} = Range${index} -> Range${index}`,
      `let keep${index} = fn value => value`,
      `let value${index} = keep${index} ${index}`,
    );
  }
  return moduleSource(declarations, `value${size}`);
}

function wrapperSource(size: number): string {
  const declarations = ["const pass0 = fn value => value"];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(
      `const pass${index} = fn value => pass${index - 1} value`,
    );
  }
  return moduleSource(declarations, `pass${size} ${size}`);
}

function measureSource(size: number): string {
  const declarations = [
    "const count0 = fn values => Array.length values",
  ];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(
      `const count${index} = fn values => count${index - 1} values`,
    );
  }
  declarations.push(
    "sig at = [Int] -> Int -> Int",
    `let at = fn values => fn index => case index >= 0 && index < count${size} values of\n` +
      "  #True => @array.get values index\n" +
      "  #False => 0",
  );
  return moduleSource(
    declarations,
    `at [1, 2, 3, 4] 3 + ${size - 4}`,
  );
}

function evidenceSource(size: number): string {
  const declarations: string[] = [];
  for (let index = 1; index <= size; index += 1) {
    declarations.push(
      `let carry${index} = fn input => { .values = input.0; .payload = input.1; }`,
      `let select${index} = fn values => do:\n` +
        "  let iterator = Iter.indexed values\n" +
        "  let state = iterator.state\n" +
        "  return case iterator.step state of\n" +
        "    #None => 0\n" +
        "    #Some (entry, _) => do:\n" +
        "      let input = (values, entry)\n" +
        `      let package = carry${index} input\n` +
        "      let { .values = selected_values; .payload; } = package\n" +
        "      let (position, value) = payload\n" +
        "      return @array.get selected_values position + value",
    );
  }
  return moduleSource(
    declarations,
    `select${size} [1, 2, 3, 4] + ${size - 2}`,
  );
}

function moduleSource(declarations: readonly string[], result: string): string {
  return `open import "blot:prelude"\n\n${
    declarations.join("\n")
  }\n\nreturn ${result}\n`;
}

function emptyTimings(): Timings {
  return { frontend: [], check: [], prepare: [], compile: [] };
}

function semanticDecisions(work: Case["work"]): number | null {
  if (work === null) return null;
  return work.constraints + work.boundaryMaterializations +
    work.captureCandidates + work.capturesBridged;
}

function scalingGate(
  rows: readonly {
    readonly family: Family;
    readonly size: number;
    readonly semantic_decisions: number | null;
  }[],
): readonly {
  readonly family: Family;
  readonly last_doubling: number;
  readonly passed: boolean;
}[] {
  const gates = [];
  for (const family of ["wrapper", "measure", "evidence"] as const) {
    const familyRows = rows.filter((row) => row.family === family);
    if (familyRows.length < 2) continue;
    const previous = familyRows.at(-2)?.semantic_decisions;
    const last = familyRows.at(-1)?.semantic_decisions;
    if (
      previous === null || previous === undefined || last === null ||
      last === undefined
    ) {
      throw new Error(`${family} has no resident compiler-work counters`);
    }
    const lastDoubling = last / previous;
    gates.push({
      family,
      last_doubling: lastDoubling,
      passed: lastDoubling <= 2.25,
    });
  }
  return gates;
}

function caseKey(item: Pick<Case, "family" | "size">): string {
  return `${item.family}:${item.size}`;
}

function requiredTimings(
  values: ReadonlyMap<string, Timings>,
  item: Pick<Case, "family" | "size">,
): Timings {
  const result = values.get(caseKey(item));
  if (result === undefined) throw new Error("missing benchmark timings");
  return result;
}

function hirNodeCount(
  hir: Awaited<ReturnType<Compiler["prepare"]>>,
): number {
  let count = hir.functions.length;
  for (const function_ of hir.functions) {
    count += function_.blocks.length;
    for (const block of function_.blocks) count += block.operations.length;
  }
  return count;
}

async function runDefault(wasm: Uint8Array): Promise<bigint> {
  const instantiated = await WebAssembly.instantiate(Uint8Array.from(wasm));
  const exported: unknown = instantiated.instance.exports["blot:default"];
  if (typeof exported !== "function") {
    throw new Error("generated scaling case has no default export");
  }
  const value: unknown = exported();
  if (typeof value !== "bigint") {
    throw new Error("generated scaling case did not return an i64");
  }
  return value;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const result = ordered[Math.floor(ordered.length / 2)];
  if (result === undefined) throw new Error("empty timing sample");
  return result;
}

function logSlope(xs: readonly number[], ys: readonly number[]): number {
  const logXs = xs.map(Math.log);
  const logYs = ys.map(Math.log);
  const meanX = mean(logXs);
  const meanY = mean(logYs);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < logXs.length; index += 1) {
    const x = logXs[index];
    const y = logYs[index];
    if (x === undefined || y === undefined) {
      throw new Error("incomplete scaling sample");
    }
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) * (x - meanX);
  }
  if (denominator === 0) throw new Error("scaling sizes have no variance");
  return numerator / denominator;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("empty mean sample");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
