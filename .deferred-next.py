from pathlib import Path
import subprocess


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


# The temporary validation hook still reapplies these two already-verified
# changes. Restore its old anchors here so the hook can remain idempotent.
replace_once(
    "src/check/infer.ts",
    '''  if ((expr.deferred ?? false) !== (expected.deferred ?? false)) {
    fail(
      "BLOT_TYPE_ERROR",
      expected.deferred === true
        ? "This function signature requires a deferred parameter; write fn ~name => ...."
        : "This function signature requires a strict parameter; remove ~ from the lambda parameter.",
      expr.span,
    );
  }

  const scope = childTypeEnv(context.types);
  const inner: Context = { ...context, types: scope };
  bindPatternAgainst(expr.parameter, expected.param, inner, level + 1);''',
    '''  const scope = childTypeEnv(context.types);
  const inner: Context = { ...context, types: scope };
  bindPatternAgainst(expr.parameter, expected.param, inner, level + 1);''',
)
replace_once(
    "src/check/infer.ts",
    '''  if (type.tag === "fun") {
    return {
      tag: "fun",
      param: stableRebindingType(type.param),
      effects: stableRebindingType(type.effects),
      result: stableRebindingType(type.result),
      deferred: type.deferred,
    };
  }''',
    '''  if (type.tag === "fun") {
    return {
      tag: "fun",
      param: stableRebindingType(type.param),
      effects: stableRebindingType(type.effects),
      result: stableRebindingType(type.result),
    };
  }''',
)

