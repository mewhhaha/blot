from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one replacement, found {count}: {old[:160]!r}"
        )
    target.write_text(text.replace(old, new, 1))


def replace_regex_once(path: str, pattern: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text()
    replaced, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one regex replacement, found {count}: {pattern[:160]!r}"
        )
    target.write_text(replaced)


typecheck = "compiler/src/typecheck.rs"

replace_once(
    typecheck,
    """#[derive(Clone)]
struct SyntheticCallFact {
    deferred: bool,
    effects: Type,
    result: Type,
}

type StructuralReadabilityCandidates =
""",
    """#[derive(Clone)]
struct SyntheticCallFact {
    deferred: bool,
    effects: Type,
    result: Type,
}

#[derive(Clone)]
enum NumericLiteralKind {
    Integer(BigInt),
    Float,
}

#[derive(Clone)]
struct NumericLiteralFact {
    kind: NumericLiteralKind,
    path: String,
    expression: ExpressionId,
    selected: bool,
}

type StructuralReadabilityCandidates =
""",
)

replace_once(
    typecheck,
    """    module_work: RefCell<HashMap<String, CompilerWork>>,
    bound_insertions: RefCell<Vec<BoundInsertion>>,
    next_skolem: Rc<Cell<VariableId>>,
""",
    """    module_work: RefCell<HashMap<String, CompilerWork>>,
    bound_insertions: RefCell<Vec<BoundInsertion>>,
    numeric_literals: RefCell<HashMap<VariableId, NumericLiteralFact>>,
    numeric_literal_pending: RefCell<BTreeSet<VariableId>>,
    next_skolem: Rc<Cell<VariableId>>,
""",
)

replace_once(
    typecheck,
    """            module_work: RefCell::new(HashMap::new()),
            bound_insertions: RefCell::new(Vec::new()),
            next_skolem: Rc::new(Cell::new(0x8000_0000)),
""",
    """            module_work: RefCell::new(HashMap::new()),
            bound_insertions: RefCell::new(Vec::new()),
            numeric_literals: RefCell::new(HashMap::new()),
            numeric_literal_pending: RefCell::new(BTreeSet::new()),
            next_skolem: Rc::new(Cell::new(0x8000_0000)),
""",
)

replace_once(
    typecheck,
    """        self.bound_insertions.borrow_mut().clear();
        self.empty_array_elements.borrow_mut().clear();
""",
    """        self.bound_insertions.borrow_mut().clear();
        self.numeric_literals.borrow_mut().clear();
        self.numeric_literal_pending.borrow_mut().clear();
        self.empty_array_elements.borrow_mut().clear();
""",
)

replace_once(
    typecheck,
    """        self.expression_types.borrow_mut().remove_modules(paths);
        self.analysis_expression_types
""",
    """        self.expression_types.borrow_mut().remove_modules(paths);
        self.numeric_literals
            .borrow_mut()
            .retain(|_, literal| !paths.contains(&literal.path));
        let active_numeric_literals = self
            .numeric_literals
            .borrow()
            .keys()
            .copied()
            .collect::<HashSet<_>>();
        self.numeric_literal_pending
            .borrow_mut()
            .retain(|variable| active_numeric_literals.contains(variable));
        self.analysis_expression_types
""",
)

replace_once(
    typecheck,
    """            Expression::Int { value, .. } => Ok(Inferred::pure(Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(value.clone())),
                high: Some(Scalar::Int(value)),
            })),
            Expression::Float { .. } => Ok(Inferred::pure(float_type())),
""",
    """            Expression::Int { value, .. } => Ok(Inferred::pure(
                self.fresh_numeric_literal(
                    path,
                    expression_id,
                    NumericLiteralKind::Integer(value),
                ),
            )),
            Expression::Float { .. } => Ok(Inferred::pure(self.fresh_numeric_literal(
                path,
                expression_id,
                NumericLiteralKind::Float,
            ))),
""",
)

