import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "./load.ts";
import {
  encodeModuleCapsule,
  MODULE_CAPSULE_SCHEMA,
  PACKAGE_FORMAT_VERSION,
  PackageArtifactError,
  readPackageManifest,
  resolvePackageExport,
} from "./package_format.ts";
import { parse } from "./syntax/parse.ts";
import { encodePortableModule } from "./syntax/portable.ts";

test("graph digests and capsule bytes do not depend on the host locale", () => {
  const program = `
    import { loadedConfigurationDigest } from "./src/compiler/revision.ts";
    import { encodeModuleCapsule, MODULE_CAPSULE_SCHEMA, PACKAGE_FORMAT_VERSION }
      from "./src/package_format.ts";
    import { parse } from "./src/syntax/parse.ts";
    import { encodePortableModule } from "./src/syntax/portable.ts";
    const parsed = await parse("return 42\\n");
    if (!parsed.ok) throw new Error("fixture did not parse");
    const includes = ["./ä.txt", "./z.txt"].map(specifier => ({
      specifier, path: specifier, text: specifier,
    }));
    const loaded = {
      path: "/entry.blot", source: "return 42\\n", module: parsed.module,
      storage: { tag: "source" }, dependencies: new Map(),
      includedFiles: new Map(includes.map(item => [item.specifier, {
        path: item.path, source: item.text,
      }])),
    };
    const capsule = await encodeModuleCapsule({
      schema: MODULE_CAPSULE_SCHEMA, version: PACKAGE_FORMAT_VERSION, root: "m0",
      modules: [{ id: "m0", name: "./entry.blot",
        ast: JSON.stringify(encodePortableModule(parsed.module)),
        imports: [], includes }],
    });
    console.log(JSON.stringify({
      locale: new Intl.Collator().resolvedOptions().locale,
      digest: loadedConfigurationDigest(loaded), capsule,
    }));
  `;
  const results = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      locale: string;
      digest: string;
      capsule: string;
    };
  });
  assert.notEqual(results[0].locale, results[1].locale);
  assert.equal(results[0].digest, results[1].digest);
  assert.equal(results[0].capsule, results[1].capsule);
});

test("capsule include edges cannot collide through a NUL separator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-capsule-edges-"));
  try {
    const parsed = await parse('const a = @include "a"\nreturn @include "b"\n');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("fixture did not parse");
    const capsule = await encodeModuleCapsule({
      schema: MODULE_CAPSULE_SCHEMA,
      version: PACKAGE_FORMAT_VERSION,
      root: "m0",
      modules: [{
        id: "m0",
        name: "./entry.blot",
        ast: JSON.stringify(encodePortableModule(parsed.module)),
        imports: [],
        includes: [{ specifier: "a\0b", path: "./data.txt", text: "data" }],
      }],
    });
    const path = join(directory, "invalid.blotc");
    await writeFile(path, capsule);
    await assert.rejects(
      () => load(path, new Map()),
      { name: "PackageArtifactError", message: /include edges.*do not match/ },
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("package resolution rejects a scoped traversal before filesystem lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-package-traversal-"));
  try {
    const modules = join(directory, "node_modules");
    await mkdir(modules);
    await writeFile(
      join(modules, "blot.json"),
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: { ".": { source: "./unexpected.blot" } },
      }),
    );
    await assert.rejects(
      () => resolvePackageExport("@scope/..", join(directory, "entry.blot")),
      PackageArtifactError,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("package export names reject nonportable path segments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-package-export-name-"));
  try {
    const path = join(directory, "blot.json");
    for (const name of ["./.", "./..", "./a/../b", "./a\\b", "./a\0b"]) {
      await writeFile(
        path,
        JSON.stringify({
          schema: "blot-package",
          version: PACKAGE_FORMAT_VERSION,
          exports: { [name]: { source: "./mod.blot" } },
        }),
      );
      await assert.rejects(
        () => readPackageManifest(path),
        PackageArtifactError,
      );
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("malformed package names fail before looking for a manifest", async () => {
  for (
    const specifier of [
      "@/name",
      "@scope",
      "pkg/../x",
      "pkg//x",
      "pkg\\x",
      "pkg/a\0b",
    ]
  ) {
    await assert.rejects(
      () =>
        resolvePackageExport(specifier, "/not-an-installed-project/main.blot"),
      {
        name: "PackageArtifactError",
        message: /not a valid Blot package specifier/,
      },
    );
  }
});

test("portable scoped package subpaths still resolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-package-valid-name-"));
  try {
    const packageRoot = join(
      directory,
      "node_modules",
      "@example",
      "package.name",
    );
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "blot.json"),
      JSON.stringify({
        schema: "blot-package",
        version: PACKAGE_FORMAT_VERSION,
        exports: { "./feature-v2": { source: "./feature.blot" } },
      }),
    );
    const exported = await resolvePackageExport(
      "@example/package.name/feature-v2",
      join(directory, "entry.blot"),
    );
    assert.equal(exported.source, join(packageRoot, "feature.blot"));
  } finally {
    await rm(directory, { recursive: true });
  }
});
