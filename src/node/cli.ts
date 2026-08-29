#!/usr/bin/env node

import { readFile, watch, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Compiler } from "../compiler.ts";
import { DevelopmentProject } from "../development.ts";
import { BlotError, render } from "../diagnostic.ts";
import { LoadError } from "../load.ts";
import { parse } from "../syntax/parse.ts";
import { runArtifact } from "./run.ts";

const [command, ...paths] = process.argv.slice(2);
if (
  command === undefined ||
  paths.length === 0 ||
  !["build", "check", "ast", "run", "dev"].includes(command)
) {
  console.error("usage: pnpm blot <build|check|ast|run> <path>...");
  console.error("       pnpm blot dev <blot.json>");
  process.exitCode = 2;
} else if (command === "dev") {
  if (paths.length !== 1) {
    console.error("usage: pnpm blot dev <blot.json>");
    process.exitCode = 2;
  } else await watchDevelopmentProject(paths[0]);
} else {
  const compiler = await Compiler.create();
  let failed = false;
  try {
    for (const path of paths) {
      try {
        if (command === "run") {
          const artifact = await compiler.compile(path);
          console.log(await runArtifact(artifact));
        } else if (command === "build") {
          const artifact = await compiler.compile(path);
          let output = `${path}.wasm`;
          if (path.endsWith(".blot")) output = path.slice(0, -5) + ".wasm";
          const manifest = `${output}.json`;
          await writeFile(output, artifact.wasm);
          await writeFile(manifest, artifact.manifestBytes);
          let imports = "";
          if (artifact.capabilities.length > 0) {
            imports = `, imports { ${artifact.capabilities.join(", ")} }`;
          }
          console.log(
            `${output}: ${artifact.wasm.byteLength} bytes${imports}, manifest ${manifest}`,
          );
        } else if (command === "check") {
          const checked = await compiler.check(path);
          console.log(`${path}: ${checked.type}${checked.effects}`);
        } else {
          const source = await readFile(resolve(path), "utf8");
          const parsed = await parse(source);
          if (!parsed.ok) {
            for (const diagnostic of parsed.diagnostics) {
              console.error(render(path, source, diagnostic));
            }
            failed = true;
            continue;
          }
          console.log(JSON.stringify(parsed.module, bigintJson, 2));
        }
      } catch (error) {
        failed = true;
        report(path, error);
      }
    }
  } finally {
    compiler.destroy();
  }
  if (failed) process.exitCode = 1;
}

async function watchDevelopmentProject(manifestPath: string): Promise<void> {
  let project = await DevelopmentProject.create(manifestPath);
  const projectRoot = dirname(project.manifest.path);
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once("SIGINT", stop);
  try {
    await reportDevelopmentBuild(project);
    const changes = watch(projectRoot, {
      recursive: true,
      signal: cancellation.signal,
    });
    for await (const change of changes) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      try {
        let manifestChanged = false;
        if (change.filename !== null) {
          manifestChanged = resolve(projectRoot, change.filename) ===
            project.manifest.path;
        }
        if (manifestChanged) {
          const replacement = await DevelopmentProject.create(manifestPath);
          try {
            await reportDevelopmentBuild(replacement);
          } catch (error) {
            replacement.destroy();
            throw error;
          }
          project.destroy();
          project = replacement;
          continue;
        }
        if (change.filename !== null) {
          await project.markChanged(resolve(projectRoot, change.filename));
        }
        await reportDevelopmentBuild(project);
      } catch (error) {
        report(project.manifest.path, error);
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    project.destroy();
  }
}

async function reportDevelopmentBuild(
  project: DevelopmentProject,
): Promise<void> {
  const build = await project.build();
  const changed = build.changedUnits.map((unit) => unit.name).join(", ");
  const retained = build.retainedUnits.map((unit) => unit.name).join(", ");
  const removed = build.removedUnits.join(", ");
  console.log(
    `${
      build.revision.slice(0, 12)
    }: changed [${changed}], retained [${retained}], removed [${removed}], ${
      build.durationMilliseconds.toFixed(1)
    } ms`,
  );
}

function bigintJson(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  return value;
}

function report(path: string, error: unknown): void {
  if (error instanceof LoadError) {
    console.error(error.message);
    return;
  }
  if (error instanceof BlotError && error.origin !== null) {
    console.error(
      render(error.origin.path, error.origin.source, error.diagnostic),
    );
    return;
  }
  let message = String(error);
  if (error instanceof Error) message = error.message;
  console.error(`${path}: ${message}`);
}