Path("src/check/deferred.ts").write_text(r'''import type { Diagnostic } from "../diagnostic.ts";
import type { Ownership } from "../linear/check.ts";
import {
  type Decl,
  type Expr,
  type Module,
  patternNames,
} from "../syntax/ast.ts";
import { liveDeclarations } from "../syntax/live.ts";
import type { SimpleType } from "./type.ts";

type FunctionType = Extract<SimpleType, { readonly tag: "fun" }>;
type DemandState = "fresh" | "spent" | "maybe";
type DemandEnv = Map<string, number | null>;
type Demands = Map<number, DemandState>;

export interface DeferredUsage {
  readonly diagnostics: readonly Diagnostic[];
  readonly arguments: readonly Expr[];
}

export function functionType(
  type: SimpleType | undefined,
  seen = new Set<number>(),
): FunctionType | null {
  if (type === undefined) return null;
  if (type.tag === "fun") return type;
  if (type.tag === "forall") return functionType(type.body, seen);
  if (type.tag !== "var" || seen.has(type.id)) return null;
  seen.add(type.id);

  let found: FunctionType | null = null;
  for (const bound of [...type.lower, ...type.upper]) {
    const candidate = functionType(bound, seen);
    if (candidate === null) continue;
    if (found === null) {
      found = candidate;
      continue;
    }
    if ((found.deferred ?? false) !== (candidate.deferred ?? false)) return null;
  }
  return found;
}

export function checkDeferredUsage(
  module: Module,
  expressionTypes: ReadonlyMap<Expr, SimpleType>,
  opens: ReadonlyMap<Expr, ReadonlyMap<string, unknown>>,
): DeferredUsage {
  const analysis = new DemandAnalysis(expressionTypes, opens);
  analysis.walkModule(module);
  return { diagnostics: analysis.diagnostics, arguments: analysis.arguments };
}

export function checkDeferredLinearArguments(
  arguments_: readonly Expr[],
  ownership: Ownership,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const argument of arguments_) {
    for (const [pattern, qualifier] of ownership.qualifiers) {
      if (qualifier !== "linear") continue;
      const consumptions = ownership.consumptions.get(pattern) ?? [];
      if (
        consumptions.some((span) =>
          argument.span.start <= span.start && span.end <= argument.span.end
        )
      ) {
        diagnostics.push({
          code: "BLOT_DEFERRED_LINEAR_ARGUMENT",
          message:
            "A deferred argument may be skipped, so it cannot consume a linear resource. Consume the resource before the call or make the argument strict.",
          span: argument.span,
        });
        break;
      }
    }
  }
  return diagnostics;
}

class DemandAnalysis {
  readonly diagnostics: Diagnostic[] = [];
  readonly arguments: Expr[] = [];
  #nextDemand = 0;

  constructor(
    readonly expressionTypes: ReadonlyMap<Expr, SimpleType>,
    readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, unknown>>,
  ) {}

  walkModule(module: Module): void {
    this.walkDeclarations(
      module.declarations,
      module.result,
      new Map(),
      new Map(),
      new Set(),
    );
  }

  analyzeLambda(
    expression: Extract<Expr, { readonly tag: "lambda" }>,
    env: DemandEnv,
  ): void {
    const local = new Map(env);
    const forbidden = new Set<number>();
    for (const id of env.values()) if (typeof id === "number") forbidden.add(id);
    for (const name of patternNames(expression.parameter)) local.set(name, null);

    const state: Demands = new Map();
    if (expression.deferred === true && expression.parameter.tag === "name") {
      const id = this.#nextDemand++;
      local.set(expression.parameter.name, id);
      state.set(id, "fresh");
    }
    this.walk(expression.body, local, state, forbidden);
  }

  walkDeclarations(
    declarations: readonly Decl[],
    result: Expr,
    env: DemandEnv,
    state: Demands,
    forbidden: ReadonlySet<number>,
  ): void {
    const local = new Map(env);
    const live = liveDeclarations(declarations, result);
    for (const declaration of declarations) {
      if (!live.has(declaration)) continue;
      if (declaration.tag === "binding") {
        if (declaration.kind !== "sig") {
          this.walk(declaration.value, local, state, forbidden);
        }
        for (const name of patternNames(declaration.pattern)) local.set(name, null);
        continue;
      }
      if (declaration.tag === "shadow") {
        const tracked = local.get(declaration.name);
        if (typeof tracked === "number") {
          this.diagnostics.push({
            code: "BLOT_DEFERRED_REBIND",
            message:
              "A deferred parameter cannot be rebound with `:=`. Demand it into an ordinary `let` binding first.",
            span: declaration.span,
          });
        }
        this.walk(declaration.value, local, state, forbidden);
        local.set(declaration.name, null);
        continue;
      }
      const opened = this.opens.get(declaration.value);
      if (opened !== undefined) {
        for (const name of opened.keys()) local.set(name, null);
      }
    }
    this.walk(result, local, state, forbidden);
  }

  walk(
    expression: Expr,
    env: DemandEnv,
    state: Demands,
    forbidden: ReadonlySet<number>,
  ): void {
    switch (expression.tag) {
      case "var": {
        const id = env.get(expression.name);
        if (typeof id !== "number") return;
        if (forbidden.has(id)) {
          this.diagnostics.push({
            code: "BLOT_DEFERRED_CAPTURE",
            message:
              "A deferred parameter cannot be captured by another closure. Demand it into an ordinary `let` binding before creating the closure.",
            span: expression.span,
          });
          return;
        }
        this.demand(id, state, expression);
        return;
      }
      case "int":
      case "float":
      case "text":
      case "unit":
      case "intrinsic":
      case "tag":
        return;
      case "apply": {
        this.walk(expression.fn, env, state, forbidden);
        const fn = functionType(this.expressionTypes.get(expression.fn));
        if (fn?.deferred === true) {
          this.arguments.push(expression.arg);
          const before = cloneDemands(state);
          const demanded = cloneDemands(state);
          this.walk(expression.arg, new Map(env), demanded, forbidden);
          this.mergeInto(state, [before, demanded]);
        } else {
          this.walk(expression.arg, env, state, forbidden);
        }
        return;
      }
      case "field":
        this.walk(expression.target, env, state, forbidden);
        return;
      case "lambda":
        this.analyzeLambda(expression, env);
        return;
      case "array":
        for (const element of expression.elements) {
          this.walk(element.value, env, state, forbidden);
        }
        return;
      case "tuple":
        for (const element of expression.elements) {
          this.walk(element, env, state, forbidden);
        }
        return;
      case "shape":
        for (const member of expression.members) {
          this.walk(member.value, env, state, forbidden);
        }
        return;
      case "if": {
        const remaining = cloneDemands(state);
        const outcomes: Demands[] = [];
        for (const branch of expression.branches) {
          this.walk(branch.condition, env, remaining, forbidden);
          const consequence = cloneDemands(remaining);
          this.walk(branch.consequence, new Map(env), consequence, forbidden);
          outcomes.push(consequence);
        }
        if (expression.fallback !== null) {
          const fallback = cloneDemands(remaining);
          this.walk(expression.fallback, new Map(env), fallback, forbidden);
          outcomes.push(fallback);
        } else {
          outcomes.push(cloneDemands(remaining));
        }
        this.mergeInto(state, outcomes);
        return;
      }
      case "case": {
        this.walk(expression.target, env, state, forbidden);
        const outcomes: Demands[] = [];
        for (const arm of expression.arms) {
          const armEnv = new Map(env);
          for (const name of patternNames(arm.pattern)) armEnv.set(name, null);
          const armState = cloneDemands(state);
          this.walk(arm.body, armEnv, armState, forbidden);
          outcomes.push(armState);
        }
        this.mergeInto(state, outcomes);
        return;
      }
      case "block":
        this.walkDeclarations(
          expression.declarations,
          expression.result,
          env,
          state,
          forbidden,
        );
        return;
      case "rec":
        this.walk(expression.lambda, env, state, forbidden);
        return;
      case "comptime":
        return;
    }
  }

  demand(id: number, state: Demands, expression: Expr): void {
    const current = state.get(id);
    if (current === undefined) {
      throw new Error(
        `deferred demand ${id} is missing at ${expression.span.start}..${expression.span.end}`,
      );
    }
    if (current === "fresh") {
      state.set(id, "spent");
      return;
    }
    this.diagnostics.push({
      code: "BLOT_DEFERRED_DEMANDED_TWICE",
      message:
        "A deferred parameter may be demanded at most once on any execution path. Demand it once into an ordinary `let` binding before reusing the value.",
      span: expression.span,
    });
  }

  mergeInto(target: Demands, outcomes: readonly Demands[]): void {
    for (const id of target.keys()) {
      let merged: DemandState | null = null;
      for (const outcome of outcomes) {
        const next = outcome.get(id) ?? "fresh";
        merged = merged === null ? next : mergeDemand(merged, next);
      }
      target.set(id, merged ?? "fresh");
    }
  }
}

function cloneDemands(state: Demands): Demands {
  return new Map(state);
}

function mergeDemand(left: DemandState, right: DemandState): DemandState {
  if (left === right) return left;
  return "maybe";
}
''')

