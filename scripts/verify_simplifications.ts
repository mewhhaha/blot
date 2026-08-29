import { Compiler } from "../src/compiler/session.ts";
import { parseConcrete } from "../src/syntax/parse.ts";
import { DEFAULT_LINT_RULES, lintModule } from "../src/tooling/lint.ts";

interface VerificationCase {
  readonly name: string;
  readonly source: string;
  readonly expectedEqualityFacts: number;
  readonly expectedAndFacts: number;
  readonly expectedEqualityCaseLints: number;
  readonly expectedEqualityChainLints: number;
}

const prelude = 'open import "blot:prelude"\n';
const cases: readonly VerificationCase[] = [
  {
    name: "an immutable equality alias retains its proof",
    source: `${prelude}const same = Int.eq
let classify = fn value => case same value 0 of
  #True => "zero"
  #False => "nonzero"
return classify
`,
    expectedEqualityFacts: 1,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 1,
    expectedEqualityChainLints: 0,
  },
  {
    name: "a shadowed Int.eq spelling grants no equality proof",
    source:
      `const not_greater = fn left => fn right => case @int.cmp left right of
  #Less => #True
  #Equal => #True
  #Greater => #False
const Int = { .eq = not_greater; }
let classify = fn value => case value == 0 of
  #True => "not greater"
  #False => "greater"
return classify
`,
    expectedEqualityFacts: 0,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 0,
    expectedEqualityChainLints: 0,
  },
  {
    name: "a record member retains its equality proof",
    source: `${prelude}const comparisons = { .same = Int.eq; }
let classify = fn value => case comparisons.same value 0 of
  #True => "zero"
  #False => "nonzero"
return classify
`,
    expectedEqualityFacts: 1,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 1,
    expectedEqualityChainLints: 0,
  },
  {
    name: "an equality ladder composes proofs for one subject",
    source: `${prelude}const same = Int.eq
let label = fn value => do:
  if same value 0:
    return "zero"
  else if same value 1:
    return "one"
  else:
    return "other"
return label
`,
    expectedEqualityFacts: 2,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 0,
    expectedEqualityChainLints: 1,
  },
  {
    name: "a deferred conjunction composes proved equality predicates",
    source: `${prelude}let classify = fn (x, y) => case x == 0 && y == 0 of
  #True => "origin"
  #False => "elsewhere"
return classify
`,
    expectedEqualityFacts: 2,
    expectedAndFacts: 1,
    expectedEqualityCaseLints: 1,
    expectedEqualityChainLints: 0,
  },
  {
    name: "an eager conjunction truth table grants no demand proof",
    source: `${prelude}const eager_and = fn left => fn right => case left of
    #False => #False
    #True => right
let classify = fn (x, y) => case eager_and (x == 0) (y == 0) of
  #True => "origin"
  #False => "elsewhere"
return classify
`,
    expectedEqualityFacts: 2,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 0,
    expectedEqualityChainLints: 0,
  },
  {
    name: "two runtime operands cannot become a pinned pattern",
    source: `${prelude}let classify = fn (left, right) => case left == right of
  #True => "same"
  #False => "different"
return classify
`,
    expectedEqualityFacts: 0,
    expectedAndFacts: 0,
    expectedEqualityCaseLints: 0,
    expectedEqualityChainLints: 0,
  },
];

const compiler = await Compiler.create();
try {
  for (const verification of cases) {
    const path = `verify:simplifications:${verification.name}`;
    const analysis = await compiler.analyzeSource(path, verification.source);
    const equalityFacts = analysis.simplifications.filter((fact) =>
      fact.kind === "integer-equality"
    ).length;
    const andFacts = analysis.simplifications.filter((fact) =>
      fact.kind === "short-circuit-and"
    ).length;
    const parsed = await parseConcrete(verification.source);
    if (!parsed.ok) {
      throw new Error(
        `${verification.name}: accepted compiler source did not parse`,
      );
    }
    const diagnostics = lintModule(
      parsed.module,
      verification.source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      { simplifications: analysis.simplifications },
    );
    const equalityCaseLints = diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_EQUALITY_CASE"
    )
      .length;
    const equalityChainLints = diagnostics.filter((diagnostic) =>
      diagnostic.code === "BLOT_LINT_IF_CHAIN"
    )
      .length;
    if (
      equalityFacts !== verification.expectedEqualityFacts ||
      andFacts !== verification.expectedAndFacts ||
      equalityCaseLints !== verification.expectedEqualityCaseLints ||
      equalityChainLints !== verification.expectedEqualityChainLints
    ) {
      throw new Error(
        `${verification.name}: expected ${verification.expectedEqualityFacts} equality facts, ${verification.expectedAndFacts} conjunction facts, ${verification.expectedEqualityCaseLints} equality-case lints, and ${verification.expectedEqualityChainLints} equality-chain lints; received ${equalityFacts}, ${andFacts}, ${equalityCaseLints}, and ${equalityChainLints}`,
      );
    }
    console.log(
      `${verification.name}: ${equalityFacts} equality facts, ${andFacts} conjunction facts, ${equalityCaseLints} equality-case lints, ${equalityChainLints} equality-chain lints`,
    );
  }
} finally {
  compiler.destroy();
}
