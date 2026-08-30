use std::collections::HashMap;
use std::rc::Rc;

use crate::qcore::{ValidatedQModule, validate_grade_interval};
use crate::qcore_generated::{
    Computation, ComputationId, DefinitionBody, DefinitionKey, EffectRow, EffectRowId, GradeId,
    GradeInterval, GradeUpperBound, QModule, SemanticKey, Universe, Value, ValueId, ValueTag,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QCoreTypingNode {
    Definition(DefinitionKey),
    Value(ValueId),
    Computation(ComputationId),
    EffectRow(EffectRowId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UnsupportedPureFeature {
    ImportedDefinitionType(DefinitionKey),
    ComputationDefinitionAsValue(DefinitionKey),
    EffectRowVariable,
    EffectOperation,
    EffectHandler,
    Thunk,
    Force,
    ProofWitness,
    StructuralCertificate(ValueTag),
    EffectRowValue,
    IntervalGradeValue,
    DependentBindResult,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QCoreTypingError {
    Unsupported {
        node: QCoreTypingNode,
        feature: UnsupportedPureFeature,
    },
    UniverseLevelOverflow {
        value: ValueId,
        level: u32,
    },
    ExpectedType {
        value: ValueId,
        inferred: String,
    },
    CannotInferValue {
        value: ValueId,
        form: ValueTag,
    },
    ExpectedFunction {
        computation: ComputationId,
        inferred: String,
    },
    ExpectedPair {
        value: ValueId,
        inferred: String,
    },
    ValueTypeMismatch {
        value: ValueId,
        expected: String,
        inferred: String,
    },
    ComputationTypeMismatch {
        computation: ComputationId,
        expected: String,
        inferred: String,
    },
    GradeViolation {
        value: ValueId,
        grade: GradeId,
        lower: u32,
        upper: GradeUpperBound,
        uses: u64,
    },
    SynthesizedGradeOverflow {
        value: ValueId,
        uses: u64,
    },
    DefinitionKindMismatch {
        left: DefinitionKey,
        right: DefinitionKey,
    },
    UnknownDefinition(DefinitionKey),
    MissingGlobalBoundary(DefinitionKey),
    BindingIndexOverflow {
        node: QCoreTypingNode,
    },
    BindingOutOfScope {
        value: ValueId,
        index: u32,
        depth: usize,
    },
    NormalizationLimitExceeded {
        node: QCoreTypingNode,
        limit: u64,
    },
}

/// Evidence that every definition in a structurally validated module inhabits
/// its declared boundary in the pure QCore fragment.
///
/// This certificate says nothing about structural shadow types, imports,
/// effects, handlers, proof witnesses, erasure, or lowering adequacy. Those
/// forms are rejected before this value can be constructed.
pub struct CheckedPureQModule<'module> {
    module: &'module QModule,
    pure: PureModule,
}

impl CheckedPureQModule<'_> {
    pub fn module(&self) -> &QModule {
        self.module
    }

    pub fn value_definitions_convert(
        &self,
        left: &DefinitionKey,
        right: &DefinitionKey,
    ) -> Result<bool, QCoreTypingError> {
        let left_body = self.pure.definition(left)?;
        let right_body = self.pure.definition(right)?;
        let (
            PureDefinitionBody::Value {
                value: left_value,
                expected_type: left_type,
            },
            PureDefinitionBody::Value {
                value: right_value,
                expected_type: right_type,
            },
        ) = (left_body, right_body)
        else {
            return Err(QCoreTypingError::DefinitionKindMismatch {
                left: left.clone(),
                right: right.clone(),
            });
        };
        if !values_convert(left_type, right_type)? {
            return Ok(false);
        }
        values_convert(left_value, right_value)
    }

    pub fn computation_definitions_convert(
        &self,
        left: &DefinitionKey,
        right: &DefinitionKey,
    ) -> Result<bool, QCoreTypingError> {
        let left_body = self.pure.definition(left)?;
        let right_body = self.pure.definition(right)?;
        let (
            PureDefinitionBody::Computation {
                computation: left_computation,
                result_type: left_type,
            },
            PureDefinitionBody::Computation {
                computation: right_computation,
                result_type: right_type,
            },
        ) = (left_body, right_body)
        else {
            return Err(QCoreTypingError::DefinitionKindMismatch {
                left: left.clone(),
                right: right.clone(),
            });
        };
        if !values_convert(left_type, right_type)? {
            return Ok(false);
        }
        computations_convert(left_computation, right_computation)
    }
}

pub fn check_pure_module<'module>(
    validated: &ValidatedQModule<'module>,
) -> Result<CheckedPureQModule<'module>, QCoreTypingError> {
    let module = validated.module();
    let pure = PureModule::lower(module)?;
    TypeChecker::new(&pure).check()?;
    Ok(CheckedPureQModule { module, pure })
}

#[derive(Clone)]
struct PureValue(Rc<PureValueNode>);

#[derive(Clone)]
struct PureValueNode {
    source: ValueId,
    term: PureValueTerm,
}

#[derive(Clone)]
enum PureValueTerm {
    BoundVariable(u32),
    GlobalDefinition(DefinitionKey, SemanticKey),
    Universe(Universe),
    DependentPi {
        domain: PureValue,
        codomain: PureValue,
        grade: GradeId,
        interval: GradeInterval,
    },
    DependentSigma {
        first: PureValue,
        second: PureValue,
    },
    Lambda(PureComputation),
    Pair(PureValue, PureValue),
    FirstProjection(PureValue),
    SecondProjection(PureValue),
}

#[derive(Clone)]
struct PureComputation(Rc<PureComputationNode>);

#[derive(Clone)]
struct PureComputationNode {
    source: ComputationId,
    term: PureComputationTerm,
}

#[derive(Clone)]
enum PureComputationTerm {
    ReturnValue(PureValue),
    LetValue {
        value: PureValue,
        body: PureComputation,
    },
    Bind {
        first: PureComputation,
        body: PureComputation,
    },
    Apply {
        function: PureValue,
        argument: PureValue,
    },
}

enum PureDefinitionBody {
    Value {
        value: PureValue,
        expected_type: PureValue,
    },
    Computation {
        computation: PureComputation,
        result_type: PureValue,
    },
}

struct PureDefinition {
    key: DefinitionKey,
    body: PureDefinitionBody,
}

struct PureModule {
    definitions: Vec<PureDefinition>,
    definition_indices: HashMap<DefinitionKey, usize>,
    imports: HashMap<DefinitionKey, ()>,
}

impl PureModule {
    fn lower(module: &QModule) -> Result<Self, QCoreTypingError> {
        let mut lowerer = PureLowerer::new(module);
        let mut definitions = Vec::with_capacity(module.definitions.len());
        for definition in &module.definitions {
            let body = match definition.body {
                DefinitionBody::Value {
                    value,
                    expected_type,
                } => PureDefinitionBody::Value {
                    value: lowerer.value(value)?,
                    expected_type: lowerer.value(expected_type)?,
                },
                DefinitionBody::Computation {
                    computation,
                    result_type,
                    effects,
                } => {
                    lowerer.require_empty_effect_row(effects)?;
                    PureDefinitionBody::Computation {
                        computation: lowerer.computation(computation)?,
                        result_type: lowerer.value(result_type)?,
                    }
                }
            };
            definitions.push(PureDefinition {
                key: definition.reference.definition.clone(),
                body,
            });
        }
        let definition_indices = definitions
            .iter()
            .enumerate()
            .map(|(index, definition)| (definition.key.clone(), index))
            .collect();
        let imports = module
            .imports
            .iter()
            .map(|import| (import.definition.clone(), ()))
            .collect();
        Ok(Self {
            definitions,
            definition_indices,
            imports,
        })
    }

    fn definition(&self, key: &DefinitionKey) -> Result<&PureDefinitionBody, QCoreTypingError> {
        let Some(index) = self.definition_indices.get(key) else {
            return Err(QCoreTypingError::UnknownDefinition(key.clone()));
        };
        Ok(&self.definitions[*index].body)
    }
}

struct PureLowerer<'module> {
    module: &'module QModule,
    values: Vec<Option<PureValue>>,
    computations: Vec<Option<PureComputation>>,
}

