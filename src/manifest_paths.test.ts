import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  PACKAGE_FORMAT_VERSION,
  PackageArtifactError,
  readPackageManifest,
} from "./package_format.ts";
import {
  PROJECT_FORMAT_VERSION,
  ProjectManifestError,
  readProjectManifest,
} from "./project_format.ts";

async function withManifest(
  operation: (path: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "blot-manifest-paths-"));
  try {
    await operation(join(root, "blot.json"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function projectSource(path: string, target: string): Promise<string> {
  await writeFile(path, JSON.stringify({
    schema: "blot-project",
    version: PROJECT_FORMAT_VERSION,
    entryUnit: "main",
    units: { main: target },
  }));
  const manifest = await readProjectManifest(path);
  const source = manifest.units.get(manifest.entryUnit);
  assert.ok(source !== undefined);
  return source;
}

async function packageTargets(
  path: string,
  source: string,
  built = "./dist/main.blotc",
): Promise<{ readonly source: string; readonly built?: string }> {
  await writeFile(path, JSON.stringify({
    schema: "blot-package",
    version: PACKAGE_FORMAT_VERSION,
    exports: { ".": { source, built } },
  }));
  const manifest = await readPackageManifest(path);
  const exported = manifest.exports.get(".");
  assert.ok(exported !== undefined);
  return exported;
}

for (const target of ["../outside.blot", "../outside\\file.blot"]) {
  test(`both manifest readers reject ${JSON.stringify(target)}`, async () => {
    await withManifest(async (path) => {
      await assert.rejects(() => projectSource(path, target), {
        name: "ProjectManifestError",
        message: /escapes its project/,
      });
      await assert.rejects(() => packageTargets(path, target), {
        name: "PackageArtifactError",
        message: /escapes its package/,
      });
    });
  });
}

for (
  const target of ["./src/../main.blot", "./..hidden/main.blot", "./a\\b.blot"]
) {
  test(`both manifest readers retain ${JSON.stringify(target)}`, async () => {
    await withManifest(async (path, root) => {
      assert.equal(await projectSource(path, target), resolve(root, target));
      const exported = await packageTargets(path, target);
      assert.equal(exported.source, resolve(root, target));
      assert.equal(exported.built, join(root, "dist", "main.blotc"));
    });
  });
}

test("backslashes follow the host path rules, not filename heuristics", async () => {
  await withManifest(async (path, root) => {
    const target = "./..\\inside.blot";
    if (sep === "\\") {
      await assert.rejects(
        () => projectSource(path, target),
        ProjectManifestError,
      );
      await assert.rejects(
        () => packageTargets(path, target),
        PackageArtifactError,
      );
      return;
    }
    assert.equal(
      await projectSource(path, target),
      join(root, "..\\inside.blot"),
    );
    assert.equal(
      (await packageTargets(path, target, "./..\\inside.blotc")).built,
      join(root, "..\\inside.blotc"),
    );
  });
});

test("built targets use the same confinement check as source targets", async () => {
  await withManifest(async (path) => {
    for (const target of ["../outside.blotc", "../outside\\file.blotc"]) {
      await assert.rejects(() => packageTargets(path, "./main.blot", target), {
        name: "PackageArtifactError",
        message: /escapes its package/,
      });
    }
  });
});

test("absolute manifest targets remain rejected even inside the root", async () => {
  await withManifest(async (path, root) => {
    await assert.rejects(() => projectSource(path, join(root, "main.blot")), {
      name: "ProjectManifestError",
      message: /absolute source/,
    });
    await assert.rejects(() => packageTargets(path, join(root, "main.blot")), {
      name: "PackageArtifactError",
      message: /absolute target/,
    });
    await assert.rejects(
      () => packageTargets(path, "./main.blot", join(root, "main.blotc")),
      { name: "PackageArtifactError", message: /absolute target/ },
    );
  });
});

test("normalized project aliases still count as repeated roots", async () => {
  await withManifest(async (path) => {
    await writeFile(path, JSON.stringify({
      schema: "blot-project",
      version: PROJECT_FORMAT_VERSION,
      entryUnit: "main",
      units: { main: "./main.blot", alias: "./src/../main.blot" },
    }));
    await assert.rejects(() => readProjectManifest(path), {
      name: "ProjectManifestError",
      message: /repeat source/,
    });
  });
});
