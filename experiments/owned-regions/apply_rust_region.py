from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))

# --- Rust value domain -------------------------------------------------------
path = "experiments/rust-middle/src/value.rs"
replace_once(
    path,
    '''    Array(Vec<Value>),
    EmptyArray {
''',
    '''    Array(Vec<Value>),
    /// Private type value produced only by `@region.array.type`.
    RegionType(Box<Value>),
    /// Mutable interval into one evaluator Store. Split clones only this
    /// metadata and the `Rc`; elements stay in one backing allocation.
    Region {
        store: Rc<RefCell<Vec<Value>>>,
        start: usize,
        end: usize,
    },
    EmptyArray {
''',
)
replace_once(
    path,
    '''        (Value::Array(left), Value::Array(right)) | (Value::Union(left), Value::Union(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equal(left, right))
        }
''',
    '''        (Value::Array(left), Value::Array(right)) | (Value::Union(left), Value::Union(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equal(left, right))
        }
        (Value::RegionType(left), Value::RegionType(right)) => equal(left, right),
        (
            Value::Region {
                store: left_store,
                start: left_start,
                end: left_end,
            },
            Value::Region {
                store: right_store,
                start: right_start,
                end: right_end,
            },
        ) => Rc::ptr_eq(left_store, right_store)
            && left_start == right_start
            && left_end == right_end,
''',
)
replace_once(
    path,
    '''        Value::Array(elements) => format!(
            "[{}]",
            elements.iter().map(show).collect::<Vec<_>>().join(", ")
        ),
        Value::EmptyArray { .. } => "[]".to_owned(),
''',
    '''        Value::Array(elements) => format!(
            "[{}]",
            elements.iter().map(show).collect::<Vec<_>>().join(", ")
        ),
        Value::RegionType(element) => format!("Region {}", show(element)),
        Value::Region { start, end, .. } => format!("<region {start}..{end}>"),
        Value::EmptyArray { .. } => "[]".to_owned(),
''',
)

