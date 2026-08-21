import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  coreRuntimeImportModule,
  createRuntimeHeap,
  createRuntimeImports,
} from "@mewhhaha/gpupaper/runtime";
import { Compiler } from "../session.ts";

async function withSource<T>(
  source: string,
  run: (compiler: Compiler, path: string) => Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "root.blot");
  await Deno.writeTextFile(path, source);
  const compiler = await Compiler.create();
  try {
    return await run(compiler, path);
  } finally {
    compiler.destroy();
    await Deno.remove(directory, { recursive: true });
  }
}

async function runDefault(
  wasm: Uint8Array,
  host: Record<string, WebAssembly.ImportValue>,
): Promise<unknown> {
  const module = await WebAssembly.compile(wasm as BufferSource);
  const instance = await WebAssembly.instantiate(module, {
    [coreRuntimeImportModule]: createRuntimeImports(createRuntimeHeap([])),
    "blot:host/Source": host,
  });
  const run = instance.exports["blot:default"];
  if (typeof run !== "function") throw new Error("default export is missing");
  return run();
}

Deno.test("Runtime HIR exports inferred functions with a concrete ABI", async () => {
  const source = `open import "blot:prelude"
return {
  .double = fn value => value + value;
}
`;
  await withSource(source, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    const exported = hir.exports.find((candidate) =>
      candidate.sourceName === "double"
    );
    assert(exported?.phase === "runtime");
    assertEquals(hir.signatures[exported.signature].parameters.length, 1);

    const artifact = await compiler.compile(path);
    const module = await WebAssembly.compile(artifact.wasm as BufferSource);
    const instance = await WebAssembly.instantiate(module, {
      [coreRuntimeImportModule]: createRuntimeImports(createRuntimeHeap([])),
    });
    const double = instance.exports["blot:double"];
    assert(typeof double === "function");
    assertEquals(double(21n), 42n);
  });
});

Deno.test("Runtime HIR emits direct scalar F32 conversion and square root", async () => {
  const source = `open import "blot:prelude"
return {
  .from_int = Float32.of_int;
  .root = Float32.sqrt;
}
`;
  await withSource(source, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    const operations = hir.functions.flatMap((fn) =>
      fn.blocks.flatMap((block) => block.operations)
    );
    assert(
      operations.some((operation) =>
        operation.kind === "scalar.unary" &&
        operation.operator === "square-root"
      ),
    );
    assert(
      operations.some((operation) =>
        operation.kind === "convert" &&
        operation.conversion === "signed-integer-32-to-float-32"
      ),
    );

    const artifact = await compiler.compile(path);
    const module = await WebAssembly.compile(artifact.wasm as BufferSource);
    const instance = await WebAssembly.instantiate(module, {
      [coreRuntimeImportModule]: createRuntimeImports(createRuntimeHeap([])),
    });
    const fromInt = instance.exports["blot:from_int"];
    const root = instance.exports["blot:root"];
    assert(typeof fromInt === "function");
    assert(typeof root === "function");
    assertEquals(fromInt(16_777_217n), 16_777_216);
    assertEquals(root(9), 3);
  });
});

Deno.test("Runtime HIR lowers dynamic array decomposition through generic Store control flow", async () => {
  const operations = [
    {
      call: "@array.take values at",
      result: `let (selected, remainder) = decomposed
  return selected + Array.length remainder`,
    },
    {
      call: "@array.split values at",
      result: `let (before, selected, suffix) = decomposed
  return Array.length before + selected + Array.length suffix`,
    },
  ];
  for (const operation of operations) {
    const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; .index = Int -> Int; }
value <- Source.value 0
at <- Source.index 0
let values = [value, 20, 30]
if at >= 0 && at < Array.length values:
  let decomposed = ${operation.call}
  ${operation.result}
else:
  return -1
`;
    await withSource(source, async (compiler, path) => {
      const hir = await compiler.prepare(path);
      const kinds = new Set(
        hir.functions.flatMap((fn) =>
          fn.blocks.flatMap((block) =>
            block.operations.map((candidate) => candidate.kind)
          )
        ),
      );
      assert(kinds.has("store.length"));
      assert(kinds.has("store.read"));
      assert(kinds.has("store.grow"));
      assert(
        [...kinds].every((kind) =>
          !kind.includes("take") && !kind.includes("split")
        ),
      );
    });
  }
});

Deno.test("Runtime HIR keeps one Store identity across affine for loops", async () => {
  const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
dynamic <- Source.value 0
let values = [dynamic, 2, 3, 4, 5]
let total = 0
for value in Iter.slice (values, 1, 5):
  total := total + value
for value in Iter.reverse values:
  total := total + value
for value in Iter.affine (values, 0, 5, 2):
  total := total + value
return total
`;
  await withSource(source, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    const operations = hir.functions.flatMap((fn) => fn.blocks).flatMap(
      (block) => block.operations,
    );
    const kinds = operations.map((operation) => operation.kind);
    assertEquals(kinds.filter((kind) => kind === "store.empty").length, 1);
    assertEquals(kinds.filter((kind) => kind === "store.grow").length, 5);
    assertEquals(kinds.filter((kind) => kind === "store.read").length, 3);
    assertEquals(kinds.filter((kind) => kind === "call.direct").length, 0);

    const artifact = await compiler.compile(path);
    assertEquals(
      await runDefault(artifact.wasm, { value: (_: bigint) => 1n }),
      38n,
    );
  });
});

Deno.test("Runtime HIR retains non-tail structural recursion as direct calls", async () => {
  const source = `operators {
  infixl 55 (<>) = Array.append;
}
open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
sig quicksort = [Int] -> [Int]
let rec quicksort = fn values => case Array.uncons values of
  #None => []
  #Some (pivot, rest) => do:
    let (smaller, larger) =
      Array.partition (rest, fn value => value <= pivot)
    return quicksort smaller <> [pivot] <> quicksort larger
sig checksum = ([Int], Int, Int) -> Int
let rec checksum = fn (values, index, total) => do:
  if index >= Array.length values:
    return total
  else:
    let value = case Array.get (values, index) of
      #Some item => item
      #None => 0
    return checksum (values, index + 1, total + (index + 1) * value)
dynamic <- Source.value 0
return checksum (quicksort [dynamic, 7, 3, 8, 2, 6, 1, 5], 0, 0)
`;
  await withSource(source, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    assert(
      hir.functions.flatMap((fn) => fn.blocks).flatMap((block) =>
        block.operations
      ).some((operation) => operation.kind === "call.direct"),
    );
    const artifact = await compiler.compile(path);
    assertEquals(
      await runDefault(artifact.wasm, { value: (_: bigint) => 4n }),
      204n,
    );
  });
});

Deno.test("Runtime HIR closure-converts dynamic recursive captures", async () => {
  const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
offset <- Source.value 0
sig add_depth = Int -> Int
let rec add_depth = fn depth => do:
  if depth <= 0:
    return offset
  else:
    return 1 + add_depth (depth - 1)
return add_depth 3
`;
  await withSource(source, async (compiler, path) => {
    const hir = await compiler.prepare(path);
    const recursive = hir.functions.find((fn) =>
      fn.name.startsWith("blot:recursive:")
    );
    assert(recursive !== undefined);
    assertEquals(hir.signatures[recursive.signature].parameters.length, 2);
    const artifact = await compiler.compile(path);
    assertEquals(
      await runDefault(artifact.wasm, { value: (_: bigint) => 9n }),
      12n,
    );
  });
});
