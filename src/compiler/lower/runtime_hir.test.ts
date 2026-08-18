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

Deno.test("Runtime HIR lowers dynamic array decomposition through generic Store control flow", async () => {
  const operations = [
    {
      call: "Array.take (values, at)",
      arms: `#Taken (selected, remainder) => selected + Array.length remainder
  #TakeOutOfBounds original => Array.length original`,
    },
    {
      call: "@array.split values at",
      arms: `#Split (before, selected, suffix) => (
    Array.length before + selected + Array.length suffix
  )
  #SplitOutOfBounds original => Array.length original`,
    },
  ];
  for (const operation of operations) {
    const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; .index = Int -> Int; }
value <- Source.value 0
at <- Source.index 0
let values = [value, 20, 30]
let result = ${operation.call}
return case result of
  ${operation.arms}
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

Deno.test("Runtime HIR retains non-tail structural recursion as direct calls", async () => {
  const source = `operators {
  infixl 55 (<>) = Array.append;
}
open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
sig quicksort = [Int] -> [Int]
let rec quicksort = fn values => case Array.uncons values of
  #None => []
  #Some (pivot, rest) =>
    let (smaller, larger) =
      Array.partition (rest, fn value => value <= pivot)
    return quicksort smaller <> [pivot] <> quicksort larger
sig checksum = ([Int], Int, Int) -> Int
let rec checksum = fn (values, index, total) =>
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
let rec add_depth = fn depth =>
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
