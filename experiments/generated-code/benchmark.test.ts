import { assertEquals } from "@std/assert";
import { Compiler } from "../../src/compiler/session.ts";
import { instantiateWorkload, WORKLOADS } from "./workloads.ts";

Deno.test("generated workload observations match their independent models", async () => {
  const compiler = await Compiler.create();
  try {
    for (const workload of WORKLOADS) {
      const artifact = await compiler.compile(workload.programPath);
      const module = await WebAssembly.compile(
        Uint8Array.from(artifact.wasm),
      );
      const state = { input: 0n };
      const run = await instantiateWorkload(module, state, workload);
      const inputs = new Set([0n, 1n, ...workload.inputs]);
      for (const input of inputs) {
        state.input = input;
        assertEquals(
          run(input),
          workload.expected(input),
          `${workload.name} at input ${input}`,
        );
      }
    }
  } finally {
    compiler.destroy();
  }
});