replace_once(
    typecheck,
    """        if self
            .expression_types
            .borrow()
            .contains_key(path, &expression)
        {
            self.expression_types.borrow_mut().insert(
                path.to_owned(),
                expression,
                expected.clone(),
            );
        }
""",
    """        if self
            .expression_types
            .borrow()
            .contains_key(path, &expression)
            && !matches!(
                module.arena.expressions[expression.0 as usize],
                Expression::Int { .. } | Expression::Float { .. }
            )
        {
            self.expression_types.borrow_mut().insert(
                path.to_owned(),
                expression,
                expected.clone(),
            );
        }
""",
)

replace_once(
    typecheck,
    """    fn instantiate(&self, typing: Typing) -> Type {
""",
    """    fn fresh_numeric_literal(
        &self,
        path: &str,
        expression: ExpressionId,
        kind: NumericLiteralKind,
    ) -> Type {
        let type_ = self.fresh();
        let Type::Variable(variable) = type_ else {
            unreachable!("fresh always returns a variable")
        };
        self.numeric_literals.borrow_mut().insert(
            variable,
            NumericLiteralFact {
                kind,
                path: path.to_owned(),
                expression,
                selected: false,
            },
        );
        let type_ = Type::Variable(variable);
        self.expression_types.borrow_mut().insert(
            path.to_owned(),
            expression,
            type_.clone(),
        );
        type_
    }

    fn numeric_literal_candidates(kind: &NumericLiteralKind) -> Vec<Type> {
        match kind {
            NumericLiteralKind::Integer(value) => vec![
                Type::Range {
                    domain: Domain::Int,
                    low: Some(Scalar::Int(value.clone())),
                    high: Some(Scalar::Int(value.clone())),
                },
                float_type(),
                float32_type(),
            ],
            NumericLiteralKind::Float => vec![float_type(), float32_type()],
        }
    }

    fn numeric_literal_candidate_fits(
        &self,
        variable: VariableId,
        candidate: &Type,
        span: Span,
    ) -> bool {
        let (lowers, uppers) = {
            let variables = self.variables.borrow();
            let Some(variable) = variables.get(variable as usize) else {
                return false;
            };
            (variable.lower.clone(), variable.upper.clone())
        };
        let insertion_count = self.bound_insertions.borrow().len();
        let variable_count = self.variables.borrow().len();
        let next_skolem = self.next_skolem.get();
        let candidate = self.constraint_type(candidate);
        let fits_lowers = lowers
            .into_iter()
            .filter(|lower| self.constraint_variable(*lower).is_none())
            .all(|lower| {
                self.constrain_ids(lower, candidate, span, &mut HashSet::new())
                    .is_ok()
            });
        let fits_uppers = fits_lowers
            && uppers
                .into_iter()
                .filter(|upper| self.constraint_variable(*upper).is_none())
                .all(|upper| {
                    self.constrain_ids(candidate, upper, span, &mut HashSet::new())
                        .is_ok()
                });
        self.rollback_bounds(insertion_count, variable_count, next_skolem);
        fits_uppers
    }

    fn resolve_numeric_literals(
        &self,
        default: bool,
        span: Span,
    ) -> Result<(), Diagnostic> {
        loop {
            let variables = if default {
                self.numeric_literal_pending.borrow_mut().clear();
                let mut variables = self
                    .numeric_literals
                    .borrow()
                    .iter()
                    .filter_map(|(variable, literal)| (!literal.selected).then_some(*variable))
                    .collect::<Vec<_>>();
                variables.sort_unstable();
                variables
            } else {
                std::mem::take(&mut *self.numeric_literal_pending.borrow_mut())
                    .into_iter()
                    .collect::<Vec<_>>()
            };
            if variables.is_empty() {
                return Ok(());
            }
            for variable in variables {
                if variable as usize >= self.variables.borrow().len() {
                    self.numeric_literals.borrow_mut().remove(&variable);
                    continue;
                }
                let Some(literal) = self.numeric_literals.borrow().get(&variable).cloned() else {
                    continue;
                };
                if literal.selected {
                    continue;
                }
                let candidates = Self::numeric_literal_candidates(&literal.kind);
                let mut viable = candidates
                    .iter()
                    .filter(|candidate| {
                        self.numeric_literal_candidate_fits(variable, candidate, span)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let candidate = if viable.is_empty() {
                    candidates
                        .first()
                        .expect("a numeric literal has candidates")
                        .clone()
                } else if viable.len() == 1 || default {
                    viable.remove(0)
                } else {
                    continue;
                };
                let candidate_id = self.constraint_type(&candidate);
                let variable_id = self.constraint_type(&Type::Variable(variable));
                self.constrain_ids(candidate_id, variable_id, span, &mut HashSet::new())?;
                {
                    let mut literals = self.numeric_literals.borrow_mut();
                    let Some(current) = literals.get_mut(&variable) else {
                        continue;
                    };
                    current.selected = true;
                }
                let representation = self
                    .reify_runtime_type(&candidate)
                    .expect("numeric literal candidates have runtime representations");
                self.context.expression_types.borrow_mut().insert(
                    literal.path,
                    literal.expression,
                    representation,
                );
            }
        }
    }

    fn instantiate(&self, typing: Typing) -> Type {
""",
)