impl<'module> PureLowerer<'module> {
    fn new(module: &'module QModule) -> Self {
        Self {
            module,
            values: vec![None; module.arena.values.len()],
            computations: vec![None; module.arena.computations.len()],
        }
    }

    fn value(&mut self, id: ValueId) -> Result<PureValue, QCoreTypingError> {
        let index = id.0 as usize;
        if let Some(value) = &self.values[index] {
            return Ok(value.clone());
        }
        let source = self.module.arena.values[index].term.clone();
        let term = match source {
            Value::BoundVariable { index } => PureValueTerm::BoundVariable(index),
            Value::GlobalDefinition {
                definition,
                semantics,
            } => PureValueTerm::GlobalDefinition(definition, semantics),
            Value::Universe { universe } => PureValueTerm::Universe(universe),
            Value::DependentPi {
                domain,
                codomain,
                effects,
                grade,
            } => {
                self.require_empty_effect_row(effects)?;
                let interval = self.module.arena.grades[grade.0 as usize].interval.clone();
                debug_assert!(validate_grade_interval(&interval).is_ok());
                PureValueTerm::DependentPi {
                    domain: self.value(domain)?,
                    codomain: self.value(codomain)?,
                    grade,
                    interval,
                }
            }
            Value::DependentSigma { first, second } => PureValueTerm::DependentSigma {
                first: self.value(first)?,
                second: self.value(second)?,
            },
            Value::Lambda { body } => PureValueTerm::Lambda(self.computation(body)?),
            Value::Pair { first, second } => {
                PureValueTerm::Pair(self.value(first)?, self.value(second)?)
            }
            Value::FirstProjection { pair } => PureValueTerm::FirstProjection(self.value(pair)?),
            Value::SecondProjection { pair } => PureValueTerm::SecondProjection(self.value(pair)?),
            Value::Thunk { .. } => {
                return self.unsupported_value(id, UnsupportedPureFeature::Thunk);
            }
            Value::EffectRow { .. } => {
                return self.unsupported_value(id, UnsupportedPureFeature::EffectRowValue);
            }
            Value::IntervalGrade { .. } => {
                return self.unsupported_value(id, UnsupportedPureFeature::IntervalGradeValue);
            }
            Value::Proof { .. } => {
                return self.unsupported_value(id, UnsupportedPureFeature::ProofWitness);
            }
            structural @ (Value::StructuralRigid { .. }
            | Value::StructuralForall { .. }
            | Value::StructuralRange { .. }
            | Value::StructuralUnit
            | Value::StructuralFunction { .. }
            | Value::StructuralRecord { .. }
            | Value::StructuralRecordUpdate { .. }
            | Value::StructuralArray { .. }
            | Value::StructuralRegion { .. }
            | Value::StructuralScratch { .. }
            | Value::StructuralVariant { .. }
            | Value::StructuralEffects { .. }
            | Value::StructuralOpenEffects { .. }
            | Value::StructuralUnion { .. }
            | Value::StructuralOpaque { .. }
            | Value::StructuralTop
            | Value::StructuralBottom) => {
                return self.unsupported_value(
                    id,
                    UnsupportedPureFeature::StructuralCertificate(structural.tag()),
                );
            }
        };
        let value = PureValue(Rc::new(PureValueNode { source: id, term }));
        self.values[index] = Some(value.clone());
        Ok(value)
    }

    fn computation(&mut self, id: ComputationId) -> Result<PureComputation, QCoreTypingError> {
        let index = id.0 as usize;
        if let Some(computation) = &self.computations[index] {
            return Ok(computation.clone());
        }
        let source = self.module.arena.computations[index].term.clone();
        let term = match source {
            Computation::ReturnValue { value } => {
                PureComputationTerm::ReturnValue(self.value(value)?)
            }
            Computation::LetValue { value, body } => PureComputationTerm::LetValue {
                value: self.value(value)?,
                body: self.computation(body)?,
            },
            Computation::Bind { first, body } => PureComputationTerm::Bind {
                first: self.computation(first)?,
                body: self.computation(body)?,
            },
            Computation::Apply { function, argument } => PureComputationTerm::Apply {
                function: self.value(function)?,
                argument: self.value(argument)?,
            },
            Computation::Force { .. } => {
                return self.unsupported_computation(id, UnsupportedPureFeature::Force);
            }
            Computation::Perform { .. } => {
                return self.unsupported_computation(id, UnsupportedPureFeature::EffectOperation);
            }
            Computation::Handle { .. } => {
                return self.unsupported_computation(id, UnsupportedPureFeature::EffectHandler);
            }
        };
        let computation = PureComputation(Rc::new(PureComputationNode { source: id, term }));
        self.computations[index] = Some(computation.clone());
        Ok(computation)
    }

    fn require_empty_effect_row(&self, id: EffectRowId) -> Result<(), QCoreTypingError> {
        let feature = match self.module.arena.effect_rows[id.0 as usize].row {
            EffectRow::Empty => return Ok(()),
            EffectRow::Variable { .. } => UnsupportedPureFeature::EffectRowVariable,
            EffectRow::Extend { .. } => UnsupportedPureFeature::EffectOperation,
        };
        Err(QCoreTypingError::Unsupported {
            node: QCoreTypingNode::EffectRow(id),
            feature,
        })
    }

    fn unsupported_value<T>(
        &self,
        id: ValueId,
        feature: UnsupportedPureFeature,
    ) -> Result<T, QCoreTypingError> {
        Err(QCoreTypingError::Unsupported {
            node: QCoreTypingNode::Value(id),
            feature,
        })
    }

    fn unsupported_computation<T>(
        &self,
        id: ComputationId,
        feature: UnsupportedPureFeature,
    ) -> Result<T, QCoreTypingError> {
        Err(QCoreTypingError::Unsupported {
            node: QCoreTypingNode::Computation(id),
            feature,
        })
    }
}

enum GlobalBoundary<'module> {
    Value(&'module PureValue),
    Computation,
    Import,
}

#[derive(Clone, Copy)]
enum Sort {
    Prop,
    Type(u32),
}

struct TypeChecker<'module> {
    module: &'module PureModule,
    globals: HashMap<DefinitionKey, GlobalBoundary<'module>>,
}

impl<'module> TypeChecker<'module> {
    fn new(module: &'module PureModule) -> Self {
        let mut globals = HashMap::new();
        for key in module.imports.keys() {
            globals.insert(key.clone(), GlobalBoundary::Import);
        }
        for definition in &module.definitions {
            let boundary = match &definition.body {
                PureDefinitionBody::Value { expected_type, .. } => {
                    GlobalBoundary::Value(expected_type)
                }
                PureDefinitionBody::Computation { .. } => GlobalBoundary::Computation,
            };
            globals.insert(definition.key.clone(), boundary);
        }
        Self { module, globals }
    }

    fn check(&self) -> Result<(), QCoreTypingError> {
        let context = Vec::new();
        for definition in &self.module.definitions {
            match &definition.body {
                PureDefinitionBody::Value {
                    value,
                    expected_type,
                } => {
                    self.infer_sort(&context, expected_type)?;
                    self.check_value(&context, value, expected_type)?;
                }
                PureDefinitionBody::Computation {
                    computation,
                    result_type,
                } => {
                    self.infer_sort(&context, result_type)?;
                    self.check_computation(&context, computation, result_type)?;
                }
            }
        }
        Ok(())
    }

    fn infer_sort(
        &self,
        context: &[PureValue],
        value: &PureValue,
    ) -> Result<Sort, QCoreTypingError> {
        let inferred = normalize_value(&self.infer_value(context, value)?)?;
        match &inferred.0.term {
            PureValueTerm::Universe(Universe::Prop) => Ok(Sort::Prop),
            PureValueTerm::Universe(Universe::TypeUniverse { level }) => Ok(Sort::Type(*level)),
            _ => Err(QCoreTypingError::ExpectedType {
                value: value.0.source,
                inferred: display_value(&inferred),
            }),
        }
    }

