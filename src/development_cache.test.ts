import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DevelopmentProject } from "./development.ts";
import { DevelopmentRuntime } from "./development_runtime.ts";
import { isDevelopmentCachePath } from "./development_cache.ts";
import { writeActiveDevelopmentWorkload } from "../experiments/development-bench/active_workload.ts";

Deno.test("development graph cache survives restarts and never restores a browser revision", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeActiveDevelopmentWorkload({
      directory,
      unitCount: 2,
      helpersPerUnit: 4,
    });
    const cacheDirectory = join(directory, ".blot", "cache", "development");
    const create = () =>
      DevelopmentProject.create(workload.manifestPath, {
        cache: { mode: "disk" },
      });
    for (const restarted of [false, true]) {
      const project = await create();
      const runtime = new DevelopmentRuntime(() => ({}));
      try {
        const build = await project.activate(runtime);
        assertEquals(build.baseRevision, undefined);
        assertEquals(build.changedUnits.length, 3);
        assertEquals(build.retainedUnits, []);
        assertEquals(build.cache.warnings, []);
        if (restarted) {
          assert(build.cache.loadedEntries > 0);
          assert(
            Object.values(build.work.reusedFunctions).reduce(
              (sum, count) => sum + count,
              0,
            ) >= 4,
          );
          assertEquals(
            Object.keys(build.work.specializedFunctions).filter((path) =>
              path.endsWith("unit_1.blot")
            ),
            [],
          );
        } else {
          assertEquals(build.cache.loadedEntries, 0);
          assert(build.cache.storedEntries > 0);
        }
        const run = runtime.entryInstance.exports["blot:run"];
        const floatRun = runtime.entryInstance.exports["blot:float_run"];
        assert(typeof run === "function" && typeof floatRun === "function");
        for (const argument of [-7n, 0n, 7n, 17n]) {
          assertEquals(run(argument), workload.expectedInteger(argument, 1));
        }
        assertEquals(floatRun(0.5), 1);
        assert(project.isCachePath(join(cacheDirectory, "entry")));
        assert(project.isCachePath(join(directory, ".blot")));
        assert(!project.isCachePath(directory));
      } finally {
        project.destroy();
      }
    }

    let corruptions = 0;
    for await (const namespace of Deno.readDir(cacheDirectory)) {
      if (!namespace.isDirectory) continue;
      for await (
        const entry of Deno.readDir(join(cacheDirectory, namespace.name))
      ) {
        if (!entry.name.endsWith(".entry")) continue;
        await Deno.writeFile(
          join(cacheDirectory, namespace.name, entry.name),
          new Uint8Array([0]),
        );
        corruptions += 1;
      }
    }
    assert(corruptions > 0);
    const repaired = await create();
    try {
      const build = await repaired.activate(new DevelopmentRuntime(() => ({})));
      assertEquals(build.cache.rejectedEntries, corruptions);
      assertEquals(build.cache.loadedEntries, 0);
      assertEquals(build.work.reusedFunctions, {});
      assert(
        build.cache.warnings.every((warning) =>
          warning.includes("content digest mismatch")
        ),
      );
    } finally {
      repaired.destroy();
    }

    const invalid = await create();
    try {
      await invalid.setOverlay(
        workload.editedProviderPath,
        'open import "blot:prelude"\nconst run :: Int -> Int\nconst run = fn value => "wrong"\nreturn { .run = run; }\n',
      );
      await assertRejects(() => invalid.prepareBuild());
    } finally {
      invalid.destroy();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("cache mode disabled performs fresh specialization across edits", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeActiveDevelopmentWorkload({
      directory,
      unitCount: 2,
      helpersPerUnit: 4,
    });
    const project = await DevelopmentProject.create(workload.manifestPath, {
      cache: { mode: "disabled" },
    });
    try {
      const runtime = new DevelopmentRuntime(() => ({}));
      await project.activate(runtime);
      await project.setOverlay(
        workload.editedProviderPath,
        workload.providerSource(10),
      );
      const edited = await project.activate(runtime);
      assertEquals(edited.work.reusedFunctions, {});
      assert(
        Object.keys(edited.work.specializedFunctions).some((path) =>
          path.endsWith("unit_1.blot")
        ),
      );
      assertEquals(edited.changedUnits.map((unit) => unit.name), ["unit-0"]);
    } finally {
      project.destroy();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("cache watch exclusions respect directory boundaries", () => {
  assert(
    isDevelopmentCachePath(
      "/project/.blot/cache/entry",
      "/project/.blot/cache",
    ),
  );
  assert(
    isDevelopmentCachePath("/project/.blot/cache", "/project/.blot/cache"),
  );
  assert(
    !isDevelopmentCachePath(
      "/project/.blot/cache.blot",
      "/project/.blot/cache",
    ),
  );
  assert(!isDevelopmentCachePath("/project/main.blot", "/project/.blot/cache"));
});

Deno.test("changing an attached operator invalidates cached scalar graphs", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const manifest = join(directory, "blot.json");
    const provider = join(directory, "number.blot");
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({
        schema: "blot-project",
        version: 1,
        entryUnit: "app",
        units: { app: "./main.blot", number: "./number.blot" },
      }),
    );
    await Deno.writeTextFile(
      join(directory, "main.blot"),
      `
const number = import "./number.blot"
const run :: @type.int -> @type.int
const run = fn value => number.run value
return { .run = run; }
`,
    );
    const source = (increment: number) => `
infixl 60 (+) = Op.add
const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }
const add :: @type.int -> @type.int -> @type.int
const add = fn left => fn right => @int.add (@int.add left right) ${increment}
const Int = @type.attach @type.int "add" add
const run :: Int -> Int
const run = fn value => value + 2
return { .run = run; }
`;
    await Deno.writeTextFile(provider, source(1));
    const project = await DevelopmentProject.create(manifest);
    try {
      const runtime = new DevelopmentRuntime();
      await project.activate(runtime);
      const run = runtime.entryInstance.exports["blot:run"];
      assert(typeof run === "function");
      assertEquals(run(7n), 10n);
      await project.setOverlay(provider, source(5));
      const edited = await project.activate(runtime);
      assertEquals(edited.changedUnits.map((unit) => unit.name), ["number"]);
      assertEquals(run(7n), 14n);
    } finally {
      project.destroy();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("unavailable disk cache reports the failure and keeps compiling", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const workload = await writeActiveDevelopmentWorkload({
      directory,
      unitCount: 2,
      helpersPerUnit: 4,
    });
    const cacheDirectory = join(directory, "occupied");
    await Deno.writeTextFile(cacheDirectory, "This path is a file.");
    const project = await DevelopmentProject.create(workload.manifestPath, {
      cache: { mode: "disk", directory: cacheDirectory },
    });
    try {
      const runtime = new DevelopmentRuntime(() => ({}));
      const initial = await project.activate(runtime);
      assertEquals(initial.cache.loadedEntries, 0);
      assertEquals(initial.cache.storedEntries, 0);
      assertEquals(initial.cache.warnings.length, 1);
      assert(
        initial.cache.warnings[0].includes(
          "Compilation continues with memory caching",
        ),
      );
      await project.setOverlay(
        workload.editedProviderPath,
        workload.providerSource(10),
      );
      const edited = await project.activate(runtime);
      assert(
        Object.values(edited.work.reusedFunctions).some((count) => count > 0),
      );
      const run = runtime.entryInstance.exports["blot:run"];
      assert(typeof run === "function");
      assertEquals(run(7n), workload.expectedInteger(7n, 10));
    } finally {
      project.destroy();
    }
    await assertRejects(
      () =>
        DevelopmentProject.create(workload.manifestPath, {
          cache: { mode: "disk", directory },
        }),
      Error,
      "overlaps project source",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("development links distinguish static captures and survive shifted declarations", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const provider = join(directory, "provider.blot");
    const manifest = join(directory, "blot.json");
    const source = (offset: number, earlier: string) =>
      `open import "blot:prelude"
${earlier}
const make = fn offset => fn value => value + offset
const left :: Int -> Int
const left = make ${offset}
const right :: Int -> Int
const right = make 2
return { .left = left; .right = right; }
`;
    await Deno.writeTextFile(provider, source(1, "const earlier = 1"));
    await Deno.writeTextFile(
      join(directory, "main.blot"),
      `open import "blot:prelude"
const provider = import "./provider.blot"
const run :: Int -> Int
const run = fn value => provider.left value + provider.right value
return { .run = run; }
`,
    );
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({
        schema: "blot-project",
        version: 1,
        entryUnit: "app",
        units: { app: "./main.blot", provider: "./provider.blot" },
      }),
    );
    const project = await DevelopmentProject.create(manifest);
    const runtime = new DevelopmentRuntime(() => ({}));
    try {
      const initial = await project.activate(runtime);
      const run = runtime.entryInstance.exports["blot:run"];
      assert(typeof run === "function");
      assertEquals(run(7n), 17n);
      assertEquals(new Set(initial.edges.map((edge) => edge.name)).size, 2);
      await project.setOverlay(
        provider,
        source(10, "const earlier = 100000\nconst inserted = 42"),
      );
      const edited = await project.activate(runtime);
      assertEquals(edited.changedUnits.map((unit) => unit.name), ["provider"]);
      assertEquals(runtime.entryInstance.exports["blot:run"], run);
      assertEquals(run(7n), 26n);
    } finally {
      project.destroy();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