replace_once(
    typecheck,
    """    fn constrain(&self, left: Type, right: Type, span: Span) -> Result<(), Diagnostic> {
        debug_assert!(self.bound_insertions.borrow().is_empty());
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        let result = self.constrain_ids(left, right, span, &mut HashSet::new());
        self.bound_insertions.borrow_mut().clear();
        result
    }
""",
    """    fn constrain(&self, left: Type, right: Type, span: Span) -> Result<(), Diagnostic> {
        debug_assert!(self.bound_insertions.borrow().is_empty());
        let left = self.constraint_type(&left);
        let right = self.constraint_type(&right);
        let result = self
            .constrain_ids(left, right, span, &mut HashSet::new())
            .and_then(|()| self.resolve_numeric_literals(false, span));
        self.bound_insertions.borrow_mut().clear();
        result
    }
""",
)

replace_once(
    typecheck,
    """        self.empty_array_elements
            .borrow_mut()
            .retain(|variable| (*variable as usize) < variable_count);
        self.next_skolem.set(next_skolem);
""",
    """        self.empty_array_elements
            .borrow_mut()
            .retain(|variable| (*variable as usize) < variable_count);
        self.numeric_literals
            .borrow_mut()
            .retain(|variable, _| (*variable as usize) < variable_count);
        self.numeric_literal_pending
            .borrow_mut()
            .retain(|variable| (*variable as usize) < variable_count);
        self.next_skolem.set(next_skolem);
""",
)

replace_once(
    typecheck,
    """            self.record_bound_insertion(variable, BoundDirection::Upper);
            for lower in lowers {
""",
    """            self.record_bound_insertion(variable, BoundDirection::Upper);
            if self.numeric_literals.borrow().contains_key(&variable) {
                self.numeric_literal_pending.borrow_mut().insert(variable);
            }
            for lower in lowers {
""",
)

replace_once(
    typecheck,
    """                for bound in recursive_bounds {
                    self.constrain(inferred.type_.clone(), bound, span)?;
                }
                let generalized = kind != DeclarationKind::Effect
""",
    """                for bound in recursive_bounds {
                    self.constrain(inferred.type_.clone(), bound, span)?;
                }
                self.resolve_numeric_literals(true, span)?;
                let generalized = kind != DeclarationKind::Effect
""",
)

replace_once(
    typecheck,
    """                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
                let exact_record = self.exact_record_expression(module, value, types);
""",
    """                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
                self.resolve_numeric_literals(true, span)?;
                let exact_record = self.exact_record_expression(module, value, types);
""",
)

replace_once(
    typecheck,
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let opened = self.evaluate(path, value, values, Phase::Comptime)?;
""",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                self.resolve_numeric_literals(true, span)?;
                let opened = self.evaluate(path, value, values, Phase::Comptime)?;
""",
)

replace_once(
    typecheck,
    """        effects = self.join_effects(effects, inferred.effects)?;
        let effects = self.settle(effects, true);
""",
    """        effects = self.join_effects(effects, inferred.effects)?;
        self.resolve_numeric_literals(true, loaded.module.span)?;
        let effects = self.settle(effects, true);
""",
)

