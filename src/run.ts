// Running a blot program.
//
// The evaluator is the runtime until the gpufuck backend lands, and it is the
// same evaluator that runs `comptime`, so there is no second semantics to keep
// in agreement.

import {
  evaluateCoreModule,
  evaluationRuntime,
  type Host,
  type Perform,
  run,
} from "./comptime/eval.ts";
import { shapeOf, show, UNIT, type Value } from "./comptime/value.ts";
import { load } from "./load.ts";
import { checkFile } from "./check/mod.ts";

export interface Grants {
  /** Where a granted `print` capability writes. */
  readonly write: (line: string) => void;
}

/**
 * The record handed to the entry module is the entire authority the program
 * has. There is no ambient filesystem, no ambient clock, and nothing a module
 * can import to obtain more: a capability is an opaque host function, and a
 * program that was not handed one cannot reach it.
 */
export function grantsFor(grants: Grants): Value {
  const print: Value = {
    tag: "native",
    name: "print",
    arity: 1,
    applied: [],
    run: ([message]) => {
      grants.write(message.tag === "text" ? message.value : String(message));
      return UNIT;
    },
  };
  return shapeOf([["print", print]]);
}

/**
 * The host's answers, matching what `blot build` grants the compiled module.
 * Both sides implement the same declared effects, or the two runs disagree
 * about what the program does — which is the one thing they must not.
 */
function hostFor(grants: Grants): Host {
  return (perform: Perform): Value | null => {
    if (!perform.host) return null;
    if (perform.effectName === "Console" && perform.operation === "write") {
      const message = perform.argument;
      grants.write(message.tag === "text" ? message.value : show(message));
      return UNIT;
    }
    return null;
  };
}

export async function evaluateFile(
  path: string,
  grants: Grants,
): Promise<Value> {
  const checked = await checkFile(path);
  const loaded = await load(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error(`module ${path} did not load as a closure`);
  }
  let imports = loaded.closure.imports;
  if (imports === undefined) imports = new Map();
  return run(
    evaluateCoreModule(
      checked.core,
      grantsFor(grants),
      checked.values,
      evaluationRuntime(
        imports,
        "runtime",
        undefined,
        checked.recordAdaptations,
      ),
    ),
    hostFor(grants),
  );
}
