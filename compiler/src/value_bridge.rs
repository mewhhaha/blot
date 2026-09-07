//! Exact compile-time value conversion. An unsupported child refuses the
//! entire conversion; it must not erase array members or invent unit payloads.
use super::*;

pub(super) fn bridge(checker: &Checker, value: &Value) -> Option<Type> {
    Bridge::new(checker).value(value)
}

struct Bridge<'a> {
    checker: &'a Checker,
    // Borrowed source storage stays alive throughout this one conversion.
    // These keys are neither semantic identities nor persistent cache entries.
    records: HashMap<*const (), Type>,
    #[cfg(test)]
    visits: usize,
}

impl<'a> Bridge<'a> {
    fn new(checker: &'a Checker) -> Self {
        Self {
            checker,
            records: HashMap::new(),
            #[cfg(test)]
            visits: 0,
        }
    }

    fn value(&mut self, value: &Value) -> Option<Type> {
        #[cfg(test)]
        {
            self.visits += 1;
        }
        match value {
            Value::Int(value) => Some(Type::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(value.clone())),
                high: Some(Scalar::Int(value.clone())),
            }),
            Value::Float(_) => Some(float_type()),
            Value::Float32(_) => Some(float32_type()),
            Value::Text(value) => Some(Type::Range {
                domain: Domain::Text,
                low: Some(Scalar::Text(value.clone())),
                high: Some(Scalar::Text(value.clone())),
            }),
            Value::Unit => Some(Type::Unit),
            Value::Shape(fields) => {
                let identity = fields.storage_identity();
                if let Some(cached) = self.records.get(&identity) {
                    return Some(cached.clone());
                }
                let variables_before = self.checker.variables.borrow().len();
                let result = Type::Record(
                    fields
                        .iter()
                        .map(|(name, value)| Some((name.clone(), self.value(value)?)))
                        .collect::<Option<Vec<_>>>()?
                        .into(),
                );
                // An empty-array carrier allocates a fresh element variable.
                // Reusing such a result would couple independent occurrences.
                if self.checker.variables.borrow().len() == variables_before {
                    self.records.insert(identity, result.clone());
                }
                Some(result)
            }
            Value::RegionType(element) => Some(Type::Region(Rc::new(self.value(element)?))),
            Value::ScratchType(element) => Some(Type::Scratch(Rc::new(self.value(element)?))),
            Value::Scratch { values, .. } => Some(Type::Scratch(Rc::new(join_types(
                values
                    .iter()
                    .map(|value| self.value(value))
                    .collect::<Option<Vec<_>>>()?,
            )))),
            Value::Region { store, start, end } => Some(Type::Region(Rc::new(union_types(
                store.borrow()[*start..*end]
                    .iter()
                    .map(|value| self.value(value))
                    .collect::<Option<Vec<_>>>()?,
            )))),
            Value::RegionRejoin { .. } => Some(Type::Opaque("Rejoin".to_owned())),
            Value::Array(elements) => Some(Type::Array(Rc::new(union_types(
                elements
                    .iter()
                    .map(|value| self.value(value))
                    .collect::<Option<Vec<_>>>()?,
            )))),
            Value::EmptyArray { .. } => Some(Type::Array(Rc::new(
                self.checker.fresh_empty_array_element(),
            ))),
            Value::Tag { name, payload } => Some(Type::Variant {
                cases: vec![(
                    name.clone(),
                    match payload.as_deref() {
                        Some(value) => self.value(value)?,
                        None => Type::Unit,
                    },
                )]
                .into(),
                open: false,
            }),
            Value::Range { low, high, domain } => Some(Type::Range {
                domain: match domain.unwrap_or_else(|| {
                    if matches!(**low, Value::Text(_)) || matches!(**high, Value::Text(_)) {
                        ValueDomain::Text
                    } else {
                        ValueDomain::Int
                    }
                }) {
                    ValueDomain::Int => Domain::Int,
                    ValueDomain::Text => Domain::Text,
                    ValueDomain::Float => Domain::Float,
                    ValueDomain::Float32 => Domain::Float32,
                },
                low: scalar_bound(low),
                high: scalar_bound(high),
            }),
            Value::Union(members) => Some(join_types(
                members
                    .iter()
                    .map(|member| self.value(member))
                    .collect::<Option<Vec<_>>>()?,
            )),
            Value::Unbounded => Some(Type::Top),
            Value::Arrow {
                deferred,
                domain,
                codomain,
                effects,
                effect_tail,
            } => {
                let labels = effects
                    .iter()
                    .filter_map(effect_label)
                    .collect::<BTreeSet<_>>();
                let effects = match effect_tail {
                    Some(tail) => Type::OpenEffects {
                        labels,
                        tail: Rc::new(Type::Rigid(*tail)),
                    },
                    None => Type::Effects(labels),
                };
                Some(Type::Function {
                    deferred: *deferred,
                    parameter: Rc::new(self.value(domain)?),
                    effects: Rc::new(effects),
                    result: Rc::new(self.value(codomain)?),
                })
            }
            Value::Forall { variable, body } => Some(Type::Forall {
                variables: vec![*variable],
                body: Rc::new(self.value(body)?),
            }),
            Value::Effect { id, name, .. } => Some(Type::Opaque(format!("Effect:{id}:{name}"))),
            Value::Extended { inner, .. } => self.value(inner),
            Value::Sealed { name, inner } => sealed_type(name, &self.value(inner)?),
            Value::OpaqueType(name) => Some(Type::Opaque(name.clone())),
            Value::Vector(_) => Some(Type::Opaque("F32x4".to_owned())),
            Value::VectorMask(_) => Some(Type::Opaque("F32x4Mask".to_owned())),
            Value::IntegerVector { bits, lanes } => {
                Some(Type::Opaque(format!("I{bits}x{}", lanes.len())))
            }
            Value::IntegerVectorMask { bits, lanes } => {
                Some(Type::Opaque(format!("I{bits}x{}Mask", lanes.len())))
            }
            Value::TypeVariable(id) => Some(Type::Rigid(*id)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsupported() -> Value {
        Value::Primitive {
            name: "@int.add".to_owned(),
            arity: 2,
            applied: Vec::new(),
        }
    }

    #[test]
    fn unsupported_children_refuse_the_whole_exact_conversion() {
        let checker = Checker::new(Rc::new(Context::default()));
        for value in [
            Value::Array(vec![Value::Int(1.into()), unsupported()].into()),
            Value::Union(vec![Value::Int(1.into()), unsupported()].into()),
            Value::Tag {
                name: "Some".to_owned(),
                payload: Some(Box::new(unsupported())),
            },
            Value::Region {
                store: Rc::new(RefCell::new(vec![Value::Int(1.into()), unsupported()])),
                start: 0,
                end: 2,
            },
            Value::Shape(crate::value::OrderedFields::from([
                ("valid".to_owned(), Value::Int(1.into())),
                (
                    "invalid".to_owned(),
                    Value::Array(vec![unsupported()].into()),
                ),
            ])),
        ] {
            assert!(bridge(&checker, &value).is_none());
        }
    }

    #[test]
    fn absent_tag_payloads_still_mean_unit() {
        let checker = Checker::new(Rc::new(Context::default()));
        for payload in [None, Some(Box::new(Value::Unit))] {
            let value = Value::Tag {
                name: "Empty".to_owned(),
                payload,
            };
            let Some(Type::Variant { cases, open: false }) = bridge(&checker, &value) else {
                panic!("unit constructor must bridge")
            };
            assert!(matches!(cases.get("Empty"), Some(Type::Unit)));
        }
    }

    #[test]
    fn shared_record_diamonds_keep_graph_size_and_linear_bridge_work() {
        let checker = Checker::new(Rc::new(Context::default()));
        let depth = 30;
        let mut value = Value::Int(1.into());
        for _ in 0..depth {
            value = Value::Shape(crate::value::OrderedFields::from([
                ("left".to_owned(), value.clone()),
                ("right".to_owned(), value),
            ]));
        }
        let mut conversion = Bridge::new(&checker);
        let Type::Record(fields) = conversion.value(&value).unwrap() else {
            panic!("record structure was lost")
        };
        assert_eq!(conversion.records.len(), depth);
        assert_eq!(conversion.visits, 2 * depth + 1);
        let (Some(Type::Record(left)), Some(Type::Record(right))) =
            (fields.get("left"), fields.get("right"))
        else {
            panic!("nested record structure was lost")
        };
        assert!(left.ptr_eq(right));
    }

    #[test]
    fn empty_array_elements_are_fresh_even_below_shared_records() {
        let checker = Checker::new(Rc::new(Context::default()));
        let shared = Value::Shape(crate::value::OrderedFields::from([(
            "item".to_owned(),
            Value::EmptyArray {
                element: Box::new(Value::Int(1.into())),
            },
        )]));
        let value = Value::Shape(crate::value::OrderedFields::from([
            ("first".to_owned(), shared.clone()),
            ("second".to_owned(), shared),
        ]));
        let before = checker.variables.borrow().len();
        let mut conversion = Bridge::new(&checker);
        assert!(conversion.value(&value).is_some());
        assert_eq!(checker.variables.borrow().len() - before, 2);
        assert!(conversion.records.is_empty());
    }
}
