import { readFile } from "node:fs/promises";
import { createParser, type ParserInstance } from "../../generated/wasm/mod.ts";
import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";

const parserWasmUrl = new URL(
  "../../generated/wasm/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../../generated/wasm/parser.plan",
  import.meta.url,
);

export interface BabaRuntime {
  readonly wasmLexer: ParserInstance;
  readonly cpuParser: CpuFrontend;
}

let active: BabaRuntime | undefined;
let shared: Promise<BabaRuntime> | undefined;

export function babaRuntime(): Promise<BabaRuntime> {
  if (shared !== undefined) return shared;
  const initialization = initialize();
  shared = initialization;
  void initialization.catch(() => {
    if (shared === initialization) shared = undefined;
  });
  return initialization;
}

export function warmBabaRuntime(): void {
  void babaRuntime();
}

async function initialize(): Promise<BabaRuntime> {
  const [bytes, plan] = await Promise.all([
    readFile(parserWasmUrl),
    readFile(parserPlanUrl),
  ]);
  const runtime: BabaRuntime = {
    wasmLexer: createParser({ bytes, plan }),
    cpuParser: CpuFrontend.create(plan),
  };
  active = runtime;
  return runtime;
}

export function disposeBabaRuntime(): void {
  const pending = shared;
  shared = undefined;
  if (active !== undefined) {
    active.wasmLexer.dispose();
    active = undefined;
    return;
  }
  if (pending === undefined) return;
  void pending.then((runtime) => {
    runtime.wasmLexer.dispose();
  });
}
