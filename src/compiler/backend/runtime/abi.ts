import type { BlotEffectOwnership } from "../../../runtime/hir.ts";

export const blotAbiCustomSectionName = "blot:abi";

export type BlotAbiType =
  | {
    readonly kind: "callback";
    readonly entry: string;
    readonly function: BlotAbiFunction;
    readonly environment: BlotAbiType;
  }
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | {
    readonly kind: "resource";
    readonly name: string;
    readonly payload: BlotAbiType;
  }
  | { readonly kind: "array"; readonly element: BlotAbiType }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly type: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly {
      readonly name: string;
      readonly payload?: BlotAbiType;
    }[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly inner: BlotAbiType;
  };

export type BlotAbiFunction = {
  readonly parameters: readonly BlotAbiType[];
  readonly result: BlotAbiType;
};

export type BlotAbiManifest = {
  readonly format: "blot-core-wasm";
  readonly abi: {
    readonly major: 3;
    readonly minor: 0;
    readonly memory: "memory32";
    readonly stringEncoding: "utf-8";
    readonly maximumFlatParameters: 16;
    readonly maximumFlatResults: 1;
    readonly memoryExport: "memory";
    readonly reallocExport: "cabi_realloc";
  };
  readonly source: string;
  readonly callbacks: readonly {
    readonly name: string;
    readonly function: BlotAbiFunction;
  }[];
  readonly exports: readonly {
    readonly sourceName: string;
    readonly name: string | null;
    readonly phase: "runtime" | "comptime";
    readonly execution: "direct" | "resumable" | "comptime";
    readonly function: BlotAbiFunction | null;
    readonly postReturn: string | null;
    readonly effects: readonly string[];
    readonly ownership: "owned" | null;
  }[];
  readonly imports: readonly {
    readonly capability: string;
    readonly operation: string;
    readonly sourceName: string;
    readonly module: string;
    readonly name: string;
    readonly function: BlotAbiFunction;
    readonly contract: {
      readonly input: BlotEffectOwnership;
      readonly result: BlotEffectOwnership;
      readonly suspends: boolean;
    };
  }[];
  readonly links?: readonly {
    readonly unit: string;
    readonly name: string;
    readonly module: string;
    readonly function: BlotAbiFunction;
    readonly suspends: boolean;
  }[];
};

export function flattenedAbiType(
  type: BlotAbiType,
): readonly ("i32" | "i64" | "f32" | "f64")[] {
  if (type.kind === "unit") return [];
  if (type.kind === "signed-integer-64" || type.kind === "resource") {
    return ["i64"];
  }
  if (type.kind === "float-32") return ["f32"];
  if (type.kind === "float-64") return ["f64"];
  if (type.kind === "boolean") return ["i32"];
  if (type.kind === "text" || type.kind === "array") return ["i32", "i32"];
  if (type.kind === "sealed") return flattenedAbiType(type.inner);
  if (type.kind === "callback") return flattenedAbiType(type.environment);
  if (type.kind === "record") {
    return type.fields.flatMap((field) => flattenedAbiType(field.type));
  }
  let payload: ("i32" | "i64" | "f32" | "f64")[] = [];
  for (const case_ of type.cases) {
    let casePayload: readonly ("i32" | "i64" | "f32" | "f64")[] = [];
    if (case_.payload !== undefined) {
      casePayload = flattenedAbiType(case_.payload);
    }
    const joined: ("i32" | "i64" | "f32" | "f64")[] = [];
    const length = Math.max(payload.length, casePayload.length);
    for (let index = 0; index < length; index += 1) {
      const left = payload[index];
      const right = casePayload[index];
      if (left === undefined) {
        if (right === undefined) joined.push("i32");
        else joined.push(right);
      } else if (right === undefined || left === right) joined.push(left);
      else if (
        (left === "i32" || left === "f32") &&
        (right === "i32" || right === "f32")
      ) joined.push("i32");
      else joined.push("i64");
    }
    payload = joined;
  }
  return ["i32", ...payload];
}

export function requireDirectBlotAbiBoundary(
  manifest: BlotAbiManifest,
): void {
  for (const exported of manifest.exports) {
    if (exported.function === null) continue;
    requireDirectParameterCount(
      exported.function,
      manifest.abi.maximumFlatParameters,
      `export ${exported.name}`,
    );
    for (const [parameter, type] of exported.function.parameters.entries()) {
      requireDirectAbiType(
        type,
        `export ${exported.name} parameter ${parameter}`,
      );
    }
    requireDirectAbiType(
      exported.function.result,
      `export ${exported.name} result`,
    );
  }
  for (const imported of manifest.imports) {
    requireDirectParameterCount(
      imported.function,
      manifest.abi.maximumFlatParameters,
      `import ${imported.module}.${imported.name}`,
    );
    for (const [parameter, type] of imported.function.parameters.entries()) {
      requireDirectAbiType(
        type,
        `import ${imported.module}.${imported.name} parameter ${parameter}`,
      );
    }
    requireDirectAbiType(
      imported.function.result,
      `import ${imported.module}.${imported.name} result`,
    );
  }
}

function requireDirectParameterCount(
  function_: BlotAbiFunction,
  maximumFlatParameters: number,
  position: string,
): void {
  const flatParameters = function_.parameters.flatMap(flattenedAbiType).length;
  if (flatParameters <= maximumFlatParameters) return;
  throw new TypeError(
    `${position} has ${flatParameters} flat parameters; Blot ABI 3 currently admits at most ${maximumFlatParameters}`,
  );
}

function requireDirectAbiType(type: BlotAbiType, position: string): void {
  if (
    type.kind === "unit" ||
    type.kind === "signed-integer-64" || type.kind === "float-32" ||
    type.kind === "float-64" || type.kind === "boolean"
  ) return;
  if (type.kind === "record") {
    for (const field of type.fields) {
      requireDirectAbiType(field.type, `${position}.${field.name}`);
    }
    return;
  }
  throw new TypeError(
    `${position} uses ${type.kind}; the direct Blot ABI 3 path currently admits only flat values`,
  );
}
