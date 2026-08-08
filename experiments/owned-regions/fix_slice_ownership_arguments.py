from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Public Slice wrappers use tuple parameters while the trusted primitives are
# curried. Ownership must prove the public call at the caller's Region lineage,
# so once an unshadowed Slice.* call is identified as trusted, unpack that one
# tuple argument into the primitive's logical argument positions.
path = "src/linear/check.ts"
replace_once(
    path,
    '''function handleArguments(
  args: readonly Expr[],
): readonly [Expr, Expr, Expr] | null {
''',
    '''function ownershipPrimitiveArguments(
  name: string,
  callee: Expr,
  args: readonly Expr[],
): readonly Expr[] {
  if (callee.tag !== "field") return args;
  if (callee.target.tag !== "var" || callee.target.name !== "Slice") return args;
  const arity = name === "@region.array.get" ||
      name === "@region.array.split" || name === "@region.array.join"
    ? 2
    : name === "@region.array.set" || name === "@region.array.swap"
    ? 3
    : 1;
  if (arity === 1 || args.length !== 1) return args;
  const tuple = args[0];
  if (tuple.tag !== "tuple" || tuple.elements.length !== arity) return args;
  return tuple.elements;
}

function handleArguments(
  args: readonly Expr[],
): readonly [Expr, Expr, Expr] | null {
''',
)

file = Path(path)
text = file.read_text()
needle = '''      if (ownershipPrimitive !== null) {
        const name = ownershipPrimitive;
'''
replacement = '''      if (ownershipPrimitive !== null) {
        const name = ownershipPrimitive;
        const ownershipArguments = ownershipPrimitiveArguments(
          name,
          application.callee,
          application.args,
        );
'''
if text.count(needle) != 1:
    raise SystemExit(f"{path}: ownership primitive block anchor not unique")
text = text.replace(needle, replacement, 1)
start = text.index("        const ownershipArguments = ownershipPrimitiveArguments(")
start = text.index("\n", text.index("        );", start)) + 1
end = text.index("\n      // Applying a linear closure right where it was built", start)
block = text[start:end]
if "application.args" not in block:
    raise SystemExit(f"{path}: ownership primitive block contains no argument uses")
text = text[:start] + block.replace("application.args", "ownershipArguments") + text[end:]
file.write_text(text)


# Rust mirrors the same normalization. Keep the shadow check in
# ownership_primitive_name; this helper only changes arguments after that call
# has already proved the callee is the trusted namespace.
path = "experiments/rust-middle/src/ownership.rs"
replace_once(
    path,
    '''fn walk_apply(
    expression: ExpressionId,
''',
    '''fn ownership_primitive_arguments(
    analysis: &Analysis<'_>,
    callee: ExpressionId,
    arguments: &[ExpressionId],
    name: Option<&str>,
) -> Vec<ExpressionId> {
    let Some(name) = name else {
        return arguments.to_vec();
    };
    let Expression::Field { target, .. } =
        &analysis.module.arena.expressions[callee.0 as usize]
    else {
        return arguments.to_vec();
    };
    if !matches!(
        &analysis.module.arena.expressions[target.0 as usize],
        Expression::Var { name, .. } if name == "Slice"
    ) {
        return arguments.to_vec();
    }
    let arity = match name {
        "@region.array.get" | "@region.array.split" | "@region.array.join" => 2,
        "@region.array.set" | "@region.array.swap" => 3,
        _ => 1,
    };
    if arity == 1 || arguments.len() != 1 {
        return arguments.to_vec();
    }
    match &analysis.module.arena.expressions[arguments[0].0 as usize] {
        Expression::Tuple { elements, .. } if elements.len() == arity => elements.clone(),
        _ => arguments.to_vec(),
    }
}

fn walk_apply(
    expression: ExpressionId,
''',
)

replace_once(
    path,
    '''    if let Some(name) = ownership_primitive_name(analysis, scope, callee) {
''',
    '''    let ownership_primitive = ownership_primitive_name(analysis, scope, callee);
    let ownership_arguments =
        ownership_primitive_arguments(analysis, callee, &arguments, ownership_primitive);
    if let Some(name) = ownership_primitive {
        let arguments = &ownership_arguments;
''',
)

# The quicksort transfers Region authority through every helper and recursive
# tail call. State that contract in the parameter patterns as well as the type
# signatures so the ownership checker can certify each `!region` argument.
path = "examples/owned_slice_quicksort.blot"
replace_once(path, "let keep_swap = fn (region, left, right) =>\n", "let keep_swap = fn (!region, left, right) =>\n")
replace_once(
    path,
    "  rec (fn (region, pivot, scan, boundary, limit) =>\n",
    "  rec (fn (!region, pivot, scan, boundary, limit) =>\n",
)
replace_once(path, "  rec (fn region =>\n", "  rec (fn !region =>\n")
replace_once(
    path,
    "  rec (fn (region, pivot_index) =>\n",
    "  rec (fn (!region, pivot_index) =>\n",
)
replace_once(
    path,
    "  rec (fn (left, rest) =>\n",
    "  rec (fn (!left, !rest) =>\n",
)

print("normalized tupled Slice ownership arguments and explicit quicksort Region transfers")
