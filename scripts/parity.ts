// Diagnostic byte comparison between Baba's authoritative CPU frontend and
// its experimental general-profile WebGPU executor.
//
// General-profile executors may currently disagree on node order and nested
// island selection. This command reports those differences; it is not a Blot
// release gate.

import {
  type CompactFrontendProgram,
  CpuFrontend,
  WebGpuRuntime,
} from "@mewhhaha/baba/runtime/webgpu";

const paths = Deno.args.filter((argument) => !argument.startsWith("--"));
const cpuOnly = Deno.args.includes("--cpu");
if (paths.length === 0) {
  console.error("Expected at least one blot source path.");
  Deno.exit(1);
}

const plan = await Deno.readFile("generated/wasm/parser.plan");
const cpu = CpuFrontend.create(plan);

if (cpuOnly) {
  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const result = cpu.ingest(source);
    if (!result.ok) {
      report(path, "CPU frontend", result.diagnostics);
      Deno.exit(1);
    }
    console.log(`${path}: CPU frontend accepted ${summarize(result.program)}.`);
  }
  Deno.exit(0);
}

const runtime = await WebGpuRuntime.create({
  powerPreference: "high-performance",
});
try {
  const frontend = await runtime.compileFrontend(plan);
  let failed = false;

  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const expected = cpu.ingest(source);
    const actual = await frontend.ingest(source);

    if (!expected.ok) {
      report(path, "CPU frontend", expected.diagnostics);
      failed = true;
      continue;
    }
    if (!actual.ok) {
      report(path, "WebGPU frontend", actual.diagnostics);
      failed = true;
      continue;
    }

    const mismatch = compare(expected.program, actual.program);
    if (mismatch !== null) {
      console.error(`${path}: parity mismatch in ${mismatch}.`);
      failed = true;
      continue;
    }
    console.log(`${path}: parity holds, ${summarize(actual.program)}.`);
  }

  if (failed) Deno.exit(1);
} finally {
  runtime.dispose();
}

function compare(
  expected: CompactFrontendProgram,
  actual: CompactFrontendProgram,
): string | null {
  const buffers = ["tokens", "nodes", "edges", "symbols", "types"] as const;
  for (const buffer of buffers) {
    const left = expected[buffer];
    const right = actual[buffer];
    if (left.length !== right.length) return `${buffer} length`;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return `${buffer}[${index}]`;
    }
  }
  return null;
}

function summarize(program: CompactFrontendProgram): string {
  return `${program.tokens.length} token words, ${program.nodes.length} node words, ${program.edges.length} edge words`;
}

function report(
  path: string,
  backend: string,
  diagnostics: readonly { code: string; message: string }[],
): void {
  for (const diagnostic of diagnostics) {
    console.error(
      `${path}: ${backend}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
}
