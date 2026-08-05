import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { dirname, relative } from "@std/path";
import {
  evaluateCoreModule,
  evaluationRuntime,
  run,
} from "../../src/comptime/eval.ts";
import { UNIT, type Value } from "../../src/comptime/value.ts";
import { checkFile } from "../../src/check/mod.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { load, type Loaded } from "../../src/load.ts";
import { RustMiddle } from "../../src/backend/rust_middle_wasm.ts";
import { layoutSource } from "./layout_source.ts";

let roots = Deno.args;
if (roots.length === 0) {
  roots = [
    "examples/minimal.blot",
    "examples/arithmetic.blot",
    "examples/conditions.blot",
    "examples/data.blot",
    "examples/collections.blot",
  ];
}
const wasm = await Deno.readFile(
  new URL("../../generated/rust-middle/compiler.wasm", import.meta.url),
);
const rust = await RustMiddle.load(wasm);
const session = rust.createCompilerSession();

try {
  const loadedModules = new Map<string, Loaded>();
  for (const root of roots) collect(await load(resolve(root)), loadedModules);
  for (const loaded of loadedModules.values()) {
    const added = rust.addCompilerSessionModule(
      session,
      loaded.path,
      (await layoutSource(loaded.path, loaded.source)).source,
    );
    if (!added.ok) throw new Error(`${loaded.path}: ${added.message}`);
  }
  for (const loaded of loadedModules.values()) {
    rust.configureCompilerSessionModule(session, loaded.path, {
      imports: Object.fromEntries(
        [...loaded.dependencies].map(([specifier, dependency]) => [
          specifier,
          dependency.path,
        ]),
      ),
      includes: Object.fromEntries(
        [...loaded.includedFiles].map(([specifier, included]) => [
          specifier,
          {
            path: normalizedIncludePath(loaded.path, included.path),
            text: included.source,
          },
        ]),
      ),
    });
  }

  const skipped: string[] = [];
  const failures: { readonly root: string; readonly message: string }[] = [];
  let compared = 0;
  for (const root of roots) {
    try {
      const loaded = loadedModules.get(resolve(root));
      if (loaded === undefined || loaded.closure.tag !== "closure") {
        throw new Error(`${root}: module closure is unavailable`);
      }
      const rustChecked = rust.checkCompilerSessionModule(session, loaded.path);
      if (!rustChecked.ok) {
        let code = rustChecked.diagnostic?.code;
        if (code === undefined) code = rustChecked.message;
        let message = rustChecked.diagnostic?.message;
        if (message === undefined) message = "";
        let start: number | string = "?";
        if (rustChecked.diagnostic !== undefined) {
          start = rustChecked.diagnostic.span.start;
        }
        throw new Error(
          `${root}: Rust checking failed: ${code} ${message} @${start}`,
        );
      }
      if (loaded.module.parameter !== null) {
        skipped.push(root);
        continue;
      }
      let imports = loaded.closure.imports;
      if (imports === undefined) imports = new Map();
      const checked = await checkFile(loaded.path);
      const typescript = run(
        evaluateCoreModule(
          checked.core,
          UNIT,
          checked.values,
          evaluationRuntime(
            imports,
            "runtime",
            undefined,
            checked.recordAdaptations,
          ),
        ),
      );
      const evaluated = rust.evaluateCompilerSessionModule(
        session,
        loaded.path,
      );
      if (!evaluated.ok) {
        let code = evaluated.diagnostic?.code;
        if (code === undefined) code = evaluated.message;
        let message = evaluated.diagnostic?.message;
        if (message === undefined) message = "";
        throw new Error(
          `${root}: Rust evaluation failed: ${code} ${message}`,
        );
      }
      assertEquals(
        canonicalJson(evaluated.value),
        canonicalValue(typescript),
        root,
      );
      compared += 1;
    } catch (error) {
      if (
        error instanceof BlotError &&
        error.diagnostic.code === "BLOT_UNHANDLED_EFFECT"
      ) {
        const loaded = loadedModules.get(resolve(root));
        if (loaded === undefined) throw error;
        const evaluated = rust.evaluateCompilerSessionModule(
          session,
          loaded.path,
        );
        if (
          !evaluated.ok &&
          evaluated.diagnostic?.code === "BLOT_UNHANDLED_EFFECT"
        ) {
          skipped.push(root);
          continue;
        }
      }
      failures.push({
        root,
        message: errorMessage(error),
      });
    }
  }
  console.log(JSON.stringify({ compared, skipped, failures }, null, 2));
  if (failures.length > 0) Deno.exitCode = 1;
} finally {
  rust.destroyCompilerSession(session);
}

