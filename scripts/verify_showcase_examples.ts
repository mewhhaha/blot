import { assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { Compiler } from "../src/compiler/session.ts";
import { evaluateFile, show } from "../src/run.ts";

const everydayExamples = [
  "bank_ledger.blot",
  "checkout_workflow.blot",
  "configuration_layers.blot",
  "http_router.blot",
  "inventory_restock.blot",
  "invoice_report.blot",
  "log_report.blot",
  "retry_policy.blot",
  "shopping_cart.blot",
  "validation_pipeline.blot",
  "word_frequency.blot",
] as const;

const algorithmExamples = [
  "breadth_first_search.blot",
  "depth_first_search.blot",
  "dijkstra_shortest_paths.blot",
  "topological_sort.blot",
] as const;

let selectedExamples: readonly string[] = [
  ...everydayExamples,
  ...algorithmExamples,
];
if (Deno.args.length > 0) {
  if (Deno.args.length !== 1 || Deno.args[0] !== "--algorithms") {
    throw new TypeError(
      `verify_showcase_examples.ts accepts only --algorithms, received ${
        Deno.args.join(" ")
      }`,
    );
  }
  selectedExamples = algorithmExamples;
}

const compiler = await Compiler.create();
try {
  for (const name of selectedExamples) {
    const path = join("examples", name);
    const printed: string[] = [];
    const value = await evaluateFile(path, {
      write: (line) => printed.push(line),
    });
    const observed = [...printed, show(value)].join("\n").trim();
    const stem = basename(name, ".blot");
    const recorded = (await Deno.readTextFile(
      join("examples/expected", `${stem}.txt`),
    )).trim();

    assertEquals(observed, recorded, `${path} changed its recorded result`);
    await compiler.compile(path);
    console.log(`${path}: evaluated and compiled`);
  }
} finally {
  compiler.destroy();
}
