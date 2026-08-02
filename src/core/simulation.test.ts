import { assertEquals } from "@std/assert";
import { checkFile } from "../check/mod.ts";
import { evaluateFile } from "../run.ts";
import type { CoreExpression, TypedCoreModule } from "./computation.ts";

type SimulatedValue = bigint | null | readonly SimulatedValue[];

function evaluateCore(core: TypedCoreModule): SimulatedValue {
  const scope = new Map<string, SimulatedValue>();
  for (const step of core.steps) {
    if (step.definition.tag !== "binding") {
      throw new Error("the generated core contains a non-binding definition");
    }
    if (step.definition.pattern.tag !== "name") {
      throw new Error("the generated core contains a non-name pattern");
    }
    scope.set(
      step.definition.pattern.name,
      evaluateExpression(step.definition.value, scope),
    );
  }
  let result: CoreExpression;
  if (core.result.tag === "return") result = core.result.value;
  else result = core.result.computation;
  return evaluateExpression(result, scope);
}

function evaluateExpression(
  expression: CoreExpression,
  scope: ReadonlyMap<string, SimulatedValue>,
): SimulatedValue {
  if (expression.tag === "int") return expression.value;
  if (expression.tag === "unit") return null;
  if (expression.tag === "var") {
    const value = scope.get(expression.name);
    if (value === undefined) {
      throw new Error(`generated core reads unbound \`${expression.name}\``);
    }
    return value;
  }
  if (expression.tag === "tuple") {
    return expression.elements.map((element) =>
      evaluateExpression(element, scope)
    );
  }
  throw new Error(`generated core contains unsupported ${expression.tag}`);
}

function next(seed: number): number {
  let value = seed;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

Deno.test("typed Core elaboration simulates generated pure surface programs", async () => {
  const directory = await Deno.makeTempDir();
  let seed = 0x5eed1234;
  for (let example = 0; example < 32; example += 1) {
    const declarations: string[] = [];
    const values: bigint[] = [];
    for (let index = 0; index < 12; index += 1) {
      seed = next(seed);
      const value = BigInt(seed % 1000);
      values.push(value);
      declarations.push(`let value_${index} = ${value};`);
      declarations.push(`let unused_${index} = ${value + 1n};`);
    }
    seed = next(seed);
    const first = seed % values.length;
    seed = next(seed);
    const second = seed % values.length;
    const source = `${declarations.join("\n")}
return (value_${first}, value_${second});`;
    const path = `${directory}/generated_${example}.blot`;
    await Deno.writeTextFile(path, source);

    const checked = await checkFile(path);
    const direct = await evaluateFile(path, { write: () => {} });
    if (direct.tag !== "shape") {
      throw new Error("generated surface result is not a tuple");
    }
    const directValues = [...direct.fields.values()].map((value) => {
      if (value.tag !== "int") {
        throw new Error("generated surface tuple contains a non-integer");
      }
      return value.value;
    });
    assertEquals(evaluateCore(checked.core), directValues);
  }
});
