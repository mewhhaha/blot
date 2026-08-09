import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import { materializeCpuCst } from "../../src/syntax/cpu_cst.ts";
import { elaborateLayout } from "../../src/syntax/layout.ts";
import type { Cursor, Rule } from "../../src/syntax/cursor.ts";

const path = Deno.args[0] ?? "examples/minimal.blot";
const source = await Deno.readTextFile(path);
const layout = await elaborateLayout(source);
if (!layout.ok) throw new Error(JSON.stringify(layout.diagnostics));
const plan = await Deno.readFile(new URL("../../generated/wasm/parser.plan", import.meta.url));
const frontend = CpuFrontend.create(plan);
const parsed = frontend.ingest(layout.layout.source);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const cst = materializeCpuCst(
  frontend,
  parsed.program,
  layout.layout.source,
  layout.layout.originalOffset,
);

dump(cst, 0, 5);

function dump(cursor: Cursor, depth: number, remaining: number): void {
  const indent = "  ".repeat(depth);
  if (cursor.type === "token") {
    console.log(`${indent}token ${cursor.kind} ${JSON.stringify(cursor.text)}`);
    return;
  }
  console.log(`${indent}rule ${cursor.name} ${cursor.span.start}:${cursor.span.end}`);
  if (remaining <= 0) return;
  for (const child of cursor.children()) dump(child, depth + 1, remaining - 1);
}
