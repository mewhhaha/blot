from pathlib import Path
import subprocess


def text(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    Path(path).write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    content = text(path)
    count = content.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


def restore_main(path: str) -> None:
    content = subprocess.check_output(
        ["git", "show", f"origin/main:{path}"], text=True
    )
    write(path, content)


# Restore core files that early patch probes rewrote too broadly. Reapply only
# the Region-specific cases below so the review diff preserves the mainline
# documentation and comments.
for path in [
    "src/check/bridge.ts",
    "src/check/constrain.ts",
    "src/check/print.ts",
    "src/comptime/value.ts",
]:
    restore_main(path)

# ---------------------------------------------------------------------------
# TypeScript value/type bridge.
# ---------------------------------------------------------------------------
path = "src/comptime/value.ts"
replace_once(
    path,
    '  | { readonly tag: "array"; readonly elements: readonly Value[] }\n',
    '''  | { readonly tag: "array"; readonly elements: readonly Value[] }\n  /** Private type value produced only by `@region.array.type`. */\n  | { readonly tag: "region-type"; readonly element: Value }\n  /** Compiler-private mutable slice over one backing Store. */\n  | {\n    readonly tag: "region-array";\n    readonly store: { readonly cells: Value[] };\n    readonly start: number;\n    readonly end: number;\n  }\n''',
)
replace_once(
    path,
    '  if (value.tag === "opaque-type") return value.name;\n',
    '''  if (value.tag === "opaque-type") return value.name;\n  if (value.tag === "region-type") return `Region ${show(value.element)}`;\n  if (value.tag === "region-array") {\n    return `<region ${value.start}..${value.end}>`;\n  }\n''',
)
replace_once(
    path,
    '''  if (left.tag === "shape" && right.tag === "shape") {\n''',
    '''  if (left.tag === "region-type" && right.tag === "region-type") {\n    return equal(left.element, right.element);\n  }\n  if (left.tag === "region-array" && right.tag === "region-array") {\n    return left.store === right.store && left.start === right.start &&\n      left.end === right.end;\n  }\n  if (left.tag === "shape" && right.tag === "shape") {\n''',
)

path = "src/check/bridge.ts"
replace_once(
    path,
    'import {\n  effectExtension,\n',
    'import "./region_primitives.ts";\nimport {\n  effectExtension,\n',
)
replace_once(
    path,
    '''    case "effect": {\n''',
    '''    case "region-type": {\n      const element = bridgeValue(value.element, variables);\n      if (element === null) return null;\n      return { tag: "region", element };\n    }\n\n    case "effect": {\n''',
)
replace_once(
    path,
    '''    case "variant": {\n''',
    '''    // Region capability representations are intentionally not reified.\n    case "region":\n      return null;\n\n    case "variant": {\n''',
)

path = "src/check/constrain.ts"
replace_once(
    path,
    '''    case "array":\n      return "an array";\n''',
    '''    case "array":\n      return "an array";\n    case "region":\n      return "an owned array region";\n''',
)
replace_once(
    path,
    '''  if (lhs.tag === "variant" && rhs.tag === "variant") {\n''',
    '''  if (lhs.tag === "region" && rhs.tag === "region") {\n    // Regions are readable and replaceable, so their element is invariant.\n    constrainWithState(lhs.element, rhs.element, state);\n    constrainWithState(rhs.element, lhs.element, state);\n    return;\n  }\n\n  if (lhs.tag === "variant" && rhs.tag === "variant") {\n''',
)
replace_once(
    path,
    '''    case "array":\n      return {\n        tag: "array",\n        element: extrude(type.element, polarity, level, seen, state),\n      };\n''',
    '''    case "array":\n      return {\n        tag: "array",\n        element: extrude(type.element, polarity, level, seen, state),\n      };\n    case "region":\n      return {\n        tag: "region",\n        element: extrude(type.element, polarity, level, seen, state),\n      };\n''',
)
replace_once(
    path,
    '''    case "array":\n      return levelBelow(type.element, level);\n''',
    '''    case "array":\n    case "region":\n      return levelBelow(type.element, level);\n''',
)
# Insert Region freshening beside Array freshening.
array_fresh = '''    case "array": {\n      const freshened: SimpleType = {\n        tag: "array",\n        element: freshenAbove(\n          type.element,\n          limit,\n          level,\n          freshenedTypes,\n          instances,\n        ),\n      };\n      freshenedTypes.set(type, freshened);\n      return freshened;\n    }\n'''
replace_once(
    path,
    array_fresh,
    array_fresh + '''    case "region": {\n      const freshened: SimpleType = {\n        tag: "region",\n        element: freshenAbove(\n          type.element,\n          limit,\n          level,\n          freshenedTypes,\n          instances,\n        ),\n      };\n      freshenedTypes.set(type, freshened);\n      return freshened;\n    }\n''',
)
replace_once(
    path,
    '''    case "array":\n      return {\n        tag: "array",\n        element: substituteRigid(type.element, replacements),\n      };\n''',
    '''    case "array":\n      return {\n        tag: "array",\n        element: substituteRigid(type.element, replacements),\n      };\n    case "region":\n      return {\n        tag: "region",\n        element: substituteRigid(type.element, replacements),\n      };\n''',
)

path = "src/check/print.ts"
replace_once(
    path,
    '''      case "array":\n        return `[${go(current.element, polarity)}]`;\n''',
    '''      case "array":\n        return `[${go(current.element, polarity)}]`;\n\n      case "region":\n        return `Region ${go(current.element, polarity)}`;\n''',
)
replace_once(
    path,
    '''      case "array":\n        walk(current.element, polarity);\n''',
    '''      case "array":\n      case "region":\n        walk(current.element, polarity);\n''',
)

# ---------------------------------------------------------------------------
# Total Region ownership results in the TypeScript ownership checker.
# ---------------------------------------------------------------------------
path = "src/linear/check.ts"
replace_once(
    path,
    '''          return region;\n        }\n        if (name === "@region.array.swap" && application.args.length === 3) {\n          const region = walk(application.args[0], scope, analysis, "move");\n          walk(application.args[1], scope, analysis, "move");\n          walk(application.args[2], scope, analysis, "move");\n          return region;\n        }\n''',
    '''          return {\n            tag: "choice",\n            cases: new Map([\n              ["Updated", region],\n              ["SetOutOfBounds", region],\n            ]),\n          };\n        }\n        if (name === "@region.array.swap" && application.args.length === 3) {\n          const region = walk(application.args[0], scope, analysis, "move");\n          walk(application.args[1], scope, analysis, "move");\n          walk(application.args[2], scope, analysis, "move");\n          return {\n            tag: "choice",\n            cases: new Map([\n              ["Updated", region],\n              ["SwapOutOfBounds", region],\n            ]),\n          };\n        }\n''',
)

# ---------------------------------------------------------------------------
# Rust checker primitive signatures.
# ---------------------------------------------------------------------------
path = "experiments/rust-middle/src/typecheck.rs"
replace_once(
    path,
    '''        "@region.array.get" => {\n            let element = checker.fresh();\n            curried(\n                vec![Type::Region(Box::new(element.clone())), int.clone()],\n                element,\n            )\n        }\n        "@region.array.set" => {\n            let element = checker.fresh();\n            let region = Type::Region(Box::new(element.clone()));\n            curried(vec![region.clone(), int.clone(), element], region)\n        }\n        "@region.array.swap" => {\n            let region = Type::Region(Box::new(checker.fresh()));\n            curried(vec![region.clone(), int.clone(), int.clone()], region)\n        }\n''',
    '''        "@region.array.get" => {\n            let element = checker.fresh();\n            curried(\n                vec![Type::Region(Box::new(element.clone())), int.clone()],\n                Type::Variant {\n                    cases: vec![\n                        ("Some".to_owned(), element),\n                        ("None".to_owned(), Type::Unit),\n                    ],\n                    open: false,\n                },\n            )\n        }\n        "@region.array.set" => {\n            let element = checker.fresh();\n            let region = Type::Region(Box::new(element.clone()));\n            curried(\n                vec![region.clone(), int.clone(), element],\n                Type::Variant {\n                    cases: vec![\n                        ("Updated".to_owned(), region.clone()),\n                        ("SetOutOfBounds".to_owned(), region),\n                    ],\n                    open: false,\n                },\n            )\n        }\n        "@region.array.swap" => {\n            let region = Type::Region(Box::new(checker.fresh()));\n            curried(\n                vec![region.clone(), int.clone(), int.clone()],\n                Type::Variant {\n                    cases: vec![\n                        ("Updated".to_owned(), region.clone()),\n                        ("SwapOutOfBounds".to_owned(), region),\n                    ],\n                    open: false,\n                },\n            )\n        }\n''',
)

# ---------------------------------------------------------------------------
# Rust evaluator: total Region bounds and authority-conserving failures.
# ---------------------------------------------------------------------------
path = "experiments/rust-middle/src/primitives.rs"
replace_once(
    path,
    '''        "@region.array.get" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let relative = index(&arguments[1], span, name)?;\n            if relative >= end - start {\n                return Err(out_of_bounds(relative, end - start, span));\n            }\n            let value = store.borrow()[start + relative].clone();\n            Ok(value)\n        }\n        "@region.array.set" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let relative = index(&arguments[1], span, name)?;\n            if relative >= end - start {\n                return Err(out_of_bounds(relative, end - start, span));\n            }\n            store.borrow_mut()[start + relative] = arguments[2].clone();\n            Ok(arguments[0].clone())\n        }\n        "@region.array.swap" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let left = index(&arguments[1], span, name)?;\n            let right = index(&arguments[2], span, name)?;\n            let length = end - start;\n            if left >= length {\n                return Err(out_of_bounds(left, length, span));\n            }\n            if right >= length {\n                return Err(out_of_bounds(right, length, span));\n            }\n            store.borrow_mut().swap(start + left, start + right);\n            Ok(arguments[0].clone())\n        }\n        "@region.array.split" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let offset = index(&arguments[1], span, name)?;\n            if offset > end - start {\n                return Ok(Value::Tag {\n                    name: "SplitOutOfBounds".to_owned(),\n                    payload: Some(Box::new(arguments[0].clone())),\n                });\n            }\n''',
    '''        "@region.array.get" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let Some(relative) = region_index(&arguments[1], end - start, span, name)? else {\n                return Ok(Value::Tag { name: "None".to_owned(), payload: None });\n            };\n            let value = store.borrow()[start + relative].clone();\n            Ok(Value::Tag {\n                name: "Some".to_owned(),\n                payload: Some(Box::new(value)),\n            })\n        }\n        "@region.array.set" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let Some(relative) = region_index(&arguments[1], end - start, span, name)? else {\n                return Ok(Value::Tag {\n                    name: "SetOutOfBounds".to_owned(),\n                    payload: Some(Box::new(arguments[0].clone())),\n                });\n            };\n            store.borrow_mut()[start + relative] = arguments[2].clone();\n            Ok(Value::Tag {\n                name: "Updated".to_owned(),\n                payload: Some(Box::new(arguments[0].clone())),\n            })\n        }\n        "@region.array.swap" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let length = end - start;\n            let left = region_index(&arguments[1], length, span, name)?;\n            let right = region_index(&arguments[2], length, span, name)?;\n            let (Some(left), Some(right)) = (left, right) else {\n                return Ok(Value::Tag {\n                    name: "SwapOutOfBounds".to_owned(),\n                    payload: Some(Box::new(arguments[0].clone())),\n                });\n            };\n            store.borrow_mut().swap(start + left, start + right);\n            Ok(Value::Tag {\n                name: "Updated".to_owned(),\n                payload: Some(Box::new(arguments[0].clone())),\n            })\n        }\n        "@region.array.split" => {\n            let (store, start, end) = region(&arguments[0], span, name)?;\n            let Some(offset) = region_split_offset(&arguments[1], end - start, span, name)? else {\n                return Ok(Value::Tag {\n                    name: "SplitOutOfBounds".to_owned(),\n                    payload: Some(Box::new(arguments[0].clone())),\n                });\n            };\n''',
)
replace_once(
    path,
    '''fn out_of_bounds(index: usize, length: usize, span: Span) -> Diagnostic {\n''',
    '''fn region_index(\n    value: &Value,\n    length: usize,\n    span: Span,\n    what: &str,\n) -> Result<Option<usize>, Diagnostic> {\n    let index = integer(value, span, what)?;\n    let Some(index) = index.to_usize() else {\n        return Ok(None);\n    };\n    Ok((index < length).then_some(index))\n}\n\nfn region_split_offset(\n    value: &Value,\n    length: usize,\n    span: Span,\n    what: &str,\n) -> Result<Option<usize>, Diagnostic> {\n    let index = integer(value, span, what)?;\n    let Some(index) = index.to_usize() else {\n        return Ok(None);\n    };\n    Ok((index <= length).then_some(index))\n}\n\nfn out_of_bounds(index: usize, length: usize, span: Span) -> Diagnostic {\n''',
)

# ---------------------------------------------------------------------------
# Rust ownership: set/swap return constructor-sensitive alternatives.
# ---------------------------------------------------------------------------
path = "experiments/rust-middle/src/ownership.rs"
replace_once(
    path,
    '''            return region;\n        }\n        if name == "@region.array.swap" && arguments.len() == 3 {\n            let region = walk(arguments[0], scope, analysis, Use::Move);\n            walk(arguments[1], scope, analysis, Use::Move);\n            walk(arguments[2], scope, analysis, Use::Move);\n            return region;\n        }\n''',
    '''            return Produced::Choice(BTreeMap::from([\n                (\n                    "Updated".to_owned(),\n                    Produced::Variant(Box::new(region.clone())),\n                ),\n                (\n                    "SetOutOfBounds".to_owned(),\n                    Produced::Variant(Box::new(region)),\n                ),\n            ]));\n        }\n        if name == "@region.array.swap" && arguments.len() == 3 {\n            let region = walk(arguments[0], scope, analysis, Use::Move);\n            walk(arguments[1], scope, analysis, Use::Move);\n            walk(arguments[2], scope, analysis, Use::Move);\n            return Produced::Choice(BTreeMap::from([\n                (\n                    "Updated".to_owned(),\n                    Produced::Variant(Box::new(region.clone())),\n                ),\n                (\n                    "SwapOutOfBounds".to_owned(),\n                    Produced::Variant(Box::new(region)),\n                ),\n            ]));\n        }\n''',
)

# ---------------------------------------------------------------------------
# Runtime HIR: opaque Region Product plus total relative accesses.
# ---------------------------------------------------------------------------
path = "experiments/rust-middle/src/hir.rs"
content = text(path)
case_start = content.index('            "@region.array.claim" if arguments.len() == 1 => {')
case_end = content.index('            "@array.len" => {', case_start)
region_cases = r'''            "@region.array.claim" if arguments.len() == 1 => {
                let original = &arguments[0];
                let lowered = self.lower_value(original, span)?;
                if !matches!(self.types[lowered.type_id], RuntimeType::Store { .. }) {
                    return Err(hir_error("Region claim lowered a non-Store array."));
                }
                let store = if matches!(original, Value::Array(_))
                    || matches!(lowered.meaning, RuntimeMeaning::ReusableStore)
                {
                    RuntimeValue {
                        meaning: RuntimeMeaning::Plain,
                        ..lowered
                    }
                } else {
                    self.private_store_copy(lowered, span)?
                };
                let integer = self.region_integer_type();
                let length = self.operation("store.length", integer, vec![store.id], span, None);
                let zero = self.constant(
                    WireConstant::SignedInteger64("0".to_owned()),
                    integer,
                    span,
                );
                self.make_region(store, zero, length, span)?
            }
            "@region.array.length" if arguments.len() == 1 => {
                let (_, start, end) = self.lower_region(&arguments[0], span)?;
                let integer = self.region_integer_type();
                self.operation(
                    "scalar",
                    integer,
                    vec![end.id, start.id],
                    span,
                    Some("subtract"),
                )
            }
            "@region.array.get" if arguments.len() == 2 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                self.region_get(store, start, end, index, span)?
            }
            "@region.array.set" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Region Store projection lost its Store type."));
                };
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let value = self.lower_store_element(&arguments[2], element_type, span)?;
                self.region_set(store, start, end, index, value, span)?
            }
            "@region.array.swap" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let left = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let right = self.lower_as(Some(&arguments[2]), "signed-integer-64", span)?;
                self.region_swap(store, start, end, left, right, span)?
            }
            "@region.array.split" if arguments.len() == 2 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let offset = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                self.split_region(store, start, end, offset, span)?
            }
            "@region.array.join" if arguments.len() == 2 => {
                let (left_store, left_start, _) = self.lower_region(&arguments[0], span)?;
                let (_, _, right_end) = self.lower_region(&arguments[1], span)?;
                // Ordered sibling lineage was proved before destructive HIR is emitted.
                self.make_region(left_store, left_start, right_end, span)?
            }
            "@region.array.freeze" if arguments.len() == 1 => {
                let (store, _, _) = self.lower_region(&arguments[0], span)?;
                RuntimeValue {
                    meaning: RuntimeMeaning::Plain,
                    ..store
                }
            }
'''
write(path, content[:case_start] + region_cases + content[case_end:])

content = text(path)
helper_start = content.index('    fn region_type(')
helper_end = content.index('    fn product_type(', helper_start)
helpers = r'''    fn region_integer_type(&mut self) -> usize {
        self.insert_type("signed-integer-64", RuntimeType::SignedInteger64)
    }

    fn region_type(&mut self, store_type: usize) -> Result<usize, Diagnostic> {
        if !matches!(self.types[store_type], RuntimeType::Store { .. }) {
            return Err(hir_error("Region backing type is not a Store."));
        }
        let key = format!("region:{store_type}");
        if let Some(existing) = self.type_ids.get(&key) {
            return Ok(*existing);
        }
        let integer = self.region_integer_type();
        Ok(self.insert_type(
            &key,
            RuntimeType::Product {
                name: format!("$region:{store_type}"),
                fields: vec![
                    RuntimeField {
                        name: "end".to_owned(),
                        type_id: integer,
                    },
                    RuntimeField {
                        name: "start".to_owned(),
                        type_id: integer,
                    },
                    RuntimeField {
                        name: "store".to_owned(),
                        type_id: store_type,
                    },
                ],
            },
        ))
    }

    fn make_region(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let type_id = self.region_type(store.type_id)?;
        Ok(self.operation(
            "product.make",
            type_id,
            vec![end.id, start.id, store.id],
            span,
            None,
        ))
    }

    fn lower_region(
        &mut self,
        value: &Value,
        span: crate::ast::Span,
    ) -> Result<(RuntimeValue, RuntimeValue, RuntimeValue), Diagnostic> {
        let runtime = self.lower_value(value, span)?;
        let RuntimeType::Product { name, fields } = self.types[runtime.type_id].clone() else {
            return Err(hir_error("Region value is not a private Product."));
        };
        if !name.starts_with("$region:") {
            return Err(hir_error("Region value lost its private runtime representation."));
        }
        let project = |this: &mut Self, field_name: &str| -> Result<RuntimeValue, Diagnostic> {
            let (index, field) = fields
                .iter()
                .enumerate()
                .find(|(_, field)| field.name == field_name)
                .ok_or_else(|| hir_error("Region product lost a field."))?;
            Ok(this.project_field(&runtime, index, field.type_id, span))
        };
        let store = project(self, "store")?;
        let start = project(self, "start")?;
        let end = project(self, "end")?;
        Ok((store, start, end))
    }

    fn private_store_copy(
        &mut self,
        store: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region claim copy source is not a Store."));
        };
        let integer = self.region_integer_type();
        let length = self.operation("store.length", integer, vec![store.id], span, None);
        let zero = self.constant(
            WireConstant::SignedInteger64("0".to_owned()),
            integer,
            span,
        );
        let empty = self.operation(
            "scalar",
            1,
            vec![length.id, zero.id],
            span,
            Some("equal"),
        );
        let branches = self.begin_conditional(&empty, span)?;

        self.current_block = branches.consequent;
        let empty_store = RuntimeValue {
            meaning: RuntimeMeaning::Plain,
            ..store.clone()
        };
        let empty_end = self.current_block;

        self.current_block = branches.alternate;
        let first = self.operation(
            "store.read",
            element_type,
            vec![store.id, zero.id],
            span,
            None,
        );
        // Persistent self-write is the existing copy-before-write operation.
        let copied = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, zero.id, first.id],
            span,
            Some("persistent"),
        );
        let copied_end = self.current_block;
        Ok(self.join_runtime_values(
            &branches,
            empty_end,
            empty_store,
            copied_end,
            copied,
            span,
        ))
    }

    fn region_index_in_bounds(
        &mut self,
        index: &RuntimeValue,
        start: &RuntimeValue,
        end: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let integer = self.region_integer_type();
        let length = self.operation(
            "scalar",
            integer,
            vec![end.id, start.id],
            span,
            Some("subtract"),
        );
        let zero = self.constant(
            WireConstant::SignedInteger64("0".to_owned()),
            integer,
            span,
        );
        let negative = self.operation(
            "scalar",
            1,
            vec![index.id, zero.id],
            span,
            Some("less-than"),
        );
        let branches = self.begin_conditional(&negative, span)?;
        self.current_block = branches.consequent;
        let no = self.constant(WireConstant::Boolean(false), 1, span);
        let no_end = self.current_block;
        self.current_block = branches.alternate;
        let yes_or_no = self.operation(
            "scalar",
            1,
            vec![index.id, length.id],
            span,
            Some("less-than"),
        );
        let compare_end = self.current_block;
        Ok(self.join_runtime_values(
            &branches,
            no_end,
            no,
            compare_end,
            yes_or_no,
            span,
        ))
    }

    fn boolean_and(
        &mut self,
        left: &RuntimeValue,
        right: &RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let branches = self.begin_conditional(left, span)?;
        self.current_block = branches.consequent;
        let yes = right.clone();
        let yes_end = self.current_block;
        self.current_block = branches.alternate;
        let no = self.constant(WireConstant::Boolean(false), 1, span);
        let no_end = self.current_block;
        Ok(self.join_runtime_values(&branches, yes_end, yes, no_end, no, span))
    }

    fn region_get(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        index: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region Store projection lost its Store type."));
        };
        let cases = vec!["Some".to_owned(), "None".to_owned()];
        let sum_type = self.sum_type(&cases, &[element_type, 0]);
        let in_bounds = self.region_index_in_bounds(&index, &start, &end, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, index.id],
            span,
            Some("add"),
        );
        let value = self.operation(
            "store.read",
            element_type,
            vec![store.id, absolute.id],
            span,
            None,
        );
        let some = self.operation_with_case("sum.make", sum_type, vec![value.id], span, 0);
        let some_end = self.current_block;

        self.current_block = branches.alternate;
        let unit = self.constant(WireConstant::Unit, 0, span);
        let none = self.operation_with_case("sum.make", sum_type, vec![unit.id], span, 1);
        let none_end = self.current_block;

        let mut result = self.join_runtime_values(
            &branches,
            some_end,
            some,
            none_end,
            none,
            span,
        );
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn region_set(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        index: RuntimeValue,
        value: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let region_type = self.region_type(store.type_id)?;
        let cases = vec!["Updated".to_owned(), "SetOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[region_type, region_type]);
        let in_bounds = self.region_index_in_bounds(&index, &start, &end, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, index.id],
            span,
            Some("add"),
        );
        let updated_store = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, absolute.id, value.id],
            span,
            Some("owned-reuse"),
        );
        let updated_region = self.make_region(updated_store, start.clone(), end.clone(), span)?;
        let updated = self.operation_with_case(
            "sum.make",
            sum_type,
            vec![updated_region.id],
            span,
            0,
        );
        let updated_end = self.current_block;

        self.current_block = branches.alternate;
        let original = self.make_region(store, start, end, span)?;
        let failed = self.operation_with_case(
            "sum.make",
            sum_type,
            vec![original.id],
            span,
            1,
        );
        let failed_end = self.current_block;

        let mut result = self.join_runtime_values(
            &branches,
            updated_end,
            updated,
            failed_end,
            failed,
            span,
        );
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn region_swap(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        left: RuntimeValue,
        right: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let RuntimeType::Store { element_type } = self.types[store.type_id] else {
            return Err(hir_error("Region Store projection lost its Store type."));
        };
        let region_type = self.region_type(store.type_id)?;
        let cases = vec!["Updated".to_owned(), "SwapOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[region_type, region_type]);
        let left_ok = self.region_index_in_bounds(&left, &start, &end, span)?;
        let right_ok = self.region_index_in_bounds(&right, &start, &end, span)?;
        let in_bounds = self.boolean_and(&left_ok, &right_ok, span)?;
        let branches = self.begin_conditional(&in_bounds, span)?;

        self.current_block = branches.consequent;
        let integer = self.region_integer_type();
        let left_absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, left.id],
            span,
            Some("add"),
        );
        let right_absolute = self.operation(
            "scalar",
            integer,
            vec![start.id, right.id],
            span,
            Some("add"),
        );
        let left_value = self.operation(
            "store.read",
            element_type,
            vec![store.id, left_absolute.id],
            span,
            None,
        );
        let right_value = self.operation(
            "store.read",
            element_type,
            vec![store.id, right_absolute.id],
            span,
            None,
        );
        let first = self.array_operation(
            "store.write",
            store.type_id,
            vec![store.id, left_absolute.id, right_value.id],
            span,
            Some("owned-reuse"),
        );
        let second = self.array_operation(
            "store.write",
            store.type_id,
            vec![first.id, right_absolute.id, left_value.id],
            span,
            Some("owned-reuse"),
        );
        let updated_region = self.make_region(second, start.clone(), end.clone(), span)?;
        let updated = self.operation_with_case(
            "sum.make",
            sum_type,
            vec![updated_region.id],
            span,
            0,
        );
        let updated_end = self.current_block;

        self.current_block = branches.alternate;
        let original = self.make_region(store, start, end, span)?;
        let failed = self.operation_with_case(
            "sum.make",
            sum_type,
            vec![original.id],
            span,
            1,
        );
        let failed_end = self.current_block;

        let mut result = self.join_runtime_values(
            &branches,
            updated_end,
            updated,
            failed_end,
            failed,
            span,
        );
        result.meaning = RuntimeMeaning::Sum { cases };
        Ok(result)
    }

    fn split_region(
        &mut self,
        store: RuntimeValue,
        start: RuntimeValue,
        end: RuntimeValue,
        offset: RuntimeValue,
        span: crate::ast::Span,
    ) -> Result<RuntimeValue, Diagnostic> {
        let region_type = self.region_type(store.type_id)?;
        let pair_type = self.insert_product_type(vec![
            RuntimeField {
                name: "0".to_owned(),
                type_id: region_type,
            },
            RuntimeField {
                name: "1".to_owned(),
                type_id: region_type,
            },
        ]);
        let cases = vec!["Split".to_owned(), "SplitOutOfBounds".to_owned()];
        let sum_type = self.sum_type(&cases, &[pair_type, region_type]);
        let meaning = RuntimeMeaning::Sum { cases: cases.clone() };

        let failure = |this: &mut Self| -> Result<RuntimeValue, Diagnostic> {
            let original = this.make_region(store.clone(), start.clone(), end.clone(), span)?;
            let mut tagged = this.operation_with_case(
                "sum.make",
                sum_type,
                vec![original.id],
                span,
                1,
            );
            tagged.meaning = meaning.clone();
            Ok(tagged)
        };

        let integer = self.region_integer_type();
        let zero = self.constant(
            WireConstant::SignedInteger64("0".to_owned()),
            integer,
            span,
        );
        let negative = self.operation(
            "scalar",
            1,
            vec![offset.id, zero.id],
            span,
            Some("less-than"),
        );
        let outer = self.begin_conditional(&negative, span)?;

        self.current_block = outer.consequent;
        let negative_value = failure(self)?;
        let negative_end = self.current_block;

        self.current_block = outer.alternate;
        let length = self.operation(
            "scalar",
            integer,
            vec![end.id, start.id],
            span,
            Some("subtract"),
        );
        let too_high = self.operation(
            "scalar",
            1,
            vec![length.id, offset.id],
            span,
            Some("less-than"),
        );
        let inner = self.begin_conditional(&too_high, span)?;

        self.current_block = inner.consequent;
        let high_value = failure(self)?;
        let high_end = self.current_block;

        self.current_block = inner.alternate;
        let middle = self.operation(
            "scalar",
            integer,
            vec![start.id, offset.id],
            span,
            Some("add"),
        );
        let left = self.make_region(store.clone(), start.clone(), middle.clone(), span)?;
        let right = self.make_region(store.clone(), middle, end.clone(), span)?;
        let pair = self.operation(
            "product.make",
            pair_type,
            vec![left.id, right.id],
            span,
            None,
        );
        let mut success = self.operation_with_case(
            "sum.make",
            sum_type,
            vec![pair.id],
            span,
            0,
        );
        success.meaning = meaning.clone();
        let success_end = self.current_block;

        let bounded = self.join_runtime_values(
            &inner,
            high_end,
            high_value,
            success_end,
            success,
            span,
        );
        let bounded_end = self.current_block;
        let mut joined = self.join_runtime_values(
            &outer,
            negative_end,
            negative_value,
            bounded_end,
            bounded,
            span,
        );
        joined.meaning = meaning;
        Ok(joined)
    }

'''
write(path, content[:helper_start] + helpers + content[helper_end:])

# ---------------------------------------------------------------------------
# Prelude Slice namespace. All failure forms preserve the Region authority.
# ---------------------------------------------------------------------------
path = "src/prelude/prelude.blot"
replace_once(
    path,
    '''const Arena =\n''',
    '''const Slice =\n  {\n    .of = @region.array.type;\n    .claim = fn values => @region.array.claim values;\n    .length = fn &region => @region.array.length (&region);\n    .get = fn (&region, index) => @region.array.get (&region) index;\n    .set = fn (!region, index, value) =>\n      @region.array.set (!region) index value\n    ;\n    .swap = fn (!region, left, right) =>\n      @region.array.swap (!region) left right\n    ;\n    .split = fn (!region, index) => @region.array.split (!region) index;\n    .join = fn (!left, !right) => @region.array.join (!left) (!right);\n    .freeze = fn !region => @region.array.freeze (!region);\n  }\n\nconst Arena =\n''',
)
replace_once(
    path,
    '''  .Array = Array;\n  .Arena = Arena;\n''',
    '''  .Array = Array;\n  .Slice = Slice;\n  .Arena = Arena;\n''',
)

# ---------------------------------------------------------------------------
# Update the source-surface evaluator test for total set/swap results.
# ---------------------------------------------------------------------------
path = "experiments/owned-regions/source_surface.test.ts"
content = text(path)
content = content.replace(
    '''let changed = @region.array.swap (!region) 0 2\nreturn @region.array.freeze (!changed)\n''',
    '''let changed = case @region.array.swap (!region) 0 2 of\n  #Updated !updated => updated\n  #SwapOutOfBounds !original => original\nreturn @region.array.freeze (!changed)\n''',
)
write(path, content)

print("applied final production Region patch")
