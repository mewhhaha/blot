import assert from "node:assert/strict";
import type { Compiler } from "../../src/compiler.ts";

export async function inspectKernel(compiler: Compiler, name: string) {
  const hir = await compiler.prepare(`case-studies/ecs/kernels/${name}.blot`);
  assert.deepEqual(hir.capabilities, []);
  const operations = hir.functions.flatMap((function_) =>
    function_.continuations.flatMap((continuation) =>
      continuation.instructions.map((instruction) => instruction.operation)
    )
  );
  for (const operation of operations) {
    assert.ok(!operation.kind.startsWith("indirect."));
    if (operation.kind === "store.grow" || operation.kind === "store.write") {
      assert.equal(operation.update, "owned-reuse");
    }
    if (operation.kind === "constant") {
      assert.ok(
        !["Position", "Velocity", "Age", "Label"].includes(
          String(operation.value),
        ),
      );
    }
  }
  return {
    functions: hir.functions.length,
    outputStores:
      operations.filter((operation) => operation.kind === "store.empty").length,
    readSites:
      operations.filter((operation) => operation.kind === "store.read").length,
    productSites:
      operations.filter((operation) => operation.kind === "product.make")
        .length,
  };
}
