import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { BlotError } from "../../src/diagnostic.ts";
import { Compiler } from "../../src/compiler/session.ts";
import {
  coreRuntimeImportModule,
  createRuntimeHeap,
  createRuntimeImports,
} from "@mewhhaha/gpupaper/runtime";
import type {
  BlotRuntimeModule,
  BlotRuntimeOperation,
} from "../../src/runtime/hir.ts";

const quicksortPath = fromFileUrl(
  new URL("./owned_slice_quicksort.blot", import.meta.url),
);

function allOperations(module: BlotRuntimeModule): BlotRuntimeOperation[] {
  return module.functions.flatMap((fn) =>
    fn.blocks.flatMap((block) => [...block.operations])
  );
}

async function withCompiler<T>(
  run: (compiler: Compiler) => Promise<T>,
): Promise<T> {
  const compiler = await Compiler.create();
  try {
    return await run(compiler);
  } finally {
    compiler.destroy();
  }
}

async function withSource<T>(
  source: string,
  run: (compiler: Compiler, path: string) => Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "root.blot");
  await Deno.writeTextFile(path, source);
  try {
    return await withCompiler((compiler) => run(compiler, path));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function instantiateDefault(
  wasm: Uint8Array,
  imports: WebAssembly.Imports = {},
): Promise<() => unknown> {
  const module = await WebAssembly.compile(wasm as BufferSource);
  const runtimeImports = createRuntimeImports(createRuntimeHeap([]));
  const suppliedRuntime = imports[coreRuntimeImportModule];
  if (typeof suppliedRuntime === "object" && suppliedRuntime !== null) {
    Object.assign(runtimeImports, suppliedRuntime);
  }
  const instance = await WebAssembly.instantiate(module, {
    ...imports,
    [coreRuntimeImportModule]: runtimeImports,
  });
  const run = instance.exports["blot:default"];
  if (typeof run !== "function") {
    throw new Error("compiled module omitted the default export");
  }
  return run as () => unknown;
}

Deno.test("owned Slice quicksort executes through Rust Core Wasm without recursive Store allocation", async () => {
  await withCompiler(async (compiler) => {
    const hir = await compiler.prepare(quicksortPath);
    const operations = allOperations(hir);
    assert(
      operations.every((operation) =>
        !operation.kind.includes("quicksort") &&
        !operation.kind.includes("partition")
      ),
      "generic quicksort must lower through ordinary Runtime-HIR operations",
    );
    const storeWrites = operations.filter((operation) =>
      operation.kind === "store.write"
    );
    assert(
      storeWrites.length > 0,
      "quicksort emitted no destructive Store writes",
    );
    assert(
      storeWrites.every((operation) =>
        operation.kind === "store.write" && operation.update === "owned-reuse"
      ),
      "quicksort mutation must not copy a Store after Slice acquisition",
    );
    const elementStore = storeWrites[0].type;
    assertEquals(
      operations.filter((operation) =>
        operation.kind === "store.empty" && operation.type === elementStore
      ).length,
      1,
      "the element Store must be acquired once",
    );
    assertEquals(
      operations.filter((operation) =>
        operation.kind === "store.grow" && operation.type === elementStore
      ).length,
      9,
      "only the nine source elements may grow the element Store",
    );
    assertEquals(
      operations.filter((operation) => operation.kind === "store.new").length,
      0,
    );
    const recursive = hir.functions.find((function_) =>
      function_.blocks.some((block) =>
        block.operations.some((operation) =>
          operation.kind === "call.direct" &&
          operation.function === function_.id
        )
      )
    );
    assert(recursive !== undefined, "quicksort lost its recursive function");
    assertEquals(
      recursive.blocks.flatMap((block) => block.operations).filter(
        (operation) =>
          operation.kind === "call.direct" &&
          operation.function === recursive.id,
      ).length,
      2,
      "only the smaller-side calls should remain recursive calls",
    );
    assertEquals(
      recursive.blocks.filter((block) =>
        block.terminator.kind === "branch" &&
        block.terminator.target === recursive.entryBlock
      ).length,
      2,
      "both larger-side tail calls should become loop back-edges",
    );

    const artifact = await compiler.compile(quicksortPath);
    const run = await instantiateDefault(artifact.wasm, {
      "blot:host/Source": {
        value(input: bigint) {
          assertEquals(input, 0n);
          return 9n;
        },
      },
    });
    assertEquals(run(), 159n);
  });
});

Deno.test("Slice-relative get and set cannot reach a sibling Region", async () => {
  const source = `open import "blot:prelude"
let whole = Slice.copy [10, 20, 30]
return case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) => do:
    let crossed = case Slice.get ((&left), 1) of
      #Some _ => 1
      #None => 0
    let left = case Slice.set ((!left), 1, 77) of
      #Updated !updated => updated
      #SetOutOfBounds !original => original
    let restored = Slice.join ((!rejoin), (!left), (!right))
    let frozen = Slice.freeze (!restored)
    let middle = case Array.get (frozen, 1) of
      #Some value => value
      #None => 99
    return crossed * 100 + middle
  #SplitOutOfBounds !original => do:
    let frozen = Slice.freeze (!original)
    return 900 + Array.length (&frozen)
`;

  await withSource(source, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    const run = await instantiateDefault(artifact.wasm);
    assertEquals(run(), 20n);
  });
});

