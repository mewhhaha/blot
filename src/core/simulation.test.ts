import { assertEquals } from "@std/assert";
import { checkFile } from "../check/mod.ts";
import { evaluateFile } from "../run.ts";
import type { Pattern } from "../syntax/ast.ts";
import type { CoreExpression, TypedCoreModule } from "./computation.ts";

interface SimulatedClosure {
  readonly tag: "closure";
  readonly parameter: Pattern;
  readonly body: CoreExpression;
  readonly scope: ReadonlyMap<string, SimulatedValue>;
}

interface SimulatedHostEffect {
  readonly tag: "host-effect";
  readonly name: string;
}

interface SimulatedHostOperation {
  readonly tag: "host-operation";
  readonly effect: string;
  readonly name: string;
}

type SimulatedValue =
  | bigint
  | string
  | null
  | readonly SimulatedValue[]
  | SimulatedClosure
  | SimulatedHostEffect
  | SimulatedHostOperation;

interface SimulatedRuntime {
  readonly writes: string[];
}

function evaluateCore(
  core: TypedCoreModule,
  runtime: SimulatedRuntime = { writes: [] },
): SimulatedValue {
  return evaluateComputation(core, new Map(), runtime);
}

function evaluateComputation(
  core: Pick<TypedCoreModule, "steps" | "result">,
  scope: Map<string, SimulatedValue>,
  runtime: SimulatedRuntime,
): SimulatedValue {
  for (const step of core.steps) {
    if (step.definition.tag === "open") continue;
    if (step.definition.tag === "static") {
      if (step.definition.pattern.tag !== "name") {
        throw new Error(
          "the generated core contains a compound static pattern",
        );
      }
      const value = step.definition.value;
      if (value.tag !== "effect") {
        throw new Error(
          "the generated core contains an unsupported static value",
        );
      }
      scope.set(step.definition.pattern.name, {
        tag: "host-effect",
        name: value.name,
      });
      continue;
    }
    if (step.definition.tag === "static-shadow") {
      throw new Error("the generated core contains a static shadow");
    }
    if (step.definition.tag !== "binding") {
      throw new Error("the generated core contains a non-binding definition");
    }
    if (step.definition.pattern.tag !== "name") {
      throw new Error("the generated core contains a non-name pattern");
    }
    const value = evaluateExpression(step.definition.value, scope, runtime);
    bindPattern(step.definition.pattern, value, scope);
  }
  let result: CoreExpression;
  if (core.result.tag === "return") result = core.result.value;
  else result = core.result.computation;
  return evaluateExpression(result, scope, runtime);
}

function evaluateExpression(
  expression: CoreExpression,
  scope: ReadonlyMap<string, SimulatedValue>,
  runtime: SimulatedRuntime,
): SimulatedValue {
  if (expression.tag === "int") return expression.value;
  if (expression.tag === "unit") return null;
  if (expression.tag === "text") return expression.value;
  if (expression.tag === "constant" && expression.value.tag === "effect") {
    if (!expression.value.host) {
      throw new Error("generated Core contains an unhandled local effect");
    }
    return { tag: "host-effect", name: expression.value.name };
  }
  if (expression.tag === "var") {
    const value = scope.get(expression.name);
    if (value === undefined) {
      throw new Error(`generated core reads unbound \`${expression.name}\``);
    }
    return value;
  }
  if (expression.tag === "tuple") {
    return expression.elements.map((element) =>
      evaluateExpression(element, scope, runtime)
    );
  }
  if (expression.tag === "lambda") {
    return {
      tag: "closure",
      parameter: expression.parameter,
      body: expression.body,
      scope,
    };
  }
  if (expression.tag === "apply") {
    const fn = evaluateExpression(expression.fn, scope, runtime);
    const argument = evaluateExpression(expression.arg, scope, runtime);
    if (isSimulatedHostOperation(fn)) {
      if (fn.effect === "Console" && fn.name === "write") {
        if (typeof argument !== "string") {
          throw new Error("Console.write received a non-text argument");
        }
        runtime.writes.push(argument);
        return null;
      }
      throw new Error(
        `generated Core performs unsupported ${fn.effect}.${fn.name}`,
      );
    }
    if (!isSimulatedClosure(fn)) {
      throw new Error("generated Core applies a non-function");
    }
    const inner = new Map(fn.scope);
    bindPattern(fn.parameter, argument, inner);
    return evaluateExpression(fn.body, inner, runtime);
  }
  if (expression.tag === "field") {
    const target = evaluateExpression(expression.target, scope, runtime);
    if (isSimulatedHostEffect(target)) {
      return {
        tag: "host-operation",
        effect: target.name,
        name: expression.name,
      };
    }
    throw new Error(`generated Core projects unsupported .${expression.name}`);
  }
  if (expression.tag === "block") {
    return evaluateComputation(
      expression.computation,
      new Map(scope),
      runtime,
    );
  }
  if (expression.tag === "static-member-apply") {
    const arguments_ = expression.args.map((argument) =>
      evaluateExpression(argument, scope, runtime)
    );
    if (
      expression.target === "Console" && expression.name === "write" &&
      typeof arguments_[0] === "string"
    ) {
      runtime.writes.push(arguments_[0]);
      return null;
    }
    throw new Error(
      `generated Core contains unsupported static call ${expression.target}.${expression.name}`,
    );
  }
  throw new Error(`generated core contains unsupported ${expression.tag}`);
}

function isSimulatedClosure(value: SimulatedValue): value is SimulatedClosure {
  return typeof value === "object" && value !== null && "tag" in value &&
    value.tag === "closure";
}

function isSimulatedHostEffect(
  value: SimulatedValue,
): value is SimulatedHostEffect {
  return typeof value === "object" && value !== null && "tag" in value &&
    value.tag === "host-effect";
}

function isSimulatedHostOperation(
  value: SimulatedValue,
): value is SimulatedHostOperation {
  return typeof value === "object" && value !== null && "tag" in value &&
    value.tag === "host-operation";
}

function bindPattern(
  pattern: Pattern,
  value: SimulatedValue,
  scope: Map<string, SimulatedValue>,
): void {
  if (pattern.tag === "name") {
    scope.set(pattern.name, value);
    return;
  }
  if (pattern.tag === "wildcard" || pattern.tag === "unit") return;
  throw new Error(`generated Core contains unsupported ${pattern.tag} binder`);
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

Deno.test("typed Core preserves host effect order", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/effects.blot`;
  await Deno.writeTextFile(
    path,
    `open {} = (@import "blot:prelude") ();
const Console = @effect.host { .write = Str -> Unit; };
_ <- Console.write "compiled";
_ <- Console.write "linked";
result <- Console.write "done";
return result;`,
  );
  const directWrites: string[] = [];
  const direct = await evaluateFile(path, {
    write: (line) => directWrites.push(line),
  });
  const checked = await checkFile(path);
  const coreRuntime: SimulatedRuntime = { writes: [] };
  const core = evaluateCore(checked.core, coreRuntime);

  assertEquals(direct.tag, "unit");
  assertEquals(core, null);
  assertEquals(coreRuntime.writes, directWrites);
  assertEquals(coreRuntime.writes, ["compiled", "linked", "done"]);
});
