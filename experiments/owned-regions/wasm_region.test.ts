import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { BlotError } from "../../src/diagnostic.ts";
import { Compiler } from "../../src/compiler/session.ts";
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
  const instance = await WebAssembly.instantiate(module, imports);
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
    assertEquals(
      operations.filter((operation) => operation.kind === "store.empty").length,
      1,
      "only the source array allocation may create an empty Store",
    );
    assertEquals(
      operations.filter((operation) => operation.kind === "store.grow").length,
      9,
      "only the nine source elements may grow a Store",
    );
    assertEquals(
      operations.filter((operation) => operation.kind === "store.new").length,
      0,
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
    assertEquals(run(), 123456789n);
  });
});

Deno.test("Slice-relative get and set cannot reach a sibling Region", async () => {
  const source = `open import "blot:prelude"
let whole = Slice.claim [10, 20, 30]
return case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) =>
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
  #SplitOutOfBounds !original =>
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
let whole = Slice.claim [4, 5, 6]
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

Deno.test("Slice claim copies shared Stores but reuses proven private Stores", async () => {
  const source = (owned: boolean) =>
    `open import "blot:prelude"
const Source = @effect.host { .value = Int -> Int; }
x <- Source.value 0
${owned ? "let !candidate" : "let candidate"} = @array.set [x, 2, 3] 1 2
let region = Slice.claim ${owned ? "(!candidate)" : "candidate"}
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
sig rejoin_parts =
  (@region.rejoin, @region.type Int, @region.type Int) -> @region.type Int
let rejoin_parts =
  fn (!rejoin, !left, !right) => Slice.join ((!rejoin), (!left), (!right))
let whole = Slice.claim [7, 8, 9]
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
sig rejoin_parts =
  (@region.rejoin, @region.type Int, @region.type Int) -> @region.type Int
let rejoin_parts =
  fn (!rejoin, !left, !right) => Slice.join ((!rejoin), (!left), (!right))
let whole = Slice.claim [7, 8, 9]
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
sig freeze_it = @region.type Int -> [Int]
let freeze_it = fn !region => Slice.freeze (!region)
let whole = Slice.claim [4, 5, 6]
return case Slice.split ((!whole), 1) of
  #Split (!left, !right, !rejoin) =>
    let frozen = freeze_it (!left)
    let restored = Slice.join ((!rejoin), (Slice.claim frozen), (!right))
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
let whole = Slice.claim [3, 1, 2]
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
  const source = `open import "blot:prelude"
sig length = (@region.type Int) -> Int
let length = fn !region =>
  let size = Slice.length (&region)
  let frozen = Slice.freeze (!region)
  let _ = Array.length (&frozen)
  return size
return length
`;

  const error = await assertRejects(
    () => withSource(source, (compiler, path) => compiler.compile(path)),
    Error,
  );
  assertStringIncludes(error.message, "live Region");
  assertStringIncludes(error.message, "ABI 1");
});