    fn infer_value(
        &self,
        context: &[PureValue],
        value: &PureValue,
    ) -> Result<PureValue, QCoreTypingError> {
        match &value.0.term {
            PureValueTerm::BoundVariable(index) => {
                let Some(declared) = context.get(*index as usize) else {
                    return Err(QCoreTypingError::BindingOutOfScope {
                        value: value.0.source,
                        index: *index,
                        depth: context.len(),
                    });
                };
                let amount = next_binding_depth(*index, QCoreTypingNode::Value(value.0.source))?;
                shift_value(declared, amount, 0)
            }
            PureValueTerm::GlobalDefinition(definition, _) => {
                let Some(boundary) = self.globals.get(definition) else {
                    return Err(QCoreTypingError::MissingGlobalBoundary(definition.clone()));
                };
                match boundary {
                    GlobalBoundary::Value(expected_type) => Ok((*expected_type).clone()),
                    GlobalBoundary::Computation => Err(QCoreTypingError::Unsupported {
                        node: QCoreTypingNode::Value(value.0.source),
                        feature: UnsupportedPureFeature::ComputationDefinitionAsValue(
                            definition.clone(),
                        ),
                    }),
                    GlobalBoundary::Import => Err(QCoreTypingError::Unsupported {
                        node: QCoreTypingNode::Value(value.0.source),
                        feature: UnsupportedPureFeature::ImportedDefinitionType(definition.clone()),
                    }),
                }
            }
            PureValueTerm::Universe(Universe::Prop) => Ok(universe(
                value.0.source,
                Universe::TypeUniverse { level: 0 },
            )),
            PureValueTerm::Universe(Universe::TypeUniverse { level }) => {
                let Some(next) = level.checked_add(1) else {
                    return Err(QCoreTypingError::UniverseLevelOverflow {
                        value: value.0.source,
                        level: *level,
                    });
                };
                Ok(universe(
                    value.0.source,
                    Universe::TypeUniverse { level: next },
                ))
            }
            PureValueTerm::DependentPi {
                domain, codomain, ..
            } => {
                let domain_sort = self.infer_sort(context, domain)?;
                let mut extended = context.to_vec();
                extended.insert(0, domain.clone());
                let codomain_sort = self.infer_sort(&extended, codomain)?;
                Ok(universe(
                    value.0.source,
                    pi_universe(domain_sort, codomain_sort),
                ))
            }
            PureValueTerm::DependentSigma { first, second } => {
                let first_sort = self.infer_sort(context, first)?;
                let mut extended = context.to_vec();
                extended.insert(0, first.clone());
                let second_sort = self.infer_sort(&extended, second)?;
                Ok(universe(
                    value.0.source,
                    Universe::TypeUniverse {
                        level: sort_level(first_sort).max(sort_level(second_sort)),
                    },
                ))
            }
            PureValueTerm::Pair(first, second) => {
                let first_type = self.infer_value(context, first)?;
                let second_type = self.infer_value(context, second)?;
                Ok(PureValue(Rc::new(PureValueNode {
                    source: value.0.source,
                    term: PureValueTerm::DependentSigma {
                        first: first_type,
                        second: shift_value(&second_type, 1, 0)?,
                    },
                })))
            }
            PureValueTerm::FirstProjection(pair) => {
                let pair_type = normalize_value(&self.infer_value(context, pair)?)?;
                let PureValueTerm::DependentSigma { first, .. } = &pair_type.0.term else {
                    return Err(QCoreTypingError::ExpectedPair {
                        value: value.0.source,
                        inferred: display_value(&pair_type),
                    });
                };
                Ok(first.clone())
            }
            PureValueTerm::SecondProjection(pair) => {
                let pair_type = normalize_value(&self.infer_value(context, pair)?)?;
                let PureValueTerm::DependentSigma { second, .. } = &pair_type.0.term else {
                    return Err(QCoreTypingError::ExpectedPair {
                        value: value.0.source,
                        inferred: display_value(&pair_type),
                    });
                };
                let first = normalize_value(&PureValue(Rc::new(PureValueNode {
                    source: value.0.source,
                    term: PureValueTerm::FirstProjection(pair.clone()),
                })))?;
                substitute_value_top(second, &first)
            }
            PureValueTerm::Lambda(_) => Err(QCoreTypingError::CannotInferValue {
                value: value.0.source,
                form: ValueTag::Lambda,
            }),
        }
    }

    fn check_value(
        &self,
        context: &[PureValue],
        value: &PureValue,
        expected_type: &PureValue,
    ) -> Result<(), QCoreTypingError> {
        let expected = normalize_value(expected_type)?;
        match (&value.0.term, &expected.0.term) {
            (
                PureValueTerm::Lambda(body),
                PureValueTerm::DependentPi {
                    domain,
                    codomain,
                    grade,
                    interval,
                },
            ) => {
                let uses = count_bound_computation(body, 0)?;
                if !grade_contains(interval, uses) {
                    return Err(QCoreTypingError::GradeViolation {
                        value: value.0.source,
                        grade: *grade,
                        lower: interval.lower,
                        upper: interval.upper.clone(),
                        uses,
                    });
                }
                let mut extended = context.to_vec();
                extended.insert(0, domain.clone());
                self.check_computation(&extended, body, codomain)
            }
            (
                PureValueTerm::Pair(first, second),
                PureValueTerm::DependentSigma {
                    first: first_type,
                    second: second_type,
                },
            ) => {
                self.check_value(context, first, first_type)?;
                let instantiated = substitute_value_top(second_type, first)?;
                self.check_value(context, second, &instantiated)
            }
            _ => {
                let inferred = self.infer_value(context, value)?;
                if values_convert(&inferred, &expected)? {
                    return Ok(());
                }
                Err(QCoreTypingError::ValueTypeMismatch {
                    value: value.0.source,
                    expected: display_value(&normalize_value(&expected)?),
                    inferred: display_value(&normalize_value(&inferred)?),
                })
            }
        }
    }

    fn infer_computation(
        &self,
        context: &[PureValue],
        computation: &PureComputation,
    ) -> Result<PureValue, QCoreTypingError> {
        match &computation.0.term {
            PureComputationTerm::ReturnValue(value) => self.infer_value(context, value),
            PureComputationTerm::LetValue { value, body } => {
                let value_type = self.infer_value(context, value)?;
                let mut extended = context.to_vec();
                extended.insert(0, value_type);
                let body_type = self.infer_computation(&extended, body)?;
                substitute_value_top(&body_type, value)
            }
            PureComputationTerm::Bind { first, body } => {
                let first_type = self.infer_computation(context, first)?;
                let mut extended = context.to_vec();
                extended.insert(0, first_type);
                let body_type = self.infer_computation(&extended, body)?;
                remove_value_binder(&body_type, 0).map_err(|()| QCoreTypingError::Unsupported {
                    node: QCoreTypingNode::Computation(computation.0.source),
                    feature: UnsupportedPureFeature::DependentBindResult,
                })
            }
            PureComputationTerm::Apply { function, argument } => {
                if let PureValueTerm::Lambda(body) = &function.0.term {
                    let uses = count_bound_computation(body, 0)?;
                    if u32::try_from(uses).is_err() {
                        return Err(QCoreTypingError::SynthesizedGradeOverflow {
                            value: function.0.source,
                            uses,
                        });
                    }
                    let argument_type = self.infer_value(context, argument)?;
                    let mut extended = context.to_vec();
                    extended.insert(0, argument_type);
                    let result_type = self.infer_computation(&extended, body)?;
                    return substitute_value_top(&result_type, argument);
                }
                let function_type = normalize_value(&self.infer_value(context, function)?)?;
                let PureValueTerm::DependentPi {
                    domain, codomain, ..
                } = &function_type.0.term
                else {
                    return Err(QCoreTypingError::ExpectedFunction {
                        computation: computation.0.source,
                        inferred: display_value(&function_type),
                    });
                };
                self.check_value(context, argument, domain)?;
                substitute_value_top(codomain, argument)
            }
        }
    }