Deno.test("dynamic Slice split conserves authority on success and failure", async () => {
  const source = `open import "blot:prelude"
const Source = @effect.host { .offset = Int -> Int; }
at <- Source.offset 0
let whole = Slice.copy [4, 5, 6]
let restored = case Slice.split ((!whole), at) of
  #Split (!left, !right, !rejoin) => Slice.join ((!rejoin), (!left), (!right))
  #SplitOutOfBounds !original => original
let frozen = Slice.freeze (!restored)
let first = case Array.get (frozen, 0) of
  #Some value => value
  #None => 0
let last = case Array.get (frozen, 2) of
  #Some value => value
  #None => 0
return first * 10 + last
`;

  await withSource(source, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    for (const offset of [2n, -1n, 99n]) {
      const run = await instantiateDefault(artifact.wasm, {
        "blot:host/Source": { offset: (_: bigint) => offset },
      });
      assertEquals(run(), 46n);
    }
  });
});

Deno.test("dynamic refined array take and split return plain tuples", async () => {
  const cases = [
    {
      call: "@array.take values at",
      result: `let (selected, remainder) = decomposed
  return selected * 100 + Array.length remainder`,
      success: 2_002n,
    },
    {
      call: "@array.split values at",
      result: `let (before, selected, suffix) = decomposed
  return Array.length before * 100 + selected * 10 + Array.length suffix`,
      success: 301n,
    },
  ];
  for (const case_ of cases) {
    const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; .index = Int -> Int; }
value <- Source.value 0
at <- Source.index 0
let values = [value, 20, 30]
if at >= 0 && at < Array.length values:
  let decomposed = ${case_.call}
  ${case_.result}
else:
  return Array.length values
`;

    await withSource(source, async (compiler, path) => {
      const hir = await compiler.prepare(path);
      const operationKinds = new Set(
        allOperations(hir).map((operation) => operation.kind),
      );
      assert(operationKinds.has("store.length"));
      assert(operationKinds.has("store.read"));
      assert(operationKinds.has("store.grow"));
      const artifact = await compiler.compile(path);
      for (const [index, expected] of [[1n, case_.success], [-1n, 3n]]) {
        const run = await instantiateDefault(artifact.wasm, {
          "blot:host/Source": {
            value: (_: bigint) => 9n,
            index: (_: bigint) => index,
          },
        });
        assertEquals(run(), expected);
      }
    });
  }
});

Deno.test("direct recursive functions close over dynamic values", async () => {
  const source = `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
offset <- Source.value 0
let rec add_depth :: Int -> Int
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
    const run = await instantiateDefault(artifact.wasm, {
      "blot:host/Source": { value: (_: bigint) => 9n },
    });
    assertEquals(run(), 12n);
  });
});

