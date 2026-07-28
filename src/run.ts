// Running a blot program.
//
// The evaluator is the runtime until the gpufuck backend lands, and it is the
// same evaluator that runs `comptime`, so there is no second semantics to keep
// in agreement.

import { apply, run } from "./comptime/eval.ts";
import { shapeOf, UNIT, type Value } from "./comptime/value.ts";
import { load } from "./load.ts";

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

export async function evaluateFile(
  path: string,
  grants: Grants,
): Promise<Value> {
  const loaded = await load(path);
  return run(
    apply(loaded.closure, grantsFor(grants), loaded.module.span, {
      imports: new Map(),
    }),
  );
}
