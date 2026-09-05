"""Temporary development patch; removed before publishing the draft."""
from pathlib import Path
import subprocess

BASE = "2816fbc82f0201614463fd64a5e99361beb6e961"

def once(text, before, after):
    count = text.count(before)
    assert count == 1, (before[:160], count)
    return text.replace(before, after, 1)

p = Path("compiler/src/eval.rs")
t = p.read_text()
t = once(t, "    pub(crate) fn decorate_operator_type(&self, value: Value) -> Value {\n", """    pub(crate) fn decorate_operator_type(&self, value: Value) -> Value {
        // Reified singleton types use their scalar inhabitant as the canonical
        // type value. Preserve those bounds while recovering the member domain.
        // Ordinary scalar projection does not call this type-only entry point.
        let value = match value {
            Value::Int(integer) => Value::Range {
                low: Box::new(Value::Int(integer.clone())),
                high: Box::new(Value::Int(integer)),
                domain: Some(ValueDomain::Int),
            },
            Value::Text(text) => Value::Range {
                low: Box::new(Value::Text(text.clone())),
                high: Box::new(Value::Text(text)),
                domain: Some(ValueDomain::Text),
            },
            value => value,
        };
""")
p.write_text(t)

p = Path("compiler/src/typecheck.rs")
t = p.read_text()
t = once(t, "mod operators;", "mod integer;\nmod operators;")
p.write_text(t)

p = Path("compiler/src/typecheck/operators.rs")
t = p.read_text()
t = once(t, "        if !attached && !needs_specialization {", """        let integer_primitive = matches!(
            &member,
            Value::Primitive { name, arity, applied }
                if integer::ARITHMETIC.iter().any(|(primitive, count)| {
                    name == primitive && arity == count
                        && applied.len() + arguments.len() == *arity
                })
        );
        if !attached && !needs_specialization && !integer_primitive {""")
t = once(t, "            return self.apply_member_signature(type_, arguments, span);\n        };", """            let mut inferred = self.apply_member_signature(type_, arguments, span)?;
            if let Value::Primitive { name, applied, .. } = value {
                let mut operands = applied.iter()
                    .map(|value| self.bridge_runtime_value(value)).collect::<Vec<_>>();
                operands.extend_from_slice(arguments);
                if let Some(refined) = integer::primitive_result(self, name, &operands) {
                    inferred.type_ = refined;
                }
            }
            return Ok(inferred);
        };""")
p.write_text(t)

p = Path("LANGUAGE.md")
t = subprocess.check_output(["git", "show", f"{BASE}:{p}"], text=True)
t = once(t, """There is no implicit conversion between the numeric types, and no operator
serves more than one. An operator resolves to one binding by name (§4.7), so a
`+` over both would have to dispatch on a value's type at run time. `F64.of_int`
and `F64.truncate` cross explicitly; `truncate` rounds toward zero.
""", """There is no implicit conversion between bound numeric values. `F64.of_int`
and `F64.truncate` cross explicitly; `truncate` rounds toward zero.

An operator still resolves to one source binding by name (§4.7), but that
binding can select a member of an operand's inferred type at compile time.
The standard binary arithmetic operators and prefix `-` do this through `Op`.
The same `+` therefore works for `Int`, `F64`, and `F32`; prefix `-` selects
that type's attached `.negate`. This does not add runtime type dispatch or a
cross-domain conversion.

A selected source member's checked signature and implementation determine its
arguments, effects, and result. The field spelling alone grants no numeric
contract: a custom `.add` may return a text or a refined integer when its
signature says so. A generic source wrapper retains the need for member lookup
until its receiver type is known, and each concrete application checks that
requirement independently instead of defaulting unknown operands to `Int`.
A missing member at a concrete application is a diagnostic.

Integer primitive application can preserve a conservative result interval for
addition, subtraction, multiplication, division, remainder, and negation.
These facts belong to the actual primitive, not to an operator's spelling.
They flow through source dispatch and checked signatures. Division and
remainder do not infer a narrower result when the divisor interval includes
zero; uncertain or overflowing bounds retain the ordinary broad `Int`
contract and do not establish a wrapping or overflow-freedom proof.
""")
p.write_text(t)

p = Path("spec/TYPECHECKING.md")
t = subprocess.check_output(["git", "show", f"{BASE}:{p}"], text=True)
t = once(t, "## 1. Type algebra\n", """### Source-member application requirements

A fixity expands to an ordinary source call; its spelling contributes no type
rule. For `(@type.inferred receiver).member`, elaboration settles the receiver,
reifies its type value, and selects the actual attached member. A reified
singleton keeps its bounds while using its underlying scalar domain for this
lookup. Ordinary projection on a scalar value does not acquire type members.

An unresolved receiver is a specialization requirement on its enclosing source
closures, including every curried parameter stage. It is not an implicit `Int`
constraint. Concrete calls check the captured source implementation with their
own argument types. Explicit attached signatures remain obligations: source
specialization may preserve a narrower result but cannot accept an argument or
effect forbidden by that signature. A concrete missing member is rejected;
member spelling never substitutes for the selected function's contract.

Primitive interval transfer occurs only after ordinary primitive argument
constraints succeed. It uses the identity of the selected integer primitive,
not the dispatch field's name. Finite union operands may be conservatively
replaced by their interval hull. Addition, subtraction, and negation transform
known bounds; multiplication and zero-free division use finite endpoint
extrema; remainder uses the numerator sign and divisor magnitude. A divisor
interval containing zero or an interval crossing the signed runtime boundary
supplies no extra refinement. Existing safety analyses remain responsible for
trap obligations. These transfers introduce no new type constructor and never
narrow a custom source operation merely because it is named `.add`.

## 1. Type algebra
""")
p.write_text(t)

p = Path("src/prelude/prelude.blot")
t = p.read_text()
# The float namespace's prose predates inferred-type operator dispatch.
lines = t.splitlines()
for number, line in enumerate(lines):
    if "operator" in line.lower() and ("float" in line.lower() or "one" in line.lower()):
        print(f"prelude comment {number + 1}: {line}")
p.write_text(t)

p = Path("compiler/src/session.rs")
t = p.read_text()
start = t.index("    fn source_operator_regressions()")
prefix, tests = t[:start], t[start:]
tests = once(tests, "            let cases = [", r'''            let cases = [
                ("arithmetic-result-interval", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const Int = @type.attach @type.int \"add\" @int.add\n",
                    "const add = fn left => fn right => left + right\n",
                    "let result :: @type.range 5 5\n",
                    "let result = add 2 3\n",
                    "return result\n",
                ), true),
                ("arithmetic-wrong-result-rejected", concat!(
                    "const Op = { .add = fn left => fn right => (@type.inferred left).add left right; }\n",
                    "const Int = @type.attach @type.int \"add\" @int.add\n",
                    "let result :: @type.range 6 6\n",
                    "let result = 2 + 3\n",
                    "return result\n",
                ), false),
''')
p.write_text(prefix + tests)