    fn check_computation(
        &self,
        context: &[PureValue],
        computation: &PureComputation,
        expected_type: &PureValue,
    ) -> Result<(), QCoreTypingError> {
        match &computation.0.term {
            PureComputationTerm::ReturnValue(value) => {
                self.check_value(context, value, expected_type)
            }
            PureComputationTerm::LetValue { value, body } => {
                let value_type = self.infer_value(context, value)?;
                let mut extended = context.to_vec();
                extended.insert(0, value_type);
                let shifted_expected = shift_value(expected_type, 1, 0)?;
                self.check_computation(&extended, body, &shifted_expected)
            }
            PureComputationTerm::Bind { first, body } => {
                let first_type = self.infer_computation(context, first)?;
                let mut extended = context.to_vec();
                extended.insert(0, first_type);
                let shifted_expected = shift_value(expected_type, 1, 0)?;
                self.check_computation(&extended, body, &shifted_expected)
            }
            PureComputationTerm::Apply { .. } => {
                let inferred = self.infer_computation(context, computation)?;
                if values_convert(&inferred, expected_type)? {
                    return Ok(());
                }
                Err(QCoreTypingError::ComputationTypeMismatch {
                    computation: computation.0.source,
                    expected: display_value(&normalize_value(expected_type)?),
                    inferred: display_value(&normalize_value(&inferred)?),
                })
            }
        }
    }
}

fn universe(source: ValueId, universe: Universe) -> PureValue {
    PureValue(Rc::new(PureValueNode {
        source,
        term: PureValueTerm::Universe(universe),
    }))
}

fn pi_universe(domain: Sort, codomain: Sort) -> Universe {
    match codomain {
        Sort::Prop => Universe::Prop,
        Sort::Type(codomain) => Universe::TypeUniverse {
            level: sort_level(domain).max(codomain),
        },
    }
}

fn sort_level(sort: Sort) -> u32 {
    match sort {
        Sort::Prop => 0,
        Sort::Type(level) => level,
    }
}

fn grade_contains(interval: &GradeInterval, uses: u64) -> bool {
    if uses < u64::from(interval.lower) {
        return false;
    }
    match interval.upper {
        GradeUpperBound::Finite { value } => uses <= u64::from(value),
        GradeUpperBound::Unbounded => true,
    }
}

const USE_COUNT_LIMIT: u64 = u32::MAX as u64 + 1;

fn add_uses(left: u64, right: u64) -> u64 {
    left.saturating_add(right).min(USE_COUNT_LIMIT)
}

fn count_bound_computation(
    computation: &PureComputation,
    target: u32,
) -> Result<u64, QCoreTypingError> {
    UsageCounter::default().computation(computation, target)
}

#[derive(Default)]
struct UsageCounter {
    values: HashMap<(usize, u32), u64>,
    computations: HashMap<(usize, u32), u64>,
}

impl UsageCounter {
    fn value(&mut self, value: &PureValue, target: u32) -> Result<u64, QCoreTypingError> {
        let key = (Rc::as_ptr(&value.0) as usize, target);
        if let Some(uses) = self.values.get(&key) {
            return Ok(*uses);
        }
        let uses = match &value.0.term {
            PureValueTerm::BoundVariable(index) => u64::from(index == &target),
            PureValueTerm::GlobalDefinition(_, _) | PureValueTerm::Universe(_) => 0,
            PureValueTerm::DependentPi {
                domain, codomain, ..
            }
            | PureValueTerm::DependentSigma {
                first: domain,
                second: codomain,
            } => {
                let next = next_binding_depth(target, QCoreTypingNode::Value(value.0.source))?;
                add_uses(self.value(domain, target)?, self.value(codomain, next)?)
            }
            PureValueTerm::Lambda(body) => {
                let next = next_binding_depth(target, QCoreTypingNode::Value(value.0.source))?;
                self.computation(body, next)?
            }
            PureValueTerm::Pair(first, second) => {
                add_uses(self.value(first, target)?, self.value(second, target)?)
            }
            PureValueTerm::FirstProjection(pair) | PureValueTerm::SecondProjection(pair) => {
                self.value(pair, target)?
            }
        };
        self.values.insert(key, uses);
        Ok(uses)
    }

    fn computation(
        &mut self,
        computation: &PureComputation,
        target: u32,
    ) -> Result<u64, QCoreTypingError> {
        let key = (Rc::as_ptr(&computation.0) as usize, target);
        if let Some(uses) = self.computations.get(&key) {
            return Ok(*uses);
        }
        let uses = match &computation.0.term {
            PureComputationTerm::ReturnValue(value) => self.value(value, target)?,
            PureComputationTerm::LetValue { value, body } => {
                let next =
                    next_binding_depth(target, QCoreTypingNode::Computation(computation.0.source))?;
                add_uses(self.value(value, target)?, self.computation(body, next)?)
            }
            PureComputationTerm::Bind { first, body } => {
                let next =
                    next_binding_depth(target, QCoreTypingNode::Computation(computation.0.source))?;
                add_uses(
                    self.computation(first, target)?,
                    self.computation(body, next)?,
                )
            }
            PureComputationTerm::Apply { function, argument } => {
                add_uses(self.value(function, target)?, self.value(argument, target)?)
            }
        };
        self.computations.insert(key, uses);
        Ok(uses)
    }
}

fn next_binding_depth(depth: u32, node: QCoreTypingNode) -> Result<u32, QCoreTypingError> {
    depth
        .checked_add(1)
        .ok_or(QCoreTypingError::BindingIndexOverflow { node })
}

fn shift_value(value: &PureValue, amount: u32, cutoff: u32) -> Result<PureValue, QCoreTypingError> {
    let term = match &value.0.term {
        PureValueTerm::BoundVariable(index) => {
            let shifted = if *index >= cutoff {
                index
                    .checked_add(amount)
                    .ok_or(QCoreTypingError::BindingIndexOverflow {
                        node: QCoreTypingNode::Value(value.0.source),
                    })?
            } else {
                *index
            };
            PureValueTerm::BoundVariable(shifted)
        }
        PureValueTerm::GlobalDefinition(definition, semantics) => {
            PureValueTerm::GlobalDefinition(definition.clone(), semantics.clone())
        }
        PureValueTerm::Universe(universe) => PureValueTerm::Universe(universe.clone()),
        PureValueTerm::DependentPi {
            domain,
            codomain,
            grade,
            interval,
        } => PureValueTerm::DependentPi {
            domain: shift_value(domain, amount, cutoff)?,
            codomain: shift_value(
                codomain,
                amount,
                next_binding_depth(cutoff, QCoreTypingNode::Value(value.0.source))?,
            )?,
            grade: *grade,
            interval: interval.clone(),
        },
        PureValueTerm::DependentSigma { first, second } => PureValueTerm::DependentSigma {
            first: shift_value(first, amount, cutoff)?,
            second: shift_value(
                second,
                amount,
                next_binding_depth(cutoff, QCoreTypingNode::Value(value.0.source))?,
            )?,
        },
        PureValueTerm::Lambda(body) => PureValueTerm::Lambda(shift_computation(
            body,
            amount,
            next_binding_depth(cutoff, QCoreTypingNode::Value(value.0.source))?,
        )?),
        PureValueTerm::Pair(first, second) => PureValueTerm::Pair(
            shift_value(first, amount, cutoff)?,
            shift_value(second, amount, cutoff)?,
        ),
        PureValueTerm::FirstProjection(pair) => {
            PureValueTerm::FirstProjection(shift_value(pair, amount, cutoff)?)
        }
        PureValueTerm::SecondProjection(pair) => {
            PureValueTerm::SecondProjection(shift_value(pair, amount, cutoff)?)
        }
    };
    Ok(PureValue(Rc::new(PureValueNode {
        source: value.0.source,
        term,
    })))
}

fn shift_computation(
    computation: &PureComputation,
    amount: u32,
    cutoff: u32,
) -> Result<PureComputation, QCoreTypingError> {
    let term = match &computation.0.term {
        PureComputationTerm::ReturnValue(value) => {
            PureComputationTerm::ReturnValue(shift_value(value, amount, cutoff)?)
        }
        PureComputationTerm::LetValue { value, body } => PureComputationTerm::LetValue {
            value: shift_value(value, amount, cutoff)?,
            body: shift_computation(
                body,
                amount,
                next_binding_depth(cutoff, QCoreTypingNode::Computation(computation.0.source))?,
            )?,
        },
        PureComputationTerm::Bind { first, body } => PureComputationTerm::Bind {
            first: shift_computation(first, amount, cutoff)?,
            body: shift_computation(
                body,
                amount,
                next_binding_depth(cutoff, QCoreTypingNode::Computation(computation.0.source))?,
            )?,
        },
        PureComputationTerm::Apply { function, argument } => PureComputationTerm::Apply {
            function: shift_value(function, amount, cutoff)?,
            argument: shift_value(argument, amount, cutoff)?,
        },
    };
    Ok(PureComputation(Rc::new(PureComputationNode {
        source: computation.0.source,
        term,
    })))
}