eval_path = "compiler/src/eval.rs"
replace_once(
    eval_path,
    """use std::rc::{Rc, Weak};

use crate::ast::{
""",
    """use std::rc::{Rc, Weak};

use num_traits::ToPrimitive;

use crate::ast::{
""",
)

replace_regex_once(
    eval_path,
    r"""        Expression::Int \{ value, \.\. \} => \{.*?        Expression::Float \{ value, \.\. \} => Computation::value\(Value::Float\(\*value\)\),""",
    """        Expression::Int { value, .. } => match checked_representation.as_ref() {
            Some(Value::Range {
                domain: Some(ValueDomain::Float),
                ..
            }) => {
                let Some(value) = value.to_f64() else {
                    return Computation::error(Diagnostic::new(
                        "BLOT_INTEGER_OVERFLOW",
                        format!("The integer literal {value} cannot be represented as F64."),
                        span,
                    ));
                };
                Computation::value(Value::Float(value))
            }
            Some(Value::Range {
                domain: Some(ValueDomain::Float32),
                ..
            }) => {
                let Some(value) = value.to_f32() else {
                    return Computation::error(Diagnostic::new(
                        "BLOT_INTEGER_OVERFLOW",
                        format!("The integer literal {value} cannot be represented as F32."),
                        span,
                    ));
                };
                Computation::value(Value::Float32(value))
            }
            _ => {
                if runtime.phase == Phase::Runtime
                    && (value < &(-BigIntExt::two_to_63())
                        || value > &BigIntExt::two_to_63_minus_one())
                {
                    return Computation::error(Diagnostic::new(
                        "BLOT_INTEGER_OVERFLOW",
                        format!("The runtime integer {value} is outside signed i64."),
                        span,
                    ));
                }
                Computation::value(Value::Int(value.clone()))
            }
        },
        Expression::Float { value, .. } => {
            if matches!(
                checked_representation.as_ref(),
                Some(Value::Range {
                    domain: Some(ValueDomain::Float32),
                    ..
                })
            ) {
                Computation::value(Value::Float32(*value as f32))
            } else {
                Computation::value(Value::Float(*value))
            }
        }""",
)

language = "LANGUAGE.md"
replace_once(
    language,
    """Floats are IEEE 754 doubles. They do not trap: an operation that overflows
produces an infinity and one with no defined answer produces a NaN, both of
which are values a program may go on to use. This is the difference from integer
arithmetic, where the result would be a number the machine cannot hold.
""",
    """Numeric literals resolve from their context. An integer literal may select its
singleton `Int` type, `F64`, or `F32`; a float literal may select `F64` or
`F32`. With no constraining context, integers keep their singleton type and floats
default to `F64`. This is literal resolution, not numeric subtyping: once a value
is bound as `Int`, `F64`, or `F32`, it does not implicitly convert to another
numeric domain.

Floats are IEEE 754 values. `F64` is double precision and `F32` is single
precision. They do not trap: an operation that overflows produces an infinity and
one with no defined answer produces a NaN, both of which are values a program may
go on to use. This is the difference from integer arithmetic, where the result
would be a number the machine cannot hold.
""",
)

replace_once(
    language,
    """`F32` is the narrower float, and a distinct type rather than a precision `F64`
sometimes has. There is no f32 literal — the grammar has one float token, and
`F32.of_float` is what makes the narrowing a step the program takes rather than
one performed on it. `F32.widen` goes back, exactly, because every `F32` is an
`F64`.
""",
    """`F32` is the narrower float, and a distinct type rather than a precision `F64`
sometimes has. The grammar has one float token; an `F32` context selects that
token's single-precision representation directly. `F32.of_float` remains the
explicit narrowing operation for a value already bound as `F64`, and `F32.widen`
goes back exactly because every `F32` is representable as `F64`.
""",
)