function collect(loaded: Loaded, modules: Map<string, Loaded>): void {
  if (modules.has(loaded.path)) return;
  modules.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collect(dependency, modules);
  }
}

function canonicalValue(value: Value): unknown {
  switch (value.tag) {
    case "int":
      return { tag: "int", value: value.value.toString() };
    case "float":
    case "float32":
      return { tag: value.tag, value: value.value };
    case "vector":
    case "vector-mask":
      return { tag: value.tag, lanes: value.lanes };
    case "text":
      return { tag: "text", value: value.value };
    case "unit":
      return { tag: "unit" };
    case "shape":
      return {
        tag: "shape",
        fields: [...value.fields].sort(([left], [right]) =>
          left.localeCompare(right)
        ).map(([name, member]) => [name, canonicalValue(member)]),
      };
    case "array":
      return { tag: "array", elements: value.elements.map(canonicalValue) };
    case "tag": {
      let payload: unknown = null;
      if (value.payload !== null) payload = canonicalValue(value.payload);
      return {
        tag: "tag",
        name: value.name,
        payload,
      };
    }
    case "range": {
      let domain: string | null = null;
      if (value.domain !== undefined) domain = value.domain;
      return {
        tag: "range",
        low: canonicalValue(value.low),
        high: canonicalValue(value.high),
        domain,
      };
    }
    case "union":
      return { tag: "union", members: value.members.map(canonicalValue) };
    case "unbounded":
      return { tag: "unbounded" };
    case "arrow":
      return {
        tag: "arrow",
        domain: canonicalValue(value.domain),
        codomain: canonicalValue(value.codomain),
        effects: value.effects.map(canonicalValue),
      };
    case "type-variable":
      return { tag: "type-variable", id: value.id };
    case "forall":
      return {
        tag: "forall",
        variable: value.variable,
        body: canonicalValue(value.body),
      };
    case "effect":
      return {
        tag: "effect",
        id: value.id,
        name: value.name,
        host: value.host,
        operations: [...value.operations].sort(([left], [right]) =>
          left.localeCompare(right)
        ).map(([name, operation]) => [name, canonicalValue(operation)]),
      };
    case "operation":
      return {
        tag: "operation",
        effect: canonicalValue(value.effect),
        name: value.name,
      };
    case "extended":
      return {
        tag: "extended",
        inner: canonicalValue(value.inner),
        members: [...value.members].sort(([left], [right]) =>
          left.localeCompare(right)
        ).map(([name, member]) => [name, canonicalValue(member)]),
      };
    case "sealed":
      return {
        tag: "sealed",
        name: value.name,
        inner: canonicalValue(value.inner),
      };
    case "opaque-type":
      return { tag: "opaque-type", name: value.name };
    default:
      return { tag: "opaque", display: "<function>" };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const canonical = Object.fromEntries(
    Object.entries(object).map(([name, member]) => [
      name,
      canonicalJson(member),
    ]),
  );
  for (const name of ["fields", "members", "operations"]) {
    const entries = canonical[name];
    if (!Array.isArray(entries)) continue;
    if (!entries.every((entry) => Array.isArray(entry))) continue;
    entries.sort((left, right) => {
      const leftName = (left as unknown[])[0];
      const rightName = (right as unknown[])[0];
      return String(leftName).localeCompare(String(rightName));
    });
  }
  return canonical;
}

function normalizedIncludePath(importer: string, included: string): string {
  let path = relative(dirname(importer), included).replaceAll("\\", "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return path;
}
