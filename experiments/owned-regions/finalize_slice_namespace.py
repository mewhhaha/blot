from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Match the existing Array namespace style: ordinary inferred wrappers. The
# ownership pass recognizes Slice.* at caller sites so concrete Region lineage
# never gets replaced by a wrapper parameter's generic ownership summary.
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
    .claim = fn values => @region.array.claim values;
    .length = fn &region => @region.array.length (&region);
    .get = fn (&region, index) => @region.array.get (&region) index;
    .set = fn (!region, index, value) => @region.array.set (!region) index value;
    .swap = fn (!region, left, right) => @region.array.swap (!region) left right;
    .split = fn (!region, index) => @region.array.split (!region) index;
    .join = fn (!left, !right) => @region.array.join (!left) (!right);
    .freeze = fn !region => @region.array.freeze (!region);
  }
'''
replace_once(path, start, replacement)

# TypeScript ownership: an unshadowed Slice field is the corresponding trusted
# primitive at the caller, so its operation runs over the caller's real Region
# lineage rather than the wrapper closure's generic parameter summary.
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

# Rust caller-side namespace recognition mirrors TypeScript and refuses a local
# binding that shadows the built-in Slice namespace.
path = "experiments/rust-middle/src/ownership.rs"
replace_once(
    path,
    '''fn walk_apply(
    expression: ExpressionId,
''',
    '''fn ownership_primitive_name<'a>(
    analysis: &'a Analysis<'_>,
    scope: &ScopeRef,
    callee: ExpressionId,
) -> Option<&'a str> {
    match &analysis.module.arena.expressions[callee.0 as usize] {
        Expression::Intrinsic { name, .. } => Some(name.as_str()),
        Expression::Field { target, name, .. }
            if analysis.lookup(scope, "Slice").is_none()
                && matches!(
                    &analysis.module.arena.expressions[target.0 as usize],
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
    '''    if let Some(name) = ownership_primitive_name(analysis, scope, callee) {
''',
)

# The built-in prelude itself necessarily defines those wrappers over abstract
# Region parameters. Only its snapshot path gets this exemption. A user wrapper
# receives the ordinary proof rules and therefore cannot hide an unproved join
# or partial freeze behind a function call.
replace_once(
    path,
    '''struct Analysis<'a> {
    module: &'a Module,
    diagnostics: Vec<Diagnostic>,
    function_results: HashMap<ExpressionId, Produced>,
}

pub fn check(module: &Module) -> Vec<Diagnostic> {
    let mut analysis = Analysis {
        module,
        diagnostics: Vec::new(),
        function_results: HashMap::new(),
    };
''',
    '''struct Analysis<'a> {
    module: &'a Module,
    diagnostics: Vec<Diagnostic>,
    function_results: HashMap<ExpressionId, Produced>,
    trusted_region_wrappers: bool,
}

pub fn check(module: &Module) -> Vec<Diagnostic> {
    check_with_region_wrapper_trust(module, false)
}

pub(crate) fn check_trusted_region_wrappers(module: &Module) -> Vec<Diagnostic> {
    check_with_region_wrapper_trust(module, true)
}

fn check_with_region_wrapper_trust(
    module: &Module,
    trusted_region_wrappers: bool,
) -> Vec<Diagnostic> {
    let mut analysis = Analysis {
        module,
        diagnostics: Vec::new(),
        function_results: HashMap::new(),
        trusted_region_wrappers,
    };
''',
)

# Abstract prelude split: enough to certify the wrapper itself; caller-side
# Slice.split ignores this generic summary and derives concrete sibling lineage.
replace_once(
    path,
    '''            let Produced::Region {
                qualifier,
                root,
                splits,
            } = region.clone()
            else {
                analysis.report(
                    "BLOT_REGION_SPLIT_NOT_OWNED",
                    "Region split requires one owned Region authority.",
                    analysis.module.arena.expression_span(arguments[0]),
                );
                return Produced::None;
            };
''',
    '''            let (qualifier, root, splits) = match region.clone() {
                Produced::Region {
                    qualifier,
                    root,
                    splits,
                } => (qualifier, root, splits),
                Produced::Leaf(qualifier) if analysis.trusted_region_wrappers => {
                    return Produced::Choice(BTreeMap::from([
                        (
                            "Split".to_owned(),
                            Produced::Variant(Box::new(Produced::Sequence(vec![
                                Produced::Leaf(qualifier),
                                Produced::Leaf(qualifier),
                            ]))),
                        ),
                        (
                            "SplitOutOfBounds".to_owned(),
                            Produced::Variant(Box::new(Produced::Leaf(qualifier))),
                        ),
                    ]));
                }
                _ => {
                    analysis.report(
                        "BLOT_REGION_SPLIT_NOT_OWNED",
                        "Region split requires one owned Region authority.",
                        analysis.module.arena.expression_span(arguments[0]),
                    );
                    return Produced::None;
                }
            };
''',
)

# Abstract prelude join/freeze are trusted only while certifying snapshot:prelude.
replace_once(
    path,
    '''        if name == "@region.array.join" && arguments.len() == 2 {
            let left = walk(arguments[0], scope, analysis, Use::Move);
            let right = walk(arguments[1], scope, analysis, Use::Move);
            return join_region(left, right, span, analysis);
        }
        if name == "@region.array.freeze" && arguments.len() == 1 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            match region {
                Produced::Region { splits, .. } if splits.is_empty() => {}
                _ => analysis.report(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region authority can be frozen. Rejoin every split first.",
                    analysis.module.arena.expression_span(arguments[0]),
                ),
            }
            return Produced::None;
        }
''',
    '''        if name == "@region.array.join" && arguments.len() == 2 {
            let left = walk(arguments[0], scope, analysis, Use::Move);
            let right = walk(arguments[1], scope, analysis, Use::Move);
            if analysis.trusted_region_wrappers
                && !matches!(left, Produced::Region { .. })
                && !matches!(right, Produced::Region { .. })
            {
                return combine(left, right);
            }
            return join_region(left, right, span, analysis);
        }
        if name == "@region.array.freeze" && arguments.len() == 1 {
            let region = walk(arguments[0], scope, analysis, Use::Move);
            match region {
                Produced::Region { splits, .. } if splits.is_empty() => {}
                _ if analysis.trusted_region_wrappers && obligation(&region) != Obligation::None => {}
                _ => analysis.report(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region authority can be frozen. Rejoin every split first.",
                    analysis.module.arena.expression_span(arguments[0]),
                ),
            }
            return Produced::None;
        }
''',
)

# The Rust type checker knows the module path. The only trusted wrapper source is
# the compiler's own prelude snapshot; normal user modules never get this flag.
path = "experiments/rust-middle/src/typecheck.rs"
replace_once(
    path,
    '''        let analyses = CachedModuleAnalyses {
            ownership: crate::ownership::check(module)
                .into_iter()
                .next()
                .map_or(Ok(()), Err),
''',
    '''        let ownership_diagnostics = if path == "snapshot:prelude" {
            crate::ownership::check_trusted_region_wrappers(module)
        } else {
            crate::ownership::check(module)
        };
        let analyses = CachedModuleAnalyses {
            ownership: ownership_diagnostics
                .into_iter()
                .next()
                .map_or(Ok(()), Err),
''',
)

print("made Slice ordinary wrappers with caller-lineage ownership")