Deno.test("Slice copy is elided only for proven private Stores", async () => {
  const source = (owned: boolean) =>
    `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
x <- Source.value 0
${owned ? "let !candidate" : "let candidate"} = @array.set [x, 2, 3] 1 2
let region = Slice.copy ${owned ? "(!candidate)" : "candidate"}
let frozen = Slice.freeze (!region)
return case Array.get (frozen, 0) of
  #Some value => value
  #None => 0
`;

  const persistentWrites = async (owned: boolean): Promise<number> =>
    await withSource(source(owned), async (compiler, path) => {
      const hir = await compiler.prepare(path);
      return allOperations(hir).filter((operation) =>
        operation.kind === "store.write" && operation.update === "persistent"
      ).length;
    });

  assertEquals(await persistentWrites(false), 2);
  assertEquals(await persistentWrites(true), 1);
});

Deno.test("a user wrapper carries the rejoin witness across its boundary", async () => {
  // No compiler trust and no recognized name: the witness travels as an
  // ordinary linear value, so the wrapper certifies by deferring its join
  // proof to this call site.
  const source = `open import "blot:prelude"
let rejoin_parts ::
  (@region.rejoin, @region.type Int, @region.type Int) -> @region.type Int
let rejoin_parts =
  fn (!rejoin, !left, !right) => Slice.join ((!rejoin), (!left), (!right))
let whole = Slice.copy [7, 8, 9]
let restored = case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) => rejoin_parts ((!rejoin), (!left), (!right))
  #SplitOutOfBounds !original => original
let frozen = Slice.freeze (!restored)
return case Array.get (frozen, 2) of
  #Some value => value
  #None => 0
`;

  await withSource(source, async (compiler, path) => {
    const artifact = await compiler.compile(path);
    const run = await instantiateDefault(artifact.wasm);
    assertEquals(run(), 9n);
  });
});

Deno.test("a user wrapper cannot launder reversed parts past the witness", async () => {
  const source = `open import "blot:prelude"
let rejoin_parts ::
  (@region.rejoin, @region.type Int, @region.type Int) -> @region.type Int
let rejoin_parts =
  fn (!rejoin, !left, !right) => Slice.join ((!rejoin), (!left), (!right))
let whole = Slice.copy [7, 8, 9]
let restored = case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) => rejoin_parts ((!rejoin), (!right), (!left))
  #SplitOutOfBounds !original => original
return Slice.freeze (!restored)
`;

  const error = await assertRejects(
    () => withSource(source, (compiler, path) => compiler.check(path)),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_REGION_JOIN_UNPROVED");
});

Deno.test("a wrapper freeze of a split part is caught at the call site", async () => {
  // The full-root proof defers through the wrapper parameter and is
  // discharged against the caller's concrete part authority.
  const source = `open import "blot:prelude"
let freeze_it :: @region.type Int -> [Int]
let freeze_it = fn !region => Slice.freeze (!region)
let whole = Slice.copy [4, 5, 6]
return case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) => do:
    let frozen = freeze_it (!left)
    let restored = Slice.join ((!rejoin), (Slice.copy frozen), (!right))
    return Slice.freeze (!restored)
  #SplitOutOfBounds !original => Slice.freeze (!original)
`;

  const error = await assertRejects(
    () => withSource(source, (compiler, path) => compiler.check(path)),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_REGION_PARTIAL_FREEZE");
});

Deno.test("Rust ownership rejects reversed Slice siblings", async () => {
  const source = `open import "blot:prelude"
let whole = Slice.copy [3, 1, 2]
let restored = case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) => Slice.join ((!rejoin), (!right), (!left))
  #SplitOutOfBounds !original => original
return Slice.freeze (!restored)
`;

  const error = await assertRejects(
    () => withSource(source, (compiler, path) => compiler.check(path)),
    BlotError,
  );
  assertEquals(error.diagnostic.code, "BLOT_REGION_JOIN_UNPROVED");
});

Deno.test("live Slice capabilities are refused at Core Wasm ABI 1", async () => {
  const source = `module with !region
open import "blot:prelude"
let size = Slice.length (&region)
let frozen = Slice.freeze (!region)
return size + Array.length (&frozen)
`;

  const error = await assertRejects(
    () => withSource(source, (compiler, path) => compiler.compile(path)),
    Error,
  );
  assertStringIncludes(error.message, "live Region");
  assertStringIncludes(error.message, "ABI 1");
});