replace_once(
    "src/linear/check.ts",
    '''  readonly lineage: ReadonlyMap<NamePattern, readonly OwnershipLineage[]>;
}''',
    '''  readonly lineage: ReadonlyMap<NamePattern, readonly OwnershipLineage[]>;
  /** The actual obligation after captures/aggregate ownership are inherited. */
  readonly qualifiers: ReadonlyMap<NamePattern, Qualifier>;
}''',
)
replace_once(
    "src/linear/check.ts",
    '''  readonly lineage = new Map<NamePattern, readonly OwnershipLineage[]>();
  readonly functionResults = new Map<Expr, Produced>();''',
    '''  readonly lineage = new Map<NamePattern, readonly OwnershipLineage[]>();
  readonly qualifiers = new Map<NamePattern, Qualifier>();
  readonly functionResults = new Map<Expr, Produced>();''',
)
replace_once(
    "src/linear/check.ts",
    '''      lineage: analysis.lineage,
    },
  };''',
    '''      lineage: analysis.lineage,
      qualifiers: analysis.qualifiers,
    },
  };''',
)
replace_once(
    "src/linear/check.ts",
    '''      const lineage = structuralLineage(pattern, owned);
      if (lineage.length > 0) analysis.lineage.set(pattern, lineage);
      scope.bindings.set(pattern.name, {
        pattern,
        qualifier: inherited(pattern.qualifier, owned),''',
    '''      const lineage = structuralLineage(pattern, owned);
      if (lineage.length > 0) analysis.lineage.set(pattern, lineage);
      const qualifier = inherited(pattern.qualifier, owned);
      analysis.qualifiers.set(pattern, qualifier);
      scope.bindings.set(pattern.name, {
        pattern,
        qualifier,''',
)