fn substitute_value_top(
    value: &PureValue,
    replacement: &PureValue,
) -> Result<PureValue, QCoreTypingError> {
    substitute_value(value, replacement, 0)
}

fn substitute_value(
    value: &PureValue,
    replacement: &PureValue,
    depth: u32,
) -> Result<PureValue, QCoreTypingError> {
    let term = match &value.0.term {
        PureValueTerm::BoundVariable(index) if *index == depth => {
            return shift_value(replacement, depth, 0);
        }
        PureValueTerm::BoundVariable(index) => {
            let adjusted = if *index > depth { index - 1 } else { *index };
            PureValueTerm::BoundVariable(adjusted)
        }
        PureValueTerm::GlobalDefinition(definition, semantics) => {
            PureValueTerm::GlobalDefinition(definition.clone(), semantics.clone())
        }
        PureValueTerm::Universe(universe) => PureValueTerm::Universe(universe.clone()),
        PureValueTerm::DependentPi {
            domain,
            codomain,
            grade,
            interval,
        } => PureValueTerm::DependentPi {
            domain: substitute_value(domain, replacement, depth)?,
            codomain: substitute_value(
                codomain,
                replacement,
                next_binding_depth(depth, QCoreTypingNode::Value(value.0.source))?,
            )?,
            grade: *grade,
            interval: interval.clone(),
        },
        PureValueTerm::DependentSigma { first, second } => PureValueTerm::DependentSigma {
            first: substitute_value(first, replacement, depth)?,
            second: substitute_value(
                second,
                replacement,
                next_binding_depth(depth, QCoreTypingNode::Value(value.0.source))?,
            )?,
        },
        PureValueTerm::Lambda(body) => PureValueTerm::Lambda(substitute_computation(
            body,
            replacement,
            next_binding_depth(depth, QCoreTypingNode::Value(value.0.source))?,
        )?),
        PureValueTerm::Pair(first, second) => PureValueTerm::Pair(
            substitute_value(first, replacement, depth)?,
            substitute_value(second, replacement, depth)?,
        ),
        PureValueTerm::FirstProjection(pair) => {
            PureValueTerm::FirstProjection(substitute_value(pair, replacement, depth)?)
        }
        PureValueTerm::SecondProjection(pair) => {
            PureValueTerm::SecondProjection(substitute_value(pair, replacement, depth)?)
        }
    };
    Ok(PureValue(Rc::new(PureValueNode {
        source: value.0.source,
        term,
    })))
}

fn substitute_computation(
    computation: &PureComputation,
    replacement: &PureValue,
    depth: u32,
) -> Result<PureComputation, QCoreTypingError> {
    let term = match &computation.0.term {
        PureComputationTerm::ReturnValue(value) => {
            PureComputationTerm::ReturnValue(substitute_value(value, replacement, depth)?)
        }
        PureComputationTerm::LetValue { value, body } => PureComputationTerm::LetValue {
            value: substitute_value(value, replacement, depth)?,
            body: substitute_computation(
                body,
                replacement,
                next_binding_depth(depth, QCoreTypingNode::Computation(computation.0.source))?,
            )?,
        },
        PureComputationTerm::Bind { first, body } => PureComputationTerm::Bind {
            first: substitute_computation(first, replacement, depth)?,
            body: substitute_computation(
                body,
                replacement,
                next_binding_depth(depth, QCoreTypingNode::Computation(computation.0.source))?,
            )?,
        },
        PureComputationTerm::Apply { function, argument } => PureComputationTerm::Apply {
            function: substitute_value(function, replacement, depth)?,
            argument: substitute_value(argument, replacement, depth)?,
        },
    };
    Ok(PureComputation(Rc::new(PureComputationNode {
        source: computation.0.source,
        term,
    })))
}

fn remove_value_binder(value: &PureValue, depth: u32) -> Result<PureValue, ()> {
    let term = match &value.0.term {
        PureValueTerm::BoundVariable(index) if *index == depth => return Err(()),
        PureValueTerm::BoundVariable(index) => {
            PureValueTerm::BoundVariable(if *index > depth { index - 1 } else { *index })
        }
        PureValueTerm::GlobalDefinition(definition, semantics) => {
            PureValueTerm::GlobalDefinition(definition.clone(), semantics.clone())
        }
        PureValueTerm::Universe(universe) => PureValueTerm::Universe(universe.clone()),
        PureValueTerm::DependentPi {
            domain,
            codomain,
            grade,
            interval,
        } => PureValueTerm::DependentPi {
            domain: remove_value_binder(domain, depth)?,
            codomain: remove_value_binder(codomain, depth + 1)?,
            grade: *grade,
            interval: interval.clone(),
        },
        PureValueTerm::DependentSigma { first, second } => PureValueTerm::DependentSigma {
            first: remove_value_binder(first, depth)?,
            second: remove_value_binder(second, depth + 1)?,
        },
        PureValueTerm::Lambda(body) => {
            PureValueTerm::Lambda(remove_computation_binder(body, depth + 1)?)
        }
        PureValueTerm::Pair(first, second) => PureValueTerm::Pair(
            remove_value_binder(first, depth)?,
            remove_value_binder(second, depth)?,
        ),
        PureValueTerm::FirstProjection(pair) => {
            PureValueTerm::FirstProjection(remove_value_binder(pair, depth)?)
        }
        PureValueTerm::SecondProjection(pair) => {
            PureValueTerm::SecondProjection(remove_value_binder(pair, depth)?)
        }
    };
    Ok(PureValue(Rc::new(PureValueNode {
        source: value.0.source,
        term,
    })))
}

fn remove_computation_binder(
    computation: &PureComputation,
    depth: u32,
) -> Result<PureComputation, ()> {
    let term = match &computation.0.term {
        PureComputationTerm::ReturnValue(value) => {
            PureComputationTerm::ReturnValue(remove_value_binder(value, depth)?)
        }
        PureComputationTerm::LetValue { value, body } => PureComputationTerm::LetValue {
            value: remove_value_binder(value, depth)?,
            body: remove_computation_binder(body, depth + 1)?,
        },
        PureComputationTerm::Bind { first, body } => PureComputationTerm::Bind {
            first: remove_computation_binder(first, depth)?,
            body: remove_computation_binder(body, depth + 1)?,
        },
        PureComputationTerm::Apply { function, argument } => PureComputationTerm::Apply {
            function: remove_value_binder(function, depth)?,
            argument: remove_value_binder(argument, depth)?,
        },
    };
    Ok(PureComputation(Rc::new(PureComputationNode {
        source: computation.0.source,
        term,
    })))
}

const NORMALIZATION_REDUCTION_LIMIT: u64 = 1_000_000;

struct NormalizationBudget {
    remaining: u64,
    limit: u64,
}

impl NormalizationBudget {
    fn with_limit(limit: u64) -> Self {
        Self {
            remaining: limit,
            limit,
        }
    }

    fn reduce(&mut self, node: QCoreTypingNode) -> Result<(), QCoreTypingError> {
        if self.remaining == 0 {
            return Err(QCoreTypingError::NormalizationLimitExceeded {
                node,
                limit: self.limit,
            });
        }
        self.remaining -= 1;
        Ok(())
    }
}

fn normalize_value(value: &PureValue) -> Result<PureValue, QCoreTypingError> {
    Normalizer::standard().value(value)
}

fn normalize_computation(
    computation: &PureComputation,
) -> Result<PureComputation, QCoreTypingError> {
    Normalizer::standard().computation(computation)
}

struct Normalizer {
    budget: NormalizationBudget,
    values: HashMap<usize, (PureValue, PureValue)>,
    computations: HashMap<usize, (PureComputation, PureComputation)>,
}

impl Normalizer {
    fn standard() -> Self {
        Self::with_limit(NORMALIZATION_REDUCTION_LIMIT)
    }