spec = "spec/TYPECHECKING.md"
replace_once(
    spec,
    """The map is scoped to the source
module and expression identities of `R`, so `_` in any other value remains an
unbound name.

## 1. Type algebra
""",
    """The map is scoped to the source
module and expression identities of `R`, so `_` in any other value remains an
unbound name.

Numeric literal elaboration also uses fresh inference variables, but candidate
domains are metadata rather than constructors in the type lattice. An integer
literal admits its singleton `Int` range, `F64`, and `F32`; a float literal admits
`F64` and `F32`. After a successful constraint transaction, the checker selects a
candidate only when the accumulated upper bounds leave one choice. At a binding or
module boundary it chooses the first remaining candidate, preserving singleton
`Int` and `F64` as the unconstrained defaults. Candidate probes use the same undo
journal as right-union choice and never commit a failed alternative. The selected
runtime representation is recorded as an expression-type fact. This elaboration
rule does not add cross-domain range subtyping, so an already-bound numeric value
still requires an explicit conversion.

## 1. Type algebra
""",
)

example = "examples/floats.blot"
replace_once(
    example,
    """// `F64` is the only float type. There is no `1.5` singleton the way there is a
// `1` singleton, because a float bound would have to be a real number and
// nothing the lattice does with bounds — adjacency, enumeration — has a
// meaning there. So a float literal inhabits `F64` and the narrowing machinery
// never has to answer a question about reals.
""",
    """// A float literal has no singleton type the way an integer literal does,
// because a float bound would have to be a real number and nothing the lattice
// does with bounds — adjacency, enumeration — has a meaning there. It defaults
// to `F64`, while an `F32` context selects the single-precision representation.
""",
)

replace_once(
    example,
    """// `F32` is a distinct type reached by conversion. There is no f32 literal: the
// grammar has one float token, and `F32.of_float` is what makes the loss of
// precision a step the program takes rather than one performed on it.
//
// It is a separate type rather than a precision `F64` sometimes has, so mixing
// them is an error rather than a rounding nobody wrote down — and because it is
// the lane type a four-wide vector needs.
""",
    """// `F32` is a distinct type. The grammar has one float token, and an `F32`
// call or signature selects its single-precision representation. Conversion is
// still explicit for a value already bound as `F64`.
//
// It is a separate type rather than a precision `F64` sometimes has, so mixing
// bound values is an error rather than a rounding nobody wrote down — and because
// it is the lane type a four-wide vector needs.
""",
)

replace_once(
    example,
    """    (F32.widen (F32.div (F32.of_int 1) (F32.of_int 3)))
""",
    """    (F32.widen (F32.div 1 3))
""",
)
replace_once(
    example,
    """    (F32.widen (F32.of_float 0.5))
""",
    """    (F32.widen 0.5)
""",
)
replace_once(
    example,
    """    (F32.widen (F32.of_float 0.1))
""",
    """    (F32.widen 0.1)
""",
)

Path("src/compiler/numeric_literals.test.ts").write_text(
    """import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "./session.ts";

const prelude = 'open import "blot:prelude"\\n';

test("numeric literals infer runtime representations from context", async () => {
  const compiler = await Compiler.create();
  try {
    const cases = [
      {
        name: "default-integer",
        source: "return 42\\n",
        type: "42",
        display: "42",
      },
      {
        name: "default-float",
        source: "return 1.5\\n",
        type: "F64",
        display: "1.5",
      },
      {
        name: "integer-as-f64",
        source: prelude + "return F64.add 1 2.5\\n",
        type: "F64",
        display: "3.5",
      },
      {
        name: "integer-as-f32",
        source: prelude + "return F32.add 1 2.5\\n",
        type: "F32",
        display: "3.5",
      },
      {
        name: "float-as-f32",
        source: prelude + "return F32.add 1.5 2.25\\n",
        type: "F32",
        display: "3.75",
      },
    ];

    for (const item of cases) {
      const path = join(tmpdir(), `blot-numeric-literal-${item.name}.blot`);
      const checked = await compiler.checkSource(path, item.source);
      assert.equal(checked.type, item.type, item.name);
      const evaluated = await compiler.evaluate(path);
      assert.equal(evaluated.display, item.display, item.name);
    }
  } finally {
    compiler.destroy();
  }
});
"""
)