replace_once(
    "src/check/mod.ts",
    '''import type { SimpleType } from "./type.ts";
import { show, showModuleRow as showRow } from "./print.ts";''',
    '''import type { SimpleType } from "./type.ts";
import {
  checkDeferredLinearArguments,
  checkDeferredUsage,
} from "./deferred.ts";
import { show, showModuleRow as showRow } from "./print.ts";''',
)
replace_once(
    "src/check/mod.ts",
    '''    // Ownership is checked after types. A use-after-move reported on a program
    // that does not type-check would be the second-best diagnostic.
    const linear = checkLinearity(loaded.module);
    if (linear.diagnostics.length > 0) {
      throw new BlotError(linear.diagnostics[0]);
    }''',
    '''    const deferred = checkDeferredUsage(
      loaded.module,
      checked.expressionTypes,
      checked.opens,
    );
    if (deferred.diagnostics.length > 0) {
      throw new BlotError(deferred.diagnostics[0]);
    }

    // Ownership is checked after types. A use-after-move reported on a program
    // that does not type-check would be the second-best diagnostic.
    const linear = checkLinearity(loaded.module);
    if (linear.diagnostics.length > 0) {
      throw new BlotError(linear.diagnostics[0]);
    }
    const deferredOwnership = checkDeferredLinearArguments(
      deferred.arguments,
      linear.ownership,
    );
    if (deferredOwnership.length > 0) {
      throw new BlotError(deferredOwnership[0]);
    }''',
)