    fn with_limit(limit: u64) -> Self {
        Self {
            budget: NormalizationBudget::with_limit(limit),
            values: HashMap::new(),
            computations: HashMap::new(),
        }
    }

    fn value(&mut self, value: &PureValue) -> Result<PureValue, QCoreTypingError> {
        let key = Rc::as_ptr(&value.0) as usize;
        if let Some((input, normalized)) = self.values.get(&key) {
            debug_assert!(Rc::ptr_eq(&input.0, &value.0));
            return Ok(normalized.clone());
        }
        let normalized = match &value.0.term {
            PureValueTerm::BoundVariable(index) => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::BoundVariable(*index),
            })),
            PureValueTerm::GlobalDefinition(definition, semantics) => {
                PureValue(Rc::new(PureValueNode {
                    source: value.0.source,
                    term: PureValueTerm::GlobalDefinition(definition.clone(), semantics.clone()),
                }))
            }
            PureValueTerm::Universe(universe) => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::Universe(universe.clone()),
            })),
            PureValueTerm::DependentPi {
                domain,
                codomain,
                grade,
                interval,
            } => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::DependentPi {
                    domain: self.value(domain)?,
                    codomain: self.value(codomain)?,
                    grade: *grade,
                    interval: interval.clone(),
                },
            })),
            PureValueTerm::DependentSigma { first, second } => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::DependentSigma {
                    first: self.value(first)?,
                    second: self.value(second)?,
                },
            })),
            PureValueTerm::Lambda(body) => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::Lambda(self.computation(body)?),
            })),
            PureValueTerm::Pair(first, second) => PureValue(Rc::new(PureValueNode {
                source: value.0.source,
                term: PureValueTerm::Pair(self.value(first)?, self.value(second)?),
            })),
            PureValueTerm::FirstProjection(pair) => {
                let pair = self.value(pair)?;
                if let PureValueTerm::Pair(first, _) = &pair.0.term {
                    self.budget.reduce(QCoreTypingNode::Value(value.0.source))?;
                    first.clone()
                } else {
                    PureValue(Rc::new(PureValueNode {
                        source: value.0.source,
                        term: PureValueTerm::FirstProjection(pair),
                    }))
                }
            }
            PureValueTerm::SecondProjection(pair) => {
                let pair = self.value(pair)?;
                if let PureValueTerm::Pair(_, second) = &pair.0.term {
                    self.budget.reduce(QCoreTypingNode::Value(value.0.source))?;
                    second.clone()
                } else {
                    PureValue(Rc::new(PureValueNode {
                        source: value.0.source,
                        term: PureValueTerm::SecondProjection(pair),
                    }))
                }
            }
        };
        self.values.insert(key, (value.clone(), normalized.clone()));
        Ok(normalized)
    }

    fn computation(
        &mut self,
        computation: &PureComputation,
    ) -> Result<PureComputation, QCoreTypingError> {
        let key = Rc::as_ptr(&computation.0) as usize;
        if let Some((input, normalized)) = self.computations.get(&key) {
            debug_assert!(Rc::ptr_eq(&input.0, &computation.0));
            return Ok(normalized.clone());
        }
        let normalized = match &computation.0.term {
            PureComputationTerm::ReturnValue(value) => {
                PureComputation(Rc::new(PureComputationNode {
                    source: computation.0.source,
                    term: PureComputationTerm::ReturnValue(self.value(value)?),
                }))
            }
            PureComputationTerm::LetValue { value, body } => {
                let value = self.value(value)?;
                self.budget
                    .reduce(QCoreTypingNode::Computation(computation.0.source))?;
                self.computation(&substitute_computation(body, &value, 0)?)?
            }
            PureComputationTerm::Bind { first, body } => {
                let first = self.computation(first)?;
                if let PureComputationTerm::ReturnValue(value) = &first.0.term {
                    self.budget
                        .reduce(QCoreTypingNode::Computation(computation.0.source))?;
                    self.computation(&substitute_computation(body, value, 0)?)?
                } else {
                    PureComputation(Rc::new(PureComputationNode {
                        source: computation.0.source,
                        term: PureComputationTerm::Bind {
                            first,
                            body: self.computation(body)?,
                        },
                    }))
                }
            }
            PureComputationTerm::Apply { function, argument } => {
                let function = self.value(function)?;
                let argument = self.value(argument)?;
                if let PureValueTerm::Lambda(body) = &function.0.term {
                    self.budget
                        .reduce(QCoreTypingNode::Computation(computation.0.source))?;
                    self.computation(&substitute_computation(body, &argument, 0)?)?
                } else {
                    PureComputation(Rc::new(PureComputationNode {
                        source: computation.0.source,
                        term: PureComputationTerm::Apply { function, argument },
                    }))
                }
            }
        };
        self.computations
            .insert(key, (computation.clone(), normalized.clone()));
        Ok(normalized)
    }
}

fn values_convert(left: &PureValue, right: &PureValue) -> Result<bool, QCoreTypingError> {
    values_equal(&normalize_value(left)?, &normalize_value(right)?)
}

fn computations_convert(
    left: &PureComputation,
    right: &PureComputation,
) -> Result<bool, QCoreTypingError> {
    computations_equal(
        &normalize_computation(left)?,
        &normalize_computation(right)?,
    )
}

fn values_equal(left: &PureValue, right: &PureValue) -> Result<bool, QCoreTypingError> {
    let equal = match (&left.0.term, &right.0.term) {
        (PureValueTerm::BoundVariable(left), PureValueTerm::BoundVariable(right)) => left == right,
        (
            PureValueTerm::GlobalDefinition(left_definition, left_semantics),
            PureValueTerm::GlobalDefinition(right_definition, right_semantics),
        ) => left_definition == right_definition && left_semantics == right_semantics,
        (PureValueTerm::Universe(left), PureValueTerm::Universe(right)) => left == right,
        (
            PureValueTerm::DependentPi {
                domain: left_domain,
                codomain: left_codomain,
                interval: left_interval,
                ..
            },
            PureValueTerm::DependentPi {
                domain: right_domain,
                codomain: right_codomain,
                interval: right_interval,
                ..
            },
        ) => {
            left_interval == right_interval
                && values_equal(left_domain, right_domain)?
                && values_equal(left_codomain, right_codomain)?
        }
        (
            PureValueTerm::DependentSigma {
                first: left_first,
                second: left_second,
            },
            PureValueTerm::DependentSigma {
                first: right_first,
                second: right_second,
            },
        ) => values_equal(left_first, right_first)? && values_equal(left_second, right_second)?,
        (PureValueTerm::Lambda(left), PureValueTerm::Lambda(right)) => {
            computations_equal(left, right)?
        }
        (
            PureValueTerm::Pair(left_first, left_second),
            PureValueTerm::Pair(right_first, right_second),
        ) => values_equal(left_first, right_first)? && values_equal(left_second, right_second)?,
        (PureValueTerm::FirstProjection(left), PureValueTerm::FirstProjection(right))
        | (PureValueTerm::SecondProjection(left), PureValueTerm::SecondProjection(right)) => {
            values_equal(left, right)?
        }
        _ => false,
    };
    Ok(equal)
}

fn computations_equal(
    left: &PureComputation,
    right: &PureComputation,
) -> Result<bool, QCoreTypingError> {
    let equal = match (&left.0.term, &right.0.term) {
        (PureComputationTerm::ReturnValue(left), PureComputationTerm::ReturnValue(right)) => {
            values_equal(left, right)?
        }
        (
            PureComputationTerm::LetValue {
                value: left_value,
                body: left_body,
            },
            PureComputationTerm::LetValue {
                value: right_value,
                body: right_body,
            },
        ) => values_equal(left_value, right_value)? && computations_equal(left_body, right_body)?,
        (
            PureComputationTerm::Bind {
                first: left_first,
                body: left_body,
            },
            PureComputationTerm::Bind {
                first: right_first,
                body: right_body,
            },
        ) => {
            computations_equal(left_first, right_first)?
                && computations_equal(left_body, right_body)?
        }
        (
            PureComputationTerm::Apply {
                function: left_function,
                argument: left_argument,
            },
            PureComputationTerm::Apply {
                function: right_function,
                argument: right_argument,
            },
        ) => {
            values_equal(left_function, right_function)?
                && values_equal(left_argument, right_argument)?
        }
        _ => false,
    };
    Ok(equal)
}

