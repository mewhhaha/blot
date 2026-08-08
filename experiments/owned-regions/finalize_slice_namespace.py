from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# The public namespace exposes the trusted primitives directly. Wrapping them in
# closures would sever the caller's static Region lineage at the wrapper
# parameter, which is exactly the proof split/join need to preserve.
path = "src/prelude/prelude.blot"
start = '''const Slice =
  {
    .of = @region.array.type;
    .claim = fn values => @region.array.claim values;
    .length = fn &region => @region.array.length (&region);
    .get = fn (&region, index) => @region.array.get (&region) index;
    .set = fn (!region, index, value) =>
      @region.array.set (!region) index value
    ;
    .swap = fn (!region, left, right) =>
      @region.array.swap (!region) left right
    ;
    .split = fn (!region, index) => @region.array.split (!region) index;
    .join = fn (!left, !right) => @region.array.join (!left) (!right);
    .freeze = fn !region => @region.array.freeze (!region);
  }
'''
replacement = '''const Slice =
  {
    .claim = @region.array.claim;
    .length = @region.array.length;
    .get = @region.array.get;
    .set = @region.array.set;
    .swap = @region.array.swap;
    .split = @region.array.split;
    .join = @region.array.join;
    .freeze = @region.array.freeze;
  }
'''
replace_once(path, start, replacement)

# TypeScript ownership: recognize an unshadowed Slice field as the corresponding
# trusted primitive, then reuse the exact intrinsic ownership rule.
path = "src/linear/check.ts"
replace_once(
    path,
    '''function handleArguments(
  args: readonly Expr[],
): readonly [Expr, Expr, Expr] | null {
''',
    '''function ownershipPrimitiveName(callee: Expr, scope: Scope): string | null {
  if (callee.tag === "intrinsic") return callee.name;
  if (
    callee.tag !== "field" || callee.target.tag !== "var" ||
    callee.target.name !== "Slice" || analysisBinding(scope, "Slice") !== null
  ) return null;
  switch (callee.name) {
    case "claim":
      return "@region.array.claim";
    case "length":
      return "@region.array.length";
    case "get":
      return "@region.array.get";
    case "set":
      return "@region.array.set";
    case "swap":
      return "@region.array.swap";
    case "split":
      return "@region.array.split";
    case "join":
      return "@region.array.join";
    case "freeze":
      return "@region.array.freeze";
    default:
      return null;
  }
}

function handleArguments(
  args: readonly Expr[],
): readonly [Expr, Expr, Expr] | null {
''',
)
replace_once(
    path,
    '''      if (application.callee.tag === "intrinsic") {
        const name = application.callee.name;
''',
    '''      const ownershipPrimitive = ownershipPrimitiveName(
        application.callee,
        scope,
      );
      if (ownershipPrimitive !== null) {
        const name = ownershipPrimitive;
''',
)

# Rust ownership uses the same namespace recognition. The helper also returns
# ordinary intrinsics unchanged, so existing @handle/@array logic keeps the same
# control path.
path = "experiments/rust-middle/src/ownership.rs"
replace_once(
    path,
    '''fn walk_apply(
    expression: ExpressionId,
''',
    '''fn ownership_primitive_name<'a>(module: &'a Module, callee: ExpressionId) -> Option<&'a str> {
    match &module.arena.expressions[callee.0 as usize] {
        Expression::Intrinsic { name, .. } => Some(name.as_str()),
        Expression::Field { target, name, .. }
            if matches!(
                &module.arena.expressions[target.0 as usize],
                Expression::Var { name: namespace, .. } if namespace == "Slice"
            ) => match name.as_str() {
                "claim" => Some("@region.array.claim"),
                "length" => Some("@region.array.length"),
                "get" => Some("@region.array.get"),
                "set" => Some("@region.array.set"),
                "swap" => Some("@region.array.swap"),
                "split" => Some("@region.array.split"),
                "join" => Some("@region.array.join"),
                "freeze" => Some("@region.array.freeze"),
                _ => None,
            },
        _ => None,
    }
}

fn walk_apply(
    expression: ExpressionId,
''',
)
replace_once(
    path,
    '''    if let Expression::Intrinsic { name, .. } =
        &analysis.module.arena.expressions[callee.0 as usize]
    {
''',
    '''    if let Some(name) = ownership_primitive_name(analysis.module, callee) {
''',
)

print("made Slice a direct trusted primitive namespace")