replace_once(
    "src/core/computation.ts",
    '''  FLOAT,
  intLiteral,
  type SimpleType,
  textLiteral,
  UNIT,
  variant,
} from "../check/type.ts";''',
    '''  effects,
  FLOAT,
  fun,
  intLiteral,
  type SimpleType,
  textLiteral,
  UNIT,
  variant,
} from "../check/type.ts";''',
)
replace_once(
    "src/core/computation.ts",
    '''import type { ArrayIndexProof } from "./proof.ts";''',
    '''import type { ArrayIndexProof } from "./proof.ts";
import { functionType } from "../check/deferred.ts";''',
)
replace_once(
    "src/core/computation.ts",
    '''  #runtimeNames = new Set<string>();
  #nextNode = 0;''',
    '''  #runtimeNames = new Set<string>();
  /** Source names whose runtime binding is the compiler-created thunk. */
  #deferredNames = new Map<string, SimpleType>();
  #nextNode = 0;''',
)
replace_once(
    "src/core/computation.ts",
    '''    const outerRuntimeNames = this.#runtimeNames;
    this.#runtimeNames = new Set(outerRuntimeNames);
    const live = liveDeclarations(declarations, result);''',
    '''    const outerRuntimeNames = this.#runtimeNames;
    const outerDeferredNames = this.#deferredNames;
    this.#runtimeNames = new Set(outerRuntimeNames);
    this.#deferredNames = new Map(outerDeferredNames);
    const live = liveDeclarations(declarations, result);''',
)
replace_once(
    "src/core/computation.ts",
    '''      if (declaration.tag === "binding") {
        for (const name of patternNames(declaration.pattern)) {
          this.#runtimeNames.add(name);
        }
      } else if (declaration.tag === "shadow") {
        this.#runtimeNames.add(declaration.name);
      }
    }
    const expression = this.expression(result);
    this.#runtimeNames = outerRuntimeNames;''',
    '''      if (declaration.tag === "binding") {
        for (const name of patternNames(declaration.pattern)) {
          this.#runtimeNames.add(name);
          this.#deferredNames.delete(name);
        }
      } else if (declaration.tag === "shadow") {
        this.#runtimeNames.add(declaration.name);
        this.#deferredNames.delete(declaration.name);
      } else {
        const opened = this.#opens.get(declaration.value);
        if (opened !== undefined) {
          for (const name of opened.keys()) this.#deferredNames.delete(name);
        }
      }
    }
    const expression = this.expression(result);
    this.#runtimeNames = outerRuntimeNames;
    this.#deferredNames = outerDeferredNames;''',
)
replace_once(
    "src/core/computation.ts",
    '''    const type = this.typeOf(expression);
    let adaptation: RecordAdaptation | null = null;''',
    '''    const sourceType = this.typeOf(expression);
    const type = eraseDeferredRuntimeType(sourceType);
    let adaptation: RecordAdaptation | null = null;''',
)
replace_once(
    "src/core/computation.ts",
    '''      case "var":
      case "int":
      case "float":
      case "text":
      case "intrinsic":
      case "tag":
        return {
          ...metadata,
          tag: expression.tag,
          ...scalar(expression),
        } as CoreExpression;''',
    '''      case "var": {
        const deferred = this.#deferredNames.get(expression.name);
        if (deferred !== undefined) {
          return this.forceDeferred(expression, metadata, deferred);
        }
        return { ...metadata, tag: "var", name: expression.name };
      }
      case "int":
      case "float":
      case "text":
      case "intrinsic":
      case "tag":
        return {
          ...metadata,
          tag: expression.tag,
          ...scalar(expression),
        } as CoreExpression;''',
)
replace_once(
    "src/core/computation.ts",
    '''      case "apply":
        {
          const application = applicationSpine(expression);''',
    '''      case "apply":
        {
          const arrow = functionType(this.#expressionTypes.get(expression.fn));
          if (arrow?.deferred === true) {
            return {
              ...metadata,
              tag: "apply",
              fn: this.expression(expression.fn),
              arg: this.deferredArgument(expression.arg, arrow.param),
            };
          }
          const application = applicationSpine(expression);''',
)
replace_once(
    "src/core/computation.ts",
    '''      case "lambda": {
        const outerRuntimeNames = this.#runtimeNames;
        this.#runtimeNames = new Set(outerRuntimeNames);
        for (const name of patternNames(expression.parameter)) {
          this.#runtimeNames.add(name);
        }
        const body = this.expression(expression.body);
        this.#runtimeNames = outerRuntimeNames;
        return {
          ...metadata,
          tag: "lambda",
          parameter: expression.parameter,
          body,
        };
      }''',
    '''      case "lambda": {
        const outerRuntimeNames = this.#runtimeNames;
        const outerDeferredNames = this.#deferredNames;
        this.#runtimeNames = new Set(outerRuntimeNames);
        this.#deferredNames = new Map(outerDeferredNames);
        for (const name of patternNames(expression.parameter)) {
          this.#runtimeNames.add(name);
          this.#deferredNames.delete(name);
        }
        if (expression.deferred === true && expression.parameter.tag === "name") {
          const arrow = functionType(sourceType);
          if (arrow === null || arrow.deferred !== true) {
            throw new Error("typed Core lost a deferred lambda's arrow");
          }
          this.#deferredNames.set(expression.parameter.name, arrow.param);
        }
        const body = this.expression(expression.body);
        this.#runtimeNames = outerRuntimeNames;
        this.#deferredNames = outerDeferredNames;
        return {
          ...metadata,
          tag: "lambda",
          parameter: expression.parameter,
          body,
        };
      }''',
)
replace_once(
    "src/core/computation.ts",
    '''      case "case":
        return {
          ...metadata,
          tag: "case",
          target: this.expression(expression.target),
          arms: expression.arms.map((arm) => ({
            pattern: arm.pattern,
            body: this.expression(arm.body),
          })),
        };''',
    '''      case "case":
        return {
          ...metadata,
          tag: "case",
          target: this.expression(expression.target),
          arms: expression.arms.map((arm) => {
            const outerRuntimeNames = this.#runtimeNames;
            const outerDeferredNames = this.#deferredNames;
            this.#runtimeNames = new Set(outerRuntimeNames);
            this.#deferredNames = new Map(outerDeferredNames);
            for (const name of patternNames(arm.pattern)) {
              this.#runtimeNames.add(name);
              this.#deferredNames.delete(name);
            }
            const body = this.expression(arm.body);
            this.#runtimeNames = outerRuntimeNames;
            this.#deferredNames = outerDeferredNames;
            return { pattern: arm.pattern, body };
          }),
        };''',
)
replace_once(
    "src/core/computation.ts",
    '''  typeOf(expression: Expr): SimpleType {''',
    '''  deferredArgument(expression: Expr, parameter: SimpleType): CoreExpression {
    const body = this.expression(expression);
    const type = fun(UNIT, eraseDeferredRuntimeType(parameter), effects([]));
    return {
      ...this.syntheticMetadata(expression, type),
      tag: "lambda",
      parameter: { tag: "unit", span: expression.span },
      body,
    };
  }

  forceDeferred(
    expression: Extract<Expr, { readonly tag: "var" }>,
    metadata: CoreNode,
    valueType: SimpleType,
  ): CoreExpression {
    const resultType = eraseDeferredRuntimeType(valueType);
    const thunkType = fun(UNIT, resultType, effects([]));
    const fn: CoreExpression = {
      ...this.syntheticMetadata(expression, thunkType),
      tag: "var",
      name: expression.name,
    };
    const arg: CoreExpression = {
      ...this.syntheticMetadata(expression, UNIT),
      tag: "unit",
    };
    return { ...metadata, tag: "apply", fn, arg };
  }

  syntheticMetadata(origin: Expr, type: SimpleType): CoreNode {
    return {
      id: this.#nextNode++,
      type,
      typeRep: this.#typeRepresentations.reference(type),
      span: origin.span,
      adaptation: null,
      arrayProof: null,
      origin,
    };
  }

  typeOf(expression: Expr): SimpleType {''',
)

