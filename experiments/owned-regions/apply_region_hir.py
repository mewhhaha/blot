from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))

path = "experiments/rust-middle/src/hir.rs"

# Dynamic primitive lowering. Region uses one private Product carrying a Store
# and half-open bounds. Only claim can create a root product.
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
                let length = self.operation("store.length", 4, vec![store.id], span, None);
                let zero = self.constant(WireConstant::SignedInteger64(0), 4, span);
                self.make_region(store, zero, length, span)?
            }
            "@region.array.length" if arguments.len() == 1 => {
                let (_, start, end) = self.lower_region(&arguments[0], span)?;
                self.operation("scalar", 4, vec![end.id, start.id], span, Some("subtract"))
            }
            "@region.array.get" if arguments.len() == 2 => {
                let (store, start, _) = self.lower_region(&arguments[0], span)?;
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let absolute = self.operation(
                    "scalar",
                    4,
                    vec![start.id, index.id],
                    span,
                    Some("add"),
                );
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Region Store projection lost its Store type."));
                };
                self.operation(
                    "store.read",
                    element_type,
                    vec![store.id, absolute.id],
                    span,
                    None,
                )
            }
            "@region.array.set" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let index = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let absolute = self.operation(
                    "scalar",
                    4,
                    vec![start.id, index.id],
                    span,
                    Some("add"),
                );
                let value = self.lower_value(&arguments[2], span)?;
                let updated = self.array_operation(
                    "store.write",
                    store.type_id,
                    vec![store.id, absolute.id, value.id],
                    span,
                    Some("owned-reuse"),
                );
                self.make_region(updated, start, end, span)?
            }
            "@region.array.swap" if arguments.len() == 3 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let left = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                let right = self.lower_as(Some(&arguments[2]), "signed-integer-64", span)?;
                let left = self.operation(
                    "scalar",
                    4,
                    vec![start.id, left.id],
                    span,
                    Some("add"),
                );
                let right = self.operation(
                    "scalar",
                    4,
                    vec![start.id, right.id],
                    span,
                    Some("add"),
                );
                let RuntimeType::Store { element_type } = self.types[store.type_id] else {
                    return Err(hir_error("Region Store projection lost its Store type."));
                };
                let left_value = self.operation(
                    "store.read",
                    element_type,
                    vec![store.id, left.id],
                    span,
                    None,
                );
                let right_value = self.operation(
                    "store.read",
                    element_type,
                    vec![store.id, right.id],
                    span,
                    None,
                );
                let first = self.array_operation(
                    "store.write",
                    store.type_id,
                    vec![store.id, left.id, right_value.id],
                    span,
                    Some("owned-reuse"),
                );
                let second = self.array_operation(
                    "store.write",
                    store.type_id,
                    vec![first.id, right.id, left_value.id],
                    span,
                    Some("owned-reuse"),
                );
                self.make_region(second, start, end, span)?
            }
            "@region.array.split" if arguments.len() == 2 => {
                let (store, start, end) = self.lower_region(&arguments[0], span)?;
                let offset = self.lower_as(Some(&arguments[1]), "signed-integer-64", span)?;
                self.split_region(store, start, end, offset, span)?
            }
            "@region.array.join" if arguments.len() == 2 => {
                let (left_store, left_start, _) = self.lower_region(&arguments[0], span)?;
                let (_, _, right_end) = self.lower_region(&arguments[1], span)?;
                // Static ownership has already proved ordered sibling lineage.
                // Runtime reconstruction therefore needs no pointer comparison.
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
replace_once(
    path,
    '''            "@array.len" if arguments.len() == 1 => {
''',
    region_cases + '''            "@array.len" if arguments.len() == 1 => {
''',
)

# Helpers live beside the existing product/sum helpers.
helpers = r'''    fn region_type(&mut self, store_type: usize) -> Result<usize, Diagnostic> {
        if !matches!(self.types[store_type], RuntimeType::Store { .. }) {
            return Err(hir_error("Region backing type is not a Store."));
        }
        let key = format!("region:{store_type}");
        if let Some(existing) = self.type_ids.get(&key) {
            return Ok(*existing);
        }
        Ok(self.insert_type(
            &key,
            RuntimeType::Product {
                name: format!("$region:{store_type}"),
                fields: vec![
                    RuntimeField {
                        name: "end".to_owned(),
                        type_id: 4,
                    },
                    RuntimeField {
                        name: "start".to_owned(),
                        type_id: 4,
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
        // Region fields are deliberately stored in lexical field order, which
        // is also the runtime Product order used by `region_type` above.
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
        let length = self.operation("store.length", 4, vec![store.id], span, None);
        let zero = self.constant(WireConstant::SignedInteger64(0), 4, span);
        let empty = self.operation(
            "scalar",
            1,
            vec![length.id, zero.id],
            span,
            Some("equal"),
        );
        let branches = self.begin_conditional(&empty, span)?;

        self.current_block = branches.consequent;
        // An empty Region has no writeable cell; sharing the zero-length Store
        // is observationally equivalent to copying it.
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
        // Persistent `store.write` already implements copy-before-write. Writing
        // the same first element therefore privatizes the Store without changing
        // its source-visible value.
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

        let zero = self.constant(WireConstant::SignedInteger64(0), 4, span);
        let negative = self.operation(
            "scalar",
            1,
            vec![offset.id, zero.id],
            span,
            Some("less-than-signed"),
        );
        let outer = self.begin_conditional(&negative, span)?;

        self.current_block = outer.consequent;
        let negative_value = failure(self)?;
        let negative_end = self.current_block;

        self.current_block = outer.alternate;
        let length = self.operation(
            "scalar",
            4,
            vec![end.id, start.id],
            span,
            Some("subtract"),
        );
        let too_high = self.operation(
            "scalar",
            1,
            vec![length.id, offset.id],
            span,
            Some("less-than-signed"),
        );
        let inner = self.begin_conditional(&too_high, span)?;

        self.current_block = inner.consequent;
        let high_value = failure(self)?;
        let high_end = self.current_block;

        self.current_block = inner.alternate;
        let middle = self.operation(
            "scalar",
            4,
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
replace_once(path, '''    fn product_type(&mut self, fields: &OrderedFields) -> Result<usize, Diagnostic> {
''', helpers + '''    fn product_type(&mut self, fields: &OrderedFields) -> Result<usize, Diagnostic> {
''')

# Opaque Region products stay capabilities instead of being projected back into
# a source Shape when passed through residual functions.
replace_once(
    path,
    '''        let RuntimeType::Product { fields, .. } = self.types[value.type_id].clone() else {
            return Ok(Value::Runtime(value));
        };
''',
    '''        let RuntimeType::Product { name, fields } = self.types[value.type_id].clone() else {
            return Ok(Value::Runtime(value));
        };
        if name.starts_with("$region:") {
            return Ok(Value::Runtime(value));
        }
''',
)

# Region is a private product in settled runtime signatures.
replace_once(
    path,
    '''            Type::Array(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
''',
    '''            Type::Array(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Type::Region(element) => {
                let element_type = self.runtime_type_from_checked_type(element)?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                self.region_type(store_type)
            }
''',
)

# Specialized type values produced by signatures use the same representation.
replace_once(
    path,
    '''            Value::Array(elements) => {
                let element = elements
                    .first()
                    .ok_or_else(|| hir_error("A residual array type omitted its element type."))?;
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
''',
    '''            Value::Array(elements) => {
                let element = elements
                    .first()
                    .ok_or_else(|| hir_error("A residual array type omitted its element type."))?;
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                Ok(self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                ))
            }
            Value::RegionType(element) => {
                let element_type = self.specialized_type_from_type_value(
                    element,
                    substitutions,
                    representation_facts,
                )?;
                let store_type = self.insert_type(
                    &format!("store:{element_type}"),
                    RuntimeType::Store { element_type },
                );
                self.region_type(store_type)
            }
''',
)

# Representation/freshness walkers know the private type constructor.
replace_once(
    path,
    '''        Value::Array(elements) | Value::Union(elements) => elements
            .iter()
            .any(|element| has_unresolved_representation(element, substitutions)),
''',
    '''        Value::Array(elements) | Value::Union(elements) => elements
            .iter()
            .any(|element| has_unresolved_representation(element, substitutions)),
        Value::RegionType(element) => has_unresolved_representation(element, substitutions),
''',
)
replace_once(
    path,
    '''        Value::Runtime(_) | Value::ClosureChoice { .. } => true,
''',
    '''        Value::Runtime(_) | Value::ClosureChoice { .. } => true,
        Value::Region { store, start, end } => store.borrow()[*start..*end]
            .iter()
            .any(contains_runtime),
        Value::RegionType(element) => contains_runtime(element),
''',
)

# Private Region product is never a public ABI record even if a future path
# accidentally reaches canonicalization.
path = "experiments/rust-middle/src/backend.rs"
replace_once(
    path,
    '''        RuntimeType::Product { fields, .. } => {
            let mut fields = fields.clone();
''',
    '''        RuntimeType::Product { name, .. } if name.starts_with("$region:") => {
            return Err(format!(
                "{}: live Region type {type_id} cannot cross Blot Core Wasm ABI 1",
                module.source
            ));
        }
        RuntimeType::Product { fields, .. } => {
            let mut fields = fields.clone();
''',
)

print("applied Region Runtime HIR/Wasm lowering")