fn display_value(value: &PureValue) -> String {
    match &value.0.term {
        PureValueTerm::BoundVariable(index) => format!("#{index}"),
        PureValueTerm::GlobalDefinition(definition, _) => definition.0.clone(),
        PureValueTerm::Universe(Universe::Prop) => "Prop".to_owned(),
        PureValueTerm::Universe(Universe::TypeUniverse { level }) => format!("Type({level})"),
        PureValueTerm::DependentPi { .. } => "Pi".to_owned(),
        PureValueTerm::DependentSigma { .. } => "Sigma".to_owned(),
        PureValueTerm::Lambda(_) => "lambda".to_owned(),
        PureValueTerm::Pair(_, _) => "pair".to_owned(),
        PureValueTerm::FirstProjection(_) => "first projection".to_owned(),
        PureValueTerm::SecondProjection(_) => "second projection".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use crate::qcore::{ValidationError, validate_module};
    use crate::qcore_generated::{
        ComputationNode, Definition, DefinitionReference, EffectRowNode, GradeNode, QArena,
        QCORE_SCHEMA_VERSION, SourceOrigin, SourceOriginId, ValueNode,
    };

    use super::*;

    struct ModuleBuilder {
        module: QModule,
    }

    impl ModuleBuilder {
        fn new() -> Self {
            Self {
                module: QModule {
                    schema_version: QCORE_SCHEMA_VERSION,
                    module: semantic_key("module:test"),
                    effect_parameter_count: 0,
                    imports: Vec::new(),
                    definitions: Vec::new(),
                    arena: QArena {
                        origins: vec![SourceOrigin {
                            source: semantic_key("source:test"),
                            start: 0,
                            end: 1,
                        }],
                        values: Vec::new(),
                        computations: Vec::new(),
                        effect_rows: Vec::new(),
                        grades: Vec::new(),
                        proofs: Vec::new(),
                    },
                },
            }
        }

        fn value(&mut self, term: Value) -> ValueId {
            let id = ValueId(self.module.arena.values.len() as u32);
            self.module.arena.values.push(ValueNode {
                origin: SourceOriginId(0),
                term,
            });
            id
        }

        fn computation(&mut self, term: Computation) -> ComputationId {
            let id = ComputationId(self.module.arena.computations.len() as u32);
            self.module.arena.computations.push(ComputationNode {
                origin: SourceOriginId(0),
                term,
            });
            id
        }

        fn empty_effects(&mut self) -> EffectRowId {
            let id = EffectRowId(self.module.arena.effect_rows.len() as u32);
            self.module.arena.effect_rows.push(EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Empty,
            });
            id
        }

        fn grade(&mut self, lower: u32, upper: GradeUpperBound) -> GradeId {
            let id = GradeId(self.module.arena.grades.len() as u32);
            self.module.arena.grades.push(GradeNode {
                origin: SourceOriginId(0),
                interval: GradeInterval { lower, upper },
            });
            id
        }

        fn value_definition(&mut self, name: &str, value: ValueId, expected_type: ValueId) {
            self.module.definitions.push(Definition {
                reference: definition_reference(name),
                body: DefinitionBody::Value {
                    value,
                    expected_type,
                },
            });
        }

        fn computation_definition(
            &mut self,
            name: &str,
            computation: ComputationId,
            result_type: ValueId,
            effects: EffectRowId,
        ) {
            self.module.definitions.push(Definition {
                reference: definition_reference(name),
                body: DefinitionBody::Computation {
                    computation,
                    result_type,
                    effects,
                },
            });
        }
    }

    fn semantic_key(value: &str) -> SemanticKey {
        SemanticKey(value.to_owned())
    }

    fn definition_reference(value: &str) -> DefinitionReference {
        DefinitionReference {
            definition: DefinitionKey(value.to_owned()),
            semantics: semantic_key(&format!("semantic:{value}")),
            origin: SourceOriginId(0),
        }
    }

    fn check(module: &QModule) -> Result<(), QCoreTypingError> {
        let validated = validate_module(module).expect("test module must be structurally valid");
        check_pure_module(&validated).map(|_| ())
    }

    #[test]
    fn proposition_and_type_universes_check_at_their_successors() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        builder.value_definition("proposition", proposition, type_zero);

        check(&builder.module).expect("Prop must inhabit Type(0)");
    }

    #[test]
    fn the_top_machine_universe_level_is_rejected() {
        let mut builder = ModuleBuilder::new();
        let top = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: u32::MAX },
        });
        builder.value_definition("top", top, top);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::UniverseLevelOverflow {
                value: top,
                level: u32::MAX,
            }),
        );
    }

    #[test]
    fn universe_checking_is_exact_without_cumulativity() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_one = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 1 },
        });
        builder.value_definition("proposition", proposition, type_one);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::ValueTypeMismatch {
                value: proposition,
                expected: "Type(1)".to_owned(),
                inferred: "Type(0)".to_owned(),
            }),
        );
    }

    #[test]
    fn dependent_function_checks_its_body_and_exact_grade() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let body = builder.computation(Computation::ReturnValue { value: parameter });
        let lambda = builder.value(Value::Lambda { body });
        let effects = builder.empty_effects();
        let grade = builder.grade(1, GradeUpperBound::Finite { value: 1 });
        let function_type = builder.value(Value::DependentPi {
            domain: proposition,
            codomain: proposition,
            effects,
            grade,
        });
        builder.value_definition("identity", lambda, function_type);

        check(&builder.module).expect("identity must use its parameter exactly once");
    }

    #[test]
    fn dependent_function_rejects_a_grade_that_excludes_its_use_count() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let body = builder.computation(Computation::ReturnValue { value: parameter });
        let lambda = builder.value(Value::Lambda { body });
        let effects = builder.empty_effects();
        let grade = builder.grade(0, GradeUpperBound::Finite { value: 0 });
        let function_type = builder.value(Value::DependentPi {
            domain: proposition,
            codomain: proposition,
            effects,
            grade,
        });
        builder.value_definition("constant", lambda, function_type);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::GradeViolation {
                value: lambda,
                grade,
                lower: 0,
                upper: GradeUpperBound::Finite { value: 0 },
                uses: 1,
            }),
        );
    }

    #[test]
    fn sigma_pairs_and_both_projections_check() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let sigma = builder.value(Value::DependentSigma {
            first: type_zero,
            second: type_zero,
        });
        let pair = builder.value(Value::Pair {
            first: proposition,
            second: proposition,
        });
        let first = builder.value(Value::FirstProjection { pair });
        let second = builder.value(Value::SecondProjection { pair });
        builder.value_definition("pair", pair, sigma);
        builder.value_definition("first", first, type_zero);
        builder.value_definition("second", second, type_zero);
        builder.value_definition("proposition", proposition, type_zero);

        let validated = validate_module(&builder.module).expect("pair module must validate");
        let checked = check_pure_module(&validated).expect("pair module must typecheck");
        assert!(
            checked
                .value_definitions_convert(
                    &DefinitionKey("first".to_owned()),
                    &DefinitionKey("proposition".to_owned()),
                )
                .expect("checked values must normalize")
        );
        assert!(
            checked
                .value_definitions_convert(
                    &DefinitionKey("second".to_owned()),
                    &DefinitionKey("proposition".to_owned()),
                )
                .expect("checked values must normalize")
        );
    }

    #[test]
    fn application_beta_reduction_is_part_of_computation_conversion() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let lambda_body = builder.computation(Computation::ReturnValue { value: parameter });
        let lambda = builder.value(Value::Lambda { body: lambda_body });
        let application = builder.computation(Computation::Apply {
            function: lambda,
            argument: proposition,
        });
        let returned = builder.computation(Computation::ReturnValue { value: proposition });
        let effects = builder.empty_effects();
        builder.computation_definition("applied", application, type_zero, effects);
        builder.computation_definition("returned", returned, type_zero, effects);

        let validated = validate_module(&builder.module).expect("beta module must validate");
        let checked = check_pure_module(&validated).expect("beta module must typecheck");
        assert!(
            checked
                .computation_definitions_convert(
                    &DefinitionKey("applied".to_owned()),
                    &DefinitionKey("returned".to_owned()),
                )
                .expect("checked computations must normalize")
        );
    }

    #[test]
    fn direct_lambda_application_synthesizes_its_two_use_grade() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let pair = builder.value(Value::Pair {
            first: parameter,
            second: parameter,
        });
        let body = builder.computation(Computation::ReturnValue { value: pair });
        let lambda = builder.value(Value::Lambda { body });
        let application = builder.computation(Computation::Apply {
            function: lambda,
            argument: proposition,
        });
        let result_type = builder.value(Value::DependentSigma {
            first: type_zero,
            second: type_zero,
        });
        let effects = builder.empty_effects();
        builder.computation_definition("duplicated", application, result_type, effects);

        check(&builder.module)
            .expect("direct application must infer the lambda's exact two-use grade");
    }

    #[test]
    fn a_local_global_uses_its_checked_value_boundary() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let body = builder.computation(Computation::ReturnValue { value: parameter });
        let lambda = builder.value(Value::Lambda { body });
        let effects = builder.empty_effects();
        let grade = builder.grade(1, GradeUpperBound::Finite { value: 1 });
        let function_type = builder.value(Value::DependentPi {
            domain: type_zero,
            codomain: type_zero,
            effects,
            grade,
        });
        builder.value_definition("identity", lambda, function_type);
        let global = builder.value(Value::GlobalDefinition {
            definition: DefinitionKey("identity".to_owned()),
            semantics: semantic_key("semantic:identity"),
        });
        let application = builder.computation(Computation::Apply {
            function: global,
            argument: proposition,
        });
        builder.computation_definition("applied", application, type_zero, effects);

        check(&builder.module).expect("a local global must expose its checked value type");
    }

    #[test]
    fn a_nonempty_function_effect_row_stops_at_the_pure_boundary() {
        let mut builder = ModuleBuilder::new();
        let proposition = builder.value(Value::Universe {
            universe: Universe::Prop,
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let body = builder.computation(Computation::ReturnValue { value: parameter });
        let lambda = builder.value(Value::Lambda { body });
        let empty = builder.empty_effects();
        let effects = EffectRowId(builder.module.arena.effect_rows.len() as u32);
        builder.module.arena.effect_rows.push(EffectRowNode {
            origin: SourceOriginId(0),
            row: EffectRow::Extend {
                effect: semantic_key("effect:state"),
                tail: empty,
            },
        });
        let grade = builder.grade(1, GradeUpperBound::Finite { value: 1 });
        let function_type = builder.value(Value::DependentPi {
            domain: proposition,
            codomain: proposition,
            effects,
            grade,
        });
        builder.value_definition("effectful", lambda, function_type);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::Unsupported {
                node: QCoreTypingNode::EffectRow(effects),
                feature: UnsupportedPureFeature::EffectOperation,
            }),
        );
    }

    #[test]
    fn weakening_preserves_the_nearest_binder_and_shifts_outer_variables() {
        let nearest = PureValue(Rc::new(PureValueNode {
            source: ValueId(0),
            term: PureValueTerm::BoundVariable(0),
        }));
        let outer = PureValue(Rc::new(PureValueNode {
            source: ValueId(1),
            term: PureValueTerm::BoundVariable(1),
        }));
        let pair = PureValue(Rc::new(PureValueNode {
            source: ValueId(2),
            term: PureValueTerm::Pair(nearest, outer),
        }));
        let body = PureComputation(Rc::new(PureComputationNode {
            source: ComputationId(0),
            term: PureComputationTerm::ReturnValue(pair),
        }));
        let lambda = PureValue(Rc::new(PureValueNode {
            source: ValueId(3),
            term: PureValueTerm::Lambda(body),
        }));

        let weakened = shift_value(&lambda, 1, 0).expect("binding indices must fit");
        let PureValueTerm::Lambda(body) = &weakened.0.term else {
            panic!("weakening changed the lambda form");
        };
        let PureComputationTerm::ReturnValue(pair) = &body.0.term else {
            panic!("weakening changed the return form");
        };
        let PureValueTerm::Pair(nearest, outer) = &pair.0.term else {
            panic!("weakening changed the pair form");
        };
        assert!(matches!(nearest.0.term, PureValueTerm::BoundVariable(0)));
        assert!(matches!(outer.0.term, PureValueTerm::BoundVariable(2)));
    }

    #[test]
    fn substitution_shifts_a_replacement_beneath_a_nested_binder() {
        let outer = PureValue(Rc::new(PureValueNode {
            source: ValueId(0),
            term: PureValueTerm::BoundVariable(1),
        }));
        let body = PureComputation(Rc::new(PureComputationNode {
            source: ComputationId(0),
            term: PureComputationTerm::ReturnValue(outer),
        }));
        let lambda = PureValue(Rc::new(PureValueNode {
            source: ValueId(1),
            term: PureValueTerm::Lambda(body),
        }));
        let replacement = PureValue(Rc::new(PureValueNode {
            source: ValueId(2),
            term: PureValueTerm::BoundVariable(0),
        }));

        let substituted = substitute_value_top(&lambda, &replacement)
            .expect("capture-avoiding substitution must fit the index domain");
        let PureValueTerm::Lambda(body) = &substituted.0.term else {
            panic!("substitution changed the lambda form");
        };
        let PureComputationTerm::ReturnValue(value) = &body.0.term else {
            panic!("substitution changed the return form");
        };
        assert!(matches!(value.0.term, PureValueTerm::BoundVariable(1)));
    }

    #[test]
    fn untyped_omega_exhausts_normalization_as_an_invariant_error() {
        let mut builder = ModuleBuilder::new();
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let parameter = builder.value(Value::BoundVariable { index: 0 });
        let self_application = builder.computation(Computation::Apply {
            function: parameter,
            argument: parameter,
        });
        let lambda = builder.value(Value::Lambda {
            body: self_application,
        });
        let omega = builder.computation(Computation::Apply {
            function: lambda,
            argument: lambda,
        });
        let effects = builder.empty_effects();
        builder.computation_definition("omega", omega, type_zero, effects);

        let validated = validate_module(&builder.module).expect("omega is structurally closed");
        let pure = PureModule::lower(validated.module()).expect("omega uses only pure forms");
        let PureDefinitionBody::Computation { computation, .. } = pure
            .definition(&DefinitionKey("omega".to_owned()))
            .expect("omega definition must exist")
        else {
            panic!("omega must be a computation definition");
        };
        let error = match Normalizer::with_limit(8).computation(computation) {
            Ok(_) => panic!("untyped omega made conversion terminate as a normal form"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            QCoreTypingError::NormalizationLimitExceeded { limit: 8, .. }
        ));
    }

    #[test]
    fn structural_shadow_terms_stop_at_the_explicit_boundary() {
        let mut builder = ModuleBuilder::new();
        let unit = builder.value(Value::StructuralUnit);
        builder.value_definition("unit", unit, unit);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::Unsupported {
                node: QCoreTypingNode::Value(unit),
                feature: UnsupportedPureFeature::StructuralCertificate(ValueTag::StructuralUnit),
            }),
        );
    }

    #[test]
    fn imported_globals_stop_when_their_type_boundary_is_missing() {
        let mut builder = ModuleBuilder::new();
        let type_zero = builder.value(Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        });
        let import = definition_reference("external");
        let global = builder.value(Value::GlobalDefinition {
            definition: import.definition.clone(),
            semantics: import.semantics.clone(),
        });
        builder.module.imports.push(import);
        builder.value_definition("root", global, type_zero);

        assert_eq!(
            check(&builder.module),
            Err(QCoreTypingError::Unsupported {
                node: QCoreTypingNode::Value(global),
                feature: UnsupportedPureFeature::ImportedDefinitionType(DefinitionKey(
                    "external".to_owned(),
                )),
            }),
        );
    }

    #[test]
    fn structural_validation_rejects_scope_before_typing() {
        let mut builder = ModuleBuilder::new();
        let free = builder.value(Value::BoundVariable { index: 0 });
        builder.value_definition("free", free, free);

        assert_eq!(
            validate_module(&builder.module),
            Err(ValidationError::BoundVariableOutOfScope {
                value: free,
                index: 0,
                depth: 0,
            }),
        );
    }
}