core = Path("src/core/computation.ts")
text = core.read_text()
insert = r'''
function eraseDeferredRuntimeType(
  type: SimpleType,
  seen = new Set<number>(),
): SimpleType {
  if (type.tag === "fun") {
    const param = eraseDeferredRuntimeType(type.param, seen);
    const result = eraseDeferredRuntimeType(type.result, seen);
    const row = eraseDeferredRuntimeType(type.effects, seen);
    if (type.deferred === true) {
      return fun(fun(UNIT, param, effects([])), result, row);
    }
    return fun(param, result, row);
  }
  if (type.tag === "forall") {
    return {
      tag: "forall",
      variables: type.variables,
      body: eraseDeferredRuntimeType(type.body, seen),
    };
  }
  if (type.tag === "record") {
    return {
      tag: "record",
      fields: new Map(
        [...type.fields].map(([name, field]) => [
          name,
          eraseDeferredRuntimeType(field, seen),
        ]),
      ),
    };
  }
  if (type.tag === "array") {
    return { tag: "array", element: eraseDeferredRuntimeType(type.element, seen) };
  }
  if (type.tag === "variant") {
    return {
      tag: "variant",
      cases: new Map(
        [...type.cases].map(([name, payload]) => [
          name,
          eraseDeferredRuntimeType(payload, seen),
        ]),
      ),
      open: type.open,
    };
  }
  if (type.tag === "union") {
    return {
      tag: "union",
      members: type.members.map((member) =>
        eraseDeferredRuntimeType(member, seen)
      ),
    };
  }
  if (type.tag === "var" && !seen.has(type.id)) {
    seen.add(type.id);
    const arrow = functionType(type);
    if (arrow?.deferred === true) return eraseDeferredRuntimeType(arrow, seen);
  }
  return type;
}

'''
marker = 'function erasedComptimeValue(value: Value): boolean {'
if "function eraseDeferredRuntimeType(" not in text:
    if marker not in text:
        raise SystemExit("core helper insertion anchor missing")
    core.write_text(text.replace(marker, insert + marker, 1))