# --- primitive evaluator ----------------------------------------------------
path = "experiments/rust-middle/src/primitives.rs"
replace_once(
    path,
    '''        | "@array.len"
        | "@array.indexed"
''',
    '''        | "@array.len"
        | "@array.indexed"
        | "@region.array.type"
        | "@region.array.claim"
        | "@region.array.length"
        | "@region.array.freeze"
''',
)
replace_once(
    path,
    '''        | "@shape.has" | "@array.get" | "@array.push" | "@array.take" | "@array.split"
''',
    '''        | "@shape.has" | "@array.get" | "@array.push" | "@array.take" | "@array.split"
        | "@region.array.get" | "@region.array.split" | "@region.array.join"
''',
)
replace_once(
    path,
    '''        "@type.attach" | "@shape.set" | "@array.set" | "@f32x4.select" => 3,
''',
    '''        "@type.attach" | "@shape.set" | "@array.set" | "@region.array.set"
        | "@region.array.swap" | "@f32x4.select" => 3,
''',
)
region_cases = r'''        "@region.array.type" => Ok(Value::RegionType(Box::new(arguments[0].clone()))),
        "@region.array.claim" => {
            let values = array(&arguments[0], span, name)?.to_vec();
            let length = values.len();
            Ok(Value::Region {
                store: std::rc::Rc::new(std::cell::RefCell::new(values)),
                start: 0,
                end: length,
            })
        }
        "@region.array.length" => {
            let (_, start, end) = region(&arguments[0], span, name)?;
            Ok(Value::Int(BigInt::from(end - start)))
        }
        "@region.array.get" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let relative = index(&arguments[1], span, name)?;
            if relative >= end - start {
                return Err(out_of_bounds(relative, end - start, span));
            }
            let value = store.borrow()[start + relative].clone();
            Ok(value)
        }
        "@region.array.set" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let relative = index(&arguments[1], span, name)?;
            if relative >= end - start {
                return Err(out_of_bounds(relative, end - start, span));
            }
            store.borrow_mut()[start + relative] = arguments[2].clone();
            Ok(arguments[0].clone())
        }
        "@region.array.swap" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let left = index(&arguments[1], span, name)?;
            let right = index(&arguments[2], span, name)?;
            let length = end - start;
            if left >= length {
                return Err(out_of_bounds(left, length, span));
            }
            if right >= length {
                return Err(out_of_bounds(right, length, span));
            }
            store.borrow_mut().swap(start + left, start + right);
            Ok(arguments[0].clone())
        }
        "@region.array.split" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let offset = index(&arguments[1], span, name)?;
            if offset > end - start {
                return Ok(Value::Tag {
                    name: "SplitOutOfBounds".to_owned(),
                    payload: Some(Box::new(arguments[0].clone())),
                });
            }
            let middle = start + offset;
            Ok(Value::Tag {
                name: "Split".to_owned(),
                payload: Some(Box::new(tuple(vec![
                    Value::Region {
                        store: store.clone(),
                        start,
                        end: middle,
                    },
                    Value::Region {
                        store,
                        start: middle,
                        end,
                    },
                ]))),
            })
        }
        "@region.array.join" => {
            let (left_store, left_start, left_end) = region(&arguments[0], span, name)?;
            let (right_store, right_start, right_end) = region(&arguments[1], span, name)?;
            if !std::rc::Rc::ptr_eq(&left_store, &right_store) || left_end != right_start {
                return Err(Diagnostic::new(
                    "BLOT_REGION_JOIN_UNPROVED",
                    "Region join requires ordered adjacent siblings from one Store.",
                    span,
                ));
            }
            Ok(Value::Region {
                store: left_store,
                start: left_start,
                end: right_end,
            })
        }
        "@region.array.freeze" => {
            let (store, start, end) = region(&arguments[0], span, name)?;
            let values = store.borrow();
            if start != 0 || end != values.len() {
                return Err(Diagnostic::new(
                    "BLOT_REGION_PARTIAL_FREEZE",
                    "Only a complete root Region can be frozen.",
                    span,
                ));
            }
            Ok(Value::Array(values.clone()))
        }
'''
replace_once(
    path,
    '''        "@array.len" => Ok(Value::Int(BigInt::from(
            array(&arguments[0], span, name)?.len(),
        ))),
''',
    region_cases + '''        "@array.len" => Ok(Value::Int(BigInt::from(
            array(&arguments[0], span, name)?.len(),
        ))),
''',
)
replace_once(
    path,
    '''fn vector(value: &Value, span: Span, what: &str) -> Result<[f32; 4], Diagnostic> {
''',
    '''fn region(
    value: &Value,
    span: Span,
    what: &str,
) -> Result<(std::rc::Rc<std::cell::RefCell<Vec<Value>>>, usize, usize), Diagnostic> {
    match value {
        Value::Region { store, start, end } => Ok((store.clone(), *start, *end)),
        _ => Err(type_error(what, "an owned Region", value, span)),
    }
}

fn vector(value: &Value, span: Span, what: &str) -> Result<[f32; 4], Diagnostic> {
''',
)