linear = Path("linear.test.ts")
text = linear.read_text()
addition = r'''
rejects(
  "a deferred parameter cannot be demanded twice on one path",
  `let twice = fn ~value => @int.add value value
return twice 21
`,
  "BLOT_DEFERRED_DEMANDED_TWICE",
);

accepts(
  "a deferred parameter can be demanded once then shadowed",
  `let twice = fn ~value => do:
  let value = value
  return @int.add value value
return twice 21
`,
);

rejects(
  "a deferred parameter cannot escape into a nested closure",
  `let hold = fn ~value => do:
  let later = fn () => value
  return later
return hold 21
`,
  "BLOT_DEFERRED_CAPTURE",
);

rejects(
  "a deferred argument cannot hide a linear consumption",
  `let consume = fn !value => @int.add value 1
let ignore = fn ~_ => 0
let !token = 41
return ignore (consume (!token))
`,
  "BLOT_DEFERRED_LINEAR_ARGUMENT",
);

'''
if "a deferred parameter cannot be demanded twice on one path" not in text:
    anchor = 'const CONSUME = `let consume = fn !value => @int.add value 1\n`;'
    at = text.find(anchor)
    if at < 0:
        raise SystemExit("linear test anchor missing")
    at = text.find("\n", at) + 1
    linear.write_text(text[:at] + "\n" + addition + text[at:])

replace_once(
    "src/core/computation.test.ts",
    'import { UNIT } from "../check/type.ts";',
    'import { effects, fun, INT, type SimpleType, UNIT } from "../check/type.ts";\nimport type { Expr } from "../syntax/ast.ts";',
)
test = Path("src/core/computation.test.ts")
text = test.read_text()
addition = r'''
Deno.test("typed core erases a deferred call to an ordinary thunk call", async () => {
  const parsed = await parse(`let lazy = fn ~value => value
return lazy 42
`);
  if (!parsed.ok) throw new Error("deferred core fixture did not parse");
  const declaration = parsed.module.declarations[0];
  if (declaration?.tag !== "binding" || declaration.value.tag !== "lambda") {
    throw new Error("deferred core fixture omitted its lambda");
  }
  const result = parsed.module.result;
  if (result.tag !== "apply") throw new Error("deferred core result is not a call");

  const deferred = fun(INT, INT, effects([]), true);
  const expressionTypes = new Map<Expr, SimpleType>([
    [declaration.value, deferred],
    [declaration.value.body, INT],
    [result.fn, deferred],
    [result, INT],
  ]);
  const core = elaborateModule(parsed.module, expressionTypes, INT);
  const step = core.steps[0];
  if (step?.definition.tag !== "binding") {
    throw new Error("deferred core omitted its binding");
  }
  const lazy = step.definition.value;
  assertEquals(lazy.tag, "lambda");
  if (lazy.tag !== "lambda") return;
  assertEquals(lazy.body.tag, "apply");
  if (lazy.body.tag !== "apply") return;
  assertEquals(lazy.body.fn.tag, "var");
  assertEquals(lazy.body.arg.tag, "unit");

  assertEquals(core.result.tag, "return");
  if (core.result.tag !== "return") return;
  assertEquals(core.result.value.tag, "apply");
  if (core.result.value.tag !== "apply") return;
  assertEquals(core.result.value.arg.tag, "lambda");
  if (core.result.value.arg.tag !== "lambda") return;
  assertEquals(core.result.value.arg.parameter.tag, "unit");
  assertEquals(core.result.value.arg.body.tag, "int");
});

'''
if "typed core erases a deferred call to an ordinary thunk call" not in text:
    anchor = 'Deno.test("core distinguishes pure definitions from explicit binds"'
    at = text.find(anchor)
    if at < 0:
        raise SystemExit("core test anchor missing")
    test.write_text(text[:at] + addition + text[at:])

files = [
    "src/check/deferred.ts",
    "src/check/mod.ts",
    "src/linear/check.ts",
    "src/core/computation.ts",
    "linear.test.ts",
    "src/core/computation.test.ts",
]
subprocess.run(["deno", "fmt", *files], check=True)
subprocess.run(["deno", "check", *files], check=True)
subprocess.run(
    ["deno", "test", "--allow-read", "--allow-write", "linear.test.ts", "--filter", "deferred"],
    check=True,
)
subprocess.run(
    ["deno", "test", "--allow-read", "--allow-write", "src/core/computation.test.ts", "--filter", "deferred"],
    check=True,
)
subprocess.run(["git", "add", *files], check=True)