# --- Rust checker -----------------------------------------------------------
path = "experiments/rust-middle/src/typecheck.rs"
replace_once(path, '''    Array(Box<Type>),
    Variant {
''', '''    Array(Box<Type>),
    Region(Box<Type>),
    Variant {
''')
replace_once(path, '''    Array(ConstraintTypeId),
    Variant {
''', '''    Array(ConstraintTypeId),
    Region(ConstraintTypeId),
    Variant {
''')
replace_once(
    path,
    '''            Type::Array(element) => ConstraintTypeNode::Array(self.intern(element)),
''',
    '''            Type::Array(element) => ConstraintTypeNode::Array(self.intern(element)),
            Type::Region(element) => ConstraintTypeNode::Region(self.intern(element)),
''',
)
replace_once(
    path,
    '''            ConstraintTypeNode::Array(element) => Type::Array(Box::new(self.expand(*element))),
''',
    '''            ConstraintTypeNode::Array(element) => Type::Array(Box::new(self.expand(*element))),
            ConstraintTypeNode::Region(element) => Type::Region(Box::new(self.expand(*element))),
''',
)
replace_once(
    path,
    '''            ConstraintTypeNode::Array(element) => self.level_of(*element, variables),
''',
    '''            ConstraintTypeNode::Array(element) | ConstraintTypeNode::Region(element) => {
                self.level_of(*element, variables)
            }
''',
)
replace_once(
    path,
    '''            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right)) => {
                self.same_with_rigids(*left, *right, rigids)
            }
''',
    '''            (ConstraintTypeNode::Array(left), ConstraintTypeNode::Array(right))
            | (ConstraintTypeNode::Region(left), ConstraintTypeNode::Region(right)) => {
                self.same_with_rigids(*left, *right, rigids)
            }
''',
)
# The public same-type relation mirrors the arena relation.
replace_once(
    path,
    '''        (Type::Array(left), Type::Array(right)) => same_type_with_rigids(left, right, rigids),
''',
    '''        (Type::Array(left), Type::Array(right))
        | (Type::Region(left), Type::Region(right)) => same_type_with_rigids(left, right, rigids),
''',
)
# Runtime/comptime bridge values.
replace_once(
    path,
    '''            Value::Array(elements) => Type::Array(Box::new(join_types(
''',
    '''            Value::RegionType(element) => Type::Region(Box::new(self.bridge_runtime_value(element))),
            Value::Region { store, start, end } => Type::Region(Box::new(join_types(
                store.borrow()[*start..*end]
                    .iter()
                    .map(|value| self.bridge_runtime_value(value))
                    .collect(),
            ))),
            Value::Array(elements) => Type::Array(Box::new(join_types(
''',
)
replace_once(
    path,
    '''            Value::Array(elements) => Some(Type::Array(Box::new(union_types(
''',
    '''            Value::RegionType(element) => Some(Type::Region(Box::new(self.bridge(element)?))),
            Value::Region { store, start, end } => Some(Type::Region(Box::new(union_types(
                store.borrow()[*start..*end]
                    .iter()
                    .filter_map(|value| self.bridge(value))
                    .collect(),
            )))),
            Value::Array(elements) => Some(Type::Array(Box::new(union_types(
''',
)
replace_once(
    path,
    '''            Type::Array(element) => format!("[{}]", self.show(&element)),
''',
    '''            Type::Array(element) => format!("[{}]", self.show(&element)),
            Type::Region(element) => format!("Region {}", self.show(&element)),
''',
)
# Do not expose Region through type reflection/reification.
replace_once(
    path,
    '''        Type::Array(element) => Some(Value::Array(vec![reify_type_with_holes(
            element, next_hole,
        )?])),
''',
    '''        Type::Array(element) => Some(Value::Array(vec![reify_type_with_holes(
            element, next_hole,
        )?])),
        Type::Region(_) => None,
''',
)
# Primitive schemes.
primitive_anchor = '''        "@array.empty" => Type::Array(Box::new(checker.fresh())),
'''
region_types = '''        "@region.array.type" => curried(vec![Type::Opaque("Type".to_owned())], Type::Opaque("Type".to_owned())),
        "@region.array.claim" => {
            let element = checker.fresh();
            curried(vec![Type::Array(Box::new(element.clone()))], Type::Region(Box::new(element)))
        }
        "@region.array.length" => curried(vec![Type::Region(Box::new(checker.fresh()))], int.clone()),
        "@region.array.get" => {
            let element = checker.fresh();
            curried(vec![Type::Region(Box::new(element.clone())), int.clone()], element)
        }
        "@region.array.set" => {
            let element = checker.fresh();
            let region = Type::Region(Box::new(element.clone()));
            curried(vec![region.clone(), int.clone(), element], region)
        }
        "@region.array.swap" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(vec![region.clone(), int.clone(), int.clone()], region)
        }
        "@region.array.split" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(
                vec![region.clone(), int.clone()],
                Type::Variant {
                    cases: vec![
                        ("Split".to_owned(), Type::Record(vec![
                            ("0".to_owned(), region.clone()),
                            ("1".to_owned(), region.clone()),
                        ])),
                        ("SplitOutOfBounds".to_owned(), region),
                    ],
                    open: false,
                },
            )
        }
        "@region.array.join" => {
            let region = Type::Region(Box::new(checker.fresh()));
            curried(vec![region.clone(), region.clone()], region)
        }
        "@region.array.freeze" => {
            let element = checker.fresh();
            curried(vec![Type::Region(Box::new(element.clone()))], Type::Array(Box::new(element)))
        }
'''
replace_once(path, primitive_anchor, region_types + primitive_anchor)

# Region is invariant in constraints. We add this beside the existing Array rule
# by rewriting the source-level Type relation; any arena-only missing cases are
# left for cargo to enumerate.
replace_once(
    path,
    '''            (Type::Array(left), Type::Array(right)) => {
                self.constrain(*left, *right, span)?;
                Ok(())
            }
''',
    '''            (Type::Array(left), Type::Array(right)) => {
                self.constrain(*left, *right, span)?;
                Ok(())
            }
            (Type::Region(left), Type::Region(right)) => {
                self.constrain((*left).clone(), (*right).clone(), span)?;
                self.constrain(*right, *left, span)?;
                Ok(())
            }
''',
)

print("applied initial Rust Region type/evaluator patch")
