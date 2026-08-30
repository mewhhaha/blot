use std::collections::{BTreeMap, HashMap, HashSet};

use num_bigint::BigInt;

use crate::ast::{ExpressionId, Module, Span};
use crate::qcore_generated::{
    Computation, ComputationId, Definition, DefinitionBody, DefinitionKey, DefinitionReference,
    EffectRow, EffectRowId, GradeId, GradeInterval, GradeUpperBound, ProofId, QArena,
    QCORE_SCHEMA_VERSION, QModule, RangeDomain, ScalarBound, SemanticKey, SourceOrigin,
    SourceOriginId, Universe, Value, ValueId, ValueNode,
};
use crate::typecheck::{
    CheckedModuleCertificate, Domain, FlatTypeId, FlatTypeNode, Scalar, SealedModuleBoundary,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ArenaKind {
    Origin,
    Value,
    Computation,
    EffectRow,
    Grade,
    Proof,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ArenaReference {
    Origin(SourceOriginId),
    Value(ValueId),
    Computation(ComputationId),
    EffectRow(EffectRowId),
    Grade(GradeId),
    Proof(ProofId),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ReferenceSource {
    Import(usize),
    Definition(usize),
    Value(ValueId),
    Computation(ComputationId),
    EffectRow(EffectRowId),
    Grade(GradeId),
    Proof(ProofId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ValidationError {
    SchemaVersion {
        expected: u32,
        actual: u32,
    },
    ArenaTooLarge {
        arena: ArenaKind,
        length: usize,
    },
    InvalidOriginRange {
        origin: SourceOriginId,
        start: u32,
        end: u32,
    },
    MissingReference {
        source: ReferenceSource,
        target: ArenaReference,
    },
    ProofSlotMismatch {
        slot: ProofId,
        declared: ProofId,
    },
    DuplicateDefinition {
        definition: DefinitionKey,
    },
    UnknownDefinition {
        definition: DefinitionKey,
        semantics: SemanticKey,
    },
    DefinitionSemanticMismatch {
        definition: DefinitionKey,
        expected: SemanticKey,
        actual: SemanticKey,
    },
    DirectArenaCycle {
        reference: ArenaReference,
    },
    BoundVariableOutOfScope {
        value: ValueId,
        index: u32,
        depth: u32,
    },
    StructuralRigidOutOfScope {
        value: ValueId,
        variable: u32,
    },
    DuplicateStructuralBinder {
        value: ValueId,
        variable: u32,
    },
    LabeledTypeLengthMismatch {
        value: ValueId,
        labels: usize,
        types: usize,
    },
    StructuralLabelsNotCanonical {
        value: ValueId,
        label: String,
        next_label: String,
    },
    InvalidStructuralRange {
        value: ValueId,
        domain: RangeDomain,
        low: ScalarBound,
        high: ScalarBound,
    },
    BindingDepthOverflow {
        source: ArenaReference,
    },
    EffectVariableOutOfScope {
        row: EffectRowId,
        index: u32,
        parameter_count: u32,
    },
    EffectRowNotCanonical {
        row: EffectRowId,
        effect: SemanticKey,
        next_effect: SemanticKey,
    },
    InvalidGrade {
        grade: GradeId,
        lower: u32,
        upper: GradeUpperBound,
    },
    ProofPropositionMismatch {
        proof: ProofId,
        value_proposition: ValueId,
        proof_proposition: ValueId,
    },
    UnreachableArenaEntry {
        reference: ArenaReference,
    },
}

#[derive(Debug, Eq, PartialEq)]
pub struct ValidatedQModule<'module> {
    module: &'module QModule,
}

impl<'module> ValidatedQModule<'module> {
    pub fn module(&self) -> &'module QModule {
        self.module
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GradeOperation {
    Addition,
    Multiplication,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GradeArithmeticError {
    InvalidInterval(GradeInterval),
    Overflow { operation: GradeOperation },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShadowCertificateError {
    InvalidCertificate(String),
    InvalidAst(String),
    MissingExpression(ExpressionId),
    InvalidQCore(ValidationError),
}

pub fn validate_module(module: &QModule) -> Result<ValidatedQModule<'_>, ValidationError> {
    ModuleValidator::new(module).validate()?;
    Ok(ValidatedQModule { module })
}

pub fn shadow_module_from_checked_certificate(
    module_path: &str,
    ast: &Module,
    certificate: &CheckedModuleCertificate,
) -> Result<QModule, ShadowCertificateError> {
    certificate
        .validate()
        .map_err(ShadowCertificateError::InvalidCertificate)?;
    ast.validate().map_err(ShadowCertificateError::InvalidAst)?;
    for (expression, _) in certificate
        .expression_types
        .iter()
        .chain(&certificate.closure_signatures)
    {
        if expression.0 as usize >= ast.arena.expressions.len() {
            return Err(ShadowCertificateError::MissingExpression(*expression));
        }
    }

    let result_span = ast.arena.expression_span(ast.result);
    let roots = ShadowRoots {
        types: &certificate.types,
        result: certificate.result,
        effects: certificate.effects,
        parameter: certificate.parameter,
        expression_types: &certificate.expression_types,
        closure_signatures: &certificate.closure_signatures,
    };
    build_shadow_module(module_path, ast.span, result_span, roots, |expression| {
        ast.arena.expression_span(expression)
    })
}

#[allow(dead_code)]
pub(crate) fn shadow_module_from_sealed_boundary(
    module_path: &str,
    span: Span,
    boundary: &SealedModuleBoundary,
) -> Result<QModule, ShadowCertificateError> {
    boundary
        .validate()
        .map_err(ShadowCertificateError::InvalidCertificate)?;
    let roots = ShadowRoots {
        types: &boundary.types,
        result: boundary.result,
        effects: boundary.effects,
        parameter: boundary.parameter,
        expression_types: &[],
        closure_signatures: &[],
    };
    build_shadow_module(module_path, span, span, roots, |_| span)
}

struct ShadowRoots<'types> {
    types: &'types [FlatTypeNode],
    result: FlatTypeId,
    effects: FlatTypeId,
    parameter: Option<FlatTypeId>,
    expression_types: &'types [(ExpressionId, FlatTypeId)],
    closure_signatures: &'types [(ExpressionId, FlatTypeId)],
}

fn build_shadow_module(
    module_path: &str,
    module_span: Span,
    result_span: Span,
    roots: ShadowRoots<'_>,
    expression_span: impl Fn(ExpressionId) -> Span,
) -> Result<QModule, ShadowCertificateError> {
    let source = SemanticKey(format!("source:{module_path}"));
    let mut origins = Vec::new();
    let mut origin_ids = BTreeMap::new();
    let module_origin = intern_origin(&mut origins, &mut origin_ids, source.clone(), module_span);
    let mut values = roots
        .types
        .iter()
        .map(|type_| ValueNode {
            origin: module_origin,
            term: translate_flat_type(type_),
        })
        .collect::<Vec<_>>();
    let type_universe = ValueId(arena_index(values.len()));
    values.push(ValueNode {
        origin: module_origin,
        term: Value::Universe {
            universe: Universe::TypeUniverse { level: 0 },
        },
    });

    let mut definitions = Vec::new();
    push_shadow_definition(
        &mut definitions,
        module_path,
        "result",
        roots.result,
        result_span,
        &source,
        &mut origins,
        &mut origin_ids,
        type_universe,
    );
    push_shadow_definition(
        &mut definitions,
        module_path,
        "effects",
        roots.effects,
        result_span,
        &source,
        &mut origins,
        &mut origin_ids,
        type_universe,
    );
    if let Some(parameter) = roots.parameter {
        push_shadow_definition(
            &mut definitions,
            module_path,
            "parameter",
            parameter,
            module_span,
            &source,
            &mut origins,
            &mut origin_ids,
            type_universe,
        );
    }
    for (expression, type_) in roots.expression_types {
        push_shadow_definition(
            &mut definitions,
            module_path,
            &format!("expression-type:{}", expression.0),
            *type_,
            expression_span(*expression),
            &source,
            &mut origins,
            &mut origin_ids,
            type_universe,
        );
    }
    for (expression, type_) in roots.closure_signatures {
        push_shadow_definition(
            &mut definitions,
            module_path,
            &format!("closure-signature:{}", expression.0),
            *type_,
            expression_span(*expression),
            &source,
            &mut origins,
            &mut origin_ids,
            type_universe,
        );
    }

    let module = QModule {
        schema_version: QCORE_SCHEMA_VERSION,
        module: SemanticKey(format!("module:{module_path}")),
        effect_parameter_count: 0,
        imports: Vec::new(),
        definitions,
        arena: QArena {
            origins,
            values,
            computations: Vec::new(),
            effect_rows: Vec::new(),
            grades: Vec::new(),
            proofs: Vec::new(),
        },
    };
    validate_module(&module).map_err(ShadowCertificateError::InvalidQCore)?;
    Ok(module)
}

#[allow(clippy::too_many_arguments)]
fn push_shadow_definition(
    definitions: &mut Vec<Definition>,
    module_path: &str,
    role: &str,
    type_: FlatTypeId,
    span: Span,
    source: &SemanticKey,
    origins: &mut Vec<SourceOrigin>,
    origin_ids: &mut BTreeMap<(u32, u32), SourceOriginId>,
    type_universe: ValueId,
) {
    let identity = format!("qcore-shadow:{module_path}:{role}");
    let origin = intern_origin(origins, origin_ids, source.clone(), span);
    definitions.push(Definition {
        reference: DefinitionReference {
            definition: DefinitionKey(identity.clone()),
            semantics: SemanticKey(identity),
            origin,
        },
        body: DefinitionBody::Value {
            value: ValueId(type_.0),
            expected_type: type_universe,
        },
    });
}

fn intern_origin(
    origins: &mut Vec<SourceOrigin>,
    origin_ids: &mut BTreeMap<(u32, u32), SourceOriginId>,
    source: SemanticKey,
    span: Span,
) -> SourceOriginId {
    if let Some(origin) = origin_ids.get(&(span.start, span.end)) {
        return *origin;
    }
    let id = SourceOriginId(arena_index(origins.len()));
    origins.push(SourceOrigin {
        source,
        start: span.start,
        end: span.end,
    });
    origin_ids.insert((span.start, span.end), id);
    id
}

fn translate_flat_type(type_: &FlatTypeNode) -> Value {
    match type_ {
        FlatTypeNode::Rigid(variable) => Value::StructuralRigid {
            variable: *variable,
        },
        FlatTypeNode::Forall { variables, body } => Value::StructuralForall {
            variables: variables.clone(),
            body: ValueId(body.0),
        },
        FlatTypeNode::Range { domain, low, high } => Value::StructuralRange {
            domain: match domain {
                Domain::Int => RangeDomain::Integer,
                Domain::Text => RangeDomain::Text,
                Domain::Float => RangeDomain::Float64,
                Domain::Float32 => RangeDomain::Float32,
            },
            low: translate_scalar_bound(low),
            high: translate_scalar_bound(high),
        },
        FlatTypeNode::Unit => Value::StructuralUnit,
        FlatTypeNode::Function {
            deferred,
            parameter,
            effects,
            result,
        } => Value::StructuralFunction {
            deferred: *deferred,
            parameter: ValueId(parameter.0),
            effects: ValueId(effects.0),
            result: ValueId(result.0),
        },
        FlatTypeNode::Record(fields) => {
            let (labels, field_types) = canonical_labeled_types(fields);
            Value::StructuralRecord {
                labels,
                field_types,
            }
        }
        FlatTypeNode::RecordUpdate { base, fields } => {
            let (labels, field_types) = canonical_labeled_types(fields);
            Value::StructuralRecordUpdate {
                base: ValueId(base.0),
                labels,
                field_types,
            }
        }
        FlatTypeNode::Array(element) => Value::StructuralArray {
            element: ValueId(element.0),
        },
        FlatTypeNode::Region(element) => Value::StructuralRegion {
            element: ValueId(element.0),
        },
        FlatTypeNode::Scratch(element) => Value::StructuralScratch {
            element: ValueId(element.0),
        },
        FlatTypeNode::Variant { cases, open } => {
            let (labels, payload_types) = canonical_labeled_types(cases);
            Value::StructuralVariant {
                labels,
                payload_types,
                open: *open,
            }
        }
        FlatTypeNode::Effects(labels) => Value::StructuralEffects {
            labels: labels.iter().cloned().collect(),
        },
        FlatTypeNode::OpenEffects { labels, tail } => Value::StructuralOpenEffects {
            labels: labels.iter().cloned().collect(),
            tail: ValueId(tail.0),
        },
        FlatTypeNode::Union(members) => Value::StructuralUnion {
            members: members.iter().map(|member| ValueId(member.0)).collect(),
        },
        FlatTypeNode::Opaque(name) => Value::StructuralOpaque { name: name.clone() },
        FlatTypeNode::Top => Value::StructuralTop,
        FlatTypeNode::Bottom => Value::StructuralBottom,
    }
}

fn canonical_labeled_types(fields: &[(String, FlatTypeId)]) -> (Vec<String>, Vec<ValueId>) {
    let mut fields = fields.to_vec();
    fields.sort_by(|left, right| left.0.cmp(&right.0));
    fields
        .into_iter()
        .map(|(label, type_)| (label, ValueId(type_.0)))
        .unzip()
}

fn translate_scalar_bound(bound: &Option<Scalar>) -> ScalarBound {
    match bound {
        None => ScalarBound::Unbounded,
        Some(Scalar::Int(value)) => ScalarBound::Integer {
            decimal: value.to_string(),
        },
        Some(Scalar::Text(value)) => ScalarBound::Text {
            value: value.clone(),
        },
    }
}

pub fn validate_grade_interval(interval: &GradeInterval) -> Result<(), GradeArithmeticError> {
    if let GradeUpperBound::Finite { value } = interval.upper
        && interval.lower > value
    {
        return Err(GradeArithmeticError::InvalidInterval(interval.clone()));
    }
    Ok(())
}

pub fn grade_leq(
    left: &GradeInterval,
    right: &GradeInterval,
) -> Result<bool, GradeArithmeticError> {
    validate_grade_interval(left)?;
    validate_grade_interval(right)?;
    Ok(right.lower <= left.lower && upper_leq(&left.upper, &right.upper))
}

pub fn add_grades(
    left: &GradeInterval,
    right: &GradeInterval,
) -> Result<GradeInterval, GradeArithmeticError> {
    validate_grade_interval(left)?;
    validate_grade_interval(right)?;
    let lower = left
        .lower
        .checked_add(right.lower)
        .ok_or(GradeArithmeticError::Overflow {
            operation: GradeOperation::Addition,
        })?;
    let upper = match (&left.upper, &right.upper) {
        (GradeUpperBound::Finite { value: left }, GradeUpperBound::Finite { value: right }) => {
            let value = left
                .checked_add(*right)
                .ok_or(GradeArithmeticError::Overflow {
                    operation: GradeOperation::Addition,
                })?;
            GradeUpperBound::Finite { value }
        }
        _ => GradeUpperBound::Unbounded,
    };
    Ok(GradeInterval { lower, upper })
}

pub fn multiply_grades(
    left: &GradeInterval,
    right: &GradeInterval,
) -> Result<GradeInterval, GradeArithmeticError> {
    validate_grade_interval(left)?;
    validate_grade_interval(right)?;
    let lower = left
        .lower
        .checked_mul(right.lower)
        .ok_or(GradeArithmeticError::Overflow {
            operation: GradeOperation::Multiplication,
        })?;
    let upper = multiply_upper_bounds(&left.upper, &right.upper)?;
    Ok(GradeInterval { lower, upper })
}

fn upper_leq(left: &GradeUpperBound, right: &GradeUpperBound) -> bool {
    match (left, right) {
        (GradeUpperBound::Finite { value: left }, GradeUpperBound::Finite { value: right }) => {
            left <= right
        }
        (GradeUpperBound::Finite { .. }, GradeUpperBound::Unbounded)
        | (GradeUpperBound::Unbounded, GradeUpperBound::Unbounded) => true,
        (GradeUpperBound::Unbounded, GradeUpperBound::Finite { .. }) => false,
    }
}

fn multiply_upper_bounds(
    left: &GradeUpperBound,
    right: &GradeUpperBound,
) -> Result<GradeUpperBound, GradeArithmeticError> {
    match (left, right) {
        (GradeUpperBound::Finite { value: 0 }, _) | (_, GradeUpperBound::Finite { value: 0 }) => {
            Ok(GradeUpperBound::Finite { value: 0 })
        }
        (GradeUpperBound::Finite { value: left }, GradeUpperBound::Finite { value: right }) => {
            let value = left
                .checked_mul(*right)
                .ok_or(GradeArithmeticError::Overflow {
                    operation: GradeOperation::Multiplication,
                })?;
            Ok(GradeUpperBound::Finite { value })
        }
        _ => Ok(GradeUpperBound::Unbounded),
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum ScopedReference {
    Value(ValueId, u32, Vec<u32>),
    Computation(ComputationId, u32, Vec<u32>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VisitState {
    Unvisited,
    Visiting,
    Complete,
}

struct ModuleValidator<'module> {
    module: &'module QModule,
    definitions: HashMap<String, SemanticKey>,
    effect_states: Vec<VisitState>,
    active_terms: HashSet<ArenaReference>,
    scoped_terms: HashSet<ScopedReference>,
    reachable_origins: Vec<bool>,
    reachable_values: Vec<bool>,
    reachable_computations: Vec<bool>,
    reachable_effect_rows: Vec<bool>,
    reachable_grades: Vec<bool>,
    reachable_proofs: Vec<bool>,
}

impl<'module> ModuleValidator<'module> {
    fn new(module: &'module QModule) -> Self {
        Self {
            module,
            definitions: HashMap::new(),
            effect_states: vec![VisitState::Unvisited; module.arena.effect_rows.len()],
            active_terms: HashSet::new(),
            scoped_terms: HashSet::new(),
            reachable_origins: vec![false; module.arena.origins.len()],
            reachable_values: vec![false; module.arena.values.len()],
            reachable_computations: vec![false; module.arena.computations.len()],
            reachable_effect_rows: vec![false; module.arena.effect_rows.len()],
            reachable_grades: vec![false; module.arena.grades.len()],
            reachable_proofs: vec![false; module.arena.proofs.len()],
        }
    }

    fn validate(&mut self) -> Result<(), ValidationError> {
        self.validate_schema_version()?;
        self.validate_arena_lengths()?;
        self.validate_origins()?;
        self.validate_references()?;
        self.collect_definitions()?;
        self.validate_global_definitions()?;
        self.validate_effect_rows()?;
        self.validate_grades()?;
        self.validate_structural_types()?;
        self.visit_roots()?;
        self.validate_reachability()
    }

    fn validate_schema_version(&self) -> Result<(), ValidationError> {
        if self.module.schema_version != QCORE_SCHEMA_VERSION {
            return Err(ValidationError::SchemaVersion {
                expected: QCORE_SCHEMA_VERSION,
                actual: self.module.schema_version,
            });
        }
        Ok(())
    }

    fn validate_arena_lengths(&self) -> Result<(), ValidationError> {
        for (arena, length) in [
            (ArenaKind::Origin, self.module.arena.origins.len()),
            (ArenaKind::Value, self.module.arena.values.len()),
            (ArenaKind::Computation, self.module.arena.computations.len()),
            (ArenaKind::EffectRow, self.module.arena.effect_rows.len()),
            (ArenaKind::Grade, self.module.arena.grades.len()),
            (ArenaKind::Proof, self.module.arena.proofs.len()),
        ] {
            if length > u32::MAX as usize {
                return Err(ValidationError::ArenaTooLarge { arena, length });
            }
        }
        Ok(())
    }

    fn validate_origins(&self) -> Result<(), ValidationError> {
        for (index, origin) in self.module.arena.origins.iter().enumerate() {
            if origin.start > origin.end {
                return Err(ValidationError::InvalidOriginRange {
                    origin: SourceOriginId(arena_index(index)),
                    start: origin.start,
                    end: origin.end,
                });
            }
        }
        Ok(())
    }

    fn validate_references(&self) -> Result<(), ValidationError> {
        for (index, import) in self.module.imports.iter().enumerate() {
            self.ensure_origin(ReferenceSource::Import(index), import.origin)?;
        }
        for (index, definition) in self.module.definitions.iter().enumerate() {
            let source = ReferenceSource::Definition(index);
            self.ensure_origin(source, definition.reference.origin)?;
            match definition.body {
                DefinitionBody::Value {
                    value,
                    expected_type,
                } => {
                    self.ensure_value(source, value)?;
                    self.ensure_value(source, expected_type)?;
                }
                DefinitionBody::Computation {
                    computation,
                    result_type,
                    effects,
                } => {
                    self.ensure_computation(source, computation)?;
                    self.ensure_value(source, result_type)?;
                    self.ensure_effect_row(source, effects)?;
                }
            }
        }
        for (index, node) in self.module.arena.values.iter().enumerate() {
            let id = ValueId(arena_index(index));
            let source = ReferenceSource::Value(id);
            self.ensure_origin(source, node.origin)?;
            match node.term.clone() {
                Value::BoundVariable { .. }
                | Value::GlobalDefinition { .. }
                | Value::Universe { .. }
                | Value::StructuralRigid { .. }
                | Value::StructuralRange { .. }
                | Value::StructuralUnit
                | Value::StructuralEffects { .. }
                | Value::StructuralOpaque { .. }
                | Value::StructuralTop
                | Value::StructuralBottom => {}
                Value::DependentPi {
                    domain,
                    codomain,
                    effects,
                    grade,
                } => {
                    self.ensure_value(source, domain)?;
                    self.ensure_value(source, codomain)?;
                    self.ensure_effect_row(source, effects)?;
                    self.ensure_grade(source, grade)?;
                }
                Value::DependentSigma { first, second } | Value::Pair { first, second } => {
                    self.ensure_value(source, first)?;
                    self.ensure_value(source, second)?;
                }
                Value::Lambda { body } | Value::Thunk { computation: body } => {
                    self.ensure_computation(source, body)?;
                }
                Value::FirstProjection { pair } | Value::SecondProjection { pair } => {
                    self.ensure_value(source, pair)?;
                }
                Value::EffectRow { row } => self.ensure_effect_row(source, row)?,
                Value::IntervalGrade { grade } => self.ensure_grade(source, grade)?,
                Value::Proof { proof, proposition } => {
                    self.ensure_proof(source, proof)?;
                    self.ensure_value(source, proposition)?;
                }
                Value::StructuralForall { body, .. }
                | Value::StructuralArray { element: body }
                | Value::StructuralRegion { element: body }
                | Value::StructuralScratch { element: body } => {
                    self.ensure_value(source, body)?;
                }
                Value::StructuralFunction {
                    parameter,
                    effects,
                    result,
                    ..
                } => {
                    self.ensure_value(source, parameter)?;
                    self.ensure_value(source, effects)?;
                    self.ensure_value(source, result)?;
                }
                Value::StructuralRecord { field_types, .. }
                | Value::StructuralVariant {
                    payload_types: field_types,
                    ..
                }
                | Value::StructuralUnion {
                    members: field_types,
                } => {
                    for child in field_types {
                        self.ensure_value(source, child)?;
                    }
                }
                Value::StructuralRecordUpdate {
                    base, field_types, ..
                } => {
                    self.ensure_value(source, base)?;
                    for child in field_types {
                        self.ensure_value(source, child)?;
                    }
                }
                Value::StructuralOpenEffects { tail, .. } => {
                    self.ensure_value(source, tail)?;
                }
            }
        }
        for (index, node) in self.module.arena.computations.iter().enumerate() {
            let id = ComputationId(arena_index(index));
            let source = ReferenceSource::Computation(id);
            self.ensure_origin(source, node.origin)?;
            match node.term {
                Computation::ReturnValue { value } | Computation::Force { thunk: value } => {
                    self.ensure_value(source, value)?;
                }
                Computation::LetValue { value, body } => {
                    self.ensure_value(source, value)?;
                    self.ensure_computation(source, body)?;
                }
                Computation::Bind { first, body } => {
                    self.ensure_computation(source, first)?;
                    self.ensure_computation(source, body)?;
                }
                Computation::Apply { function, argument } => {
                    self.ensure_value(source, function)?;
                    self.ensure_value(source, argument)?;
                }
                Computation::Perform { argument, .. } => {
                    self.ensure_value(source, argument)?;
                }
                Computation::Handle { body, handler, .. } => {
                    self.ensure_computation(source, body)?;
                    self.ensure_value(source, handler)?;
                }
            }
        }
        for (index, node) in self.module.arena.effect_rows.iter().enumerate() {
            let id = EffectRowId(arena_index(index));
            let source = ReferenceSource::EffectRow(id);
            self.ensure_origin(source, node.origin)?;
            if let EffectRow::Extend { tail, .. } = node.row {
                self.ensure_effect_row(source, tail)?;
            }
        }
        for (index, node) in self.module.arena.grades.iter().enumerate() {
            let id = GradeId(arena_index(index));
            self.ensure_origin(ReferenceSource::Grade(id), node.origin)?;
        }
        for (index, proof) in self.module.arena.proofs.iter().enumerate() {
            let slot = ProofId(arena_index(index));
            if proof.proof != slot {
                return Err(ValidationError::ProofSlotMismatch {
                    slot,
                    declared: proof.proof,
                });
            }
            let source = ReferenceSource::Proof(slot);
            self.ensure_origin(source, proof.origin)?;
            self.ensure_value(source, proof.proposition)?;
        }
        Ok(())
    }

    fn collect_definitions(&mut self) -> Result<(), ValidationError> {
        for reference in self.module.imports.iter().chain(
            self.module
                .definitions
                .iter()
                .map(|definition| &definition.reference),
        ) {
            if self
                .definitions
                .insert(reference.definition.0.clone(), reference.semantics.clone())
                .is_some()
            {
                return Err(ValidationError::DuplicateDefinition {
                    definition: reference.definition.clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_global_definitions(&self) -> Result<(), ValidationError> {
        for node in &self.module.arena.values {
            let Value::GlobalDefinition {
                definition,
                semantics,
            } = &node.term
            else {
                continue;
            };
            let Some(expected) = self.definitions.get(&definition.0) else {
                return Err(ValidationError::UnknownDefinition {
                    definition: definition.clone(),
                    semantics: semantics.clone(),
                });
            };
            if expected != semantics {
                return Err(ValidationError::DefinitionSemanticMismatch {
                    definition: definition.clone(),
                    expected: expected.clone(),
                    actual: semantics.clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_effect_rows(&mut self) -> Result<(), ValidationError> {
        for index in 0..self.module.arena.effect_rows.len() {
            self.validate_effect_row(EffectRowId(arena_index(index)))?;
        }
        Ok(())
    }

    fn validate_effect_row(&mut self, id: EffectRowId) -> Result<(), ValidationError> {
        let index = arena_offset(id.0);
        match self.effect_states[index] {
            VisitState::Complete => return Ok(()),
            VisitState::Visiting => {
                return Err(ValidationError::DirectArenaCycle {
                    reference: ArenaReference::EffectRow(id),
                });
            }
            VisitState::Unvisited => {}
        }
        self.effect_states[index] = VisitState::Visiting;
        match self.module.arena.effect_rows[index].row.clone() {
            EffectRow::Empty => {}
            EffectRow::Variable { index } => {
                if index >= self.module.effect_parameter_count {
                    return Err(ValidationError::EffectVariableOutOfScope {
                        row: id,
                        index,
                        parameter_count: self.module.effect_parameter_count,
                    });
                }
            }
            EffectRow::Extend { effect, tail } => {
                let tail_node = &self.module.arena.effect_rows[arena_offset(tail.0)];
                if let EffectRow::Extend {
                    effect: next_effect,
                    ..
                } = &tail_node.row
                    && effect.0 >= next_effect.0
                {
                    return Err(ValidationError::EffectRowNotCanonical {
                        row: id,
                        effect,
                        next_effect: next_effect.clone(),
                    });
                }
                self.validate_effect_row(tail)?;
            }
        }
        self.effect_states[index] = VisitState::Complete;
        Ok(())
    }

    fn validate_grades(&self) -> Result<(), ValidationError> {
        for (index, node) in self.module.arena.grades.iter().enumerate() {
            if validate_grade_interval(&node.interval).is_err() {
                return Err(ValidationError::InvalidGrade {
                    grade: GradeId(arena_index(index)),
                    lower: node.interval.lower,
                    upper: node.interval.upper.clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_structural_types(&self) -> Result<(), ValidationError> {
        for (index, node) in self.module.arena.values.iter().enumerate() {
            let value = ValueId(arena_index(index));
            match &node.term {
                Value::StructuralRecord {
                    labels,
                    field_types,
                }
                | Value::StructuralRecordUpdate {
                    labels,
                    field_types,
                    ..
                } => {
                    self.validate_labeled_types(value, labels, field_types.len())?;
                }
                Value::StructuralVariant {
                    labels,
                    payload_types,
                    ..
                } => {
                    self.validate_labeled_types(value, labels, payload_types.len())?;
                }
                Value::StructuralEffects { labels }
                | Value::StructuralOpenEffects { labels, .. } => {
                    self.validate_canonical_labels(value, labels)?;
                }
                Value::StructuralRange { domain, low, high } => {
                    self.validate_structural_range(value, domain, low, high)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn validate_labeled_types(
        &self,
        value: ValueId,
        labels: &[String],
        type_count: usize,
    ) -> Result<(), ValidationError> {
        if labels.len() != type_count {
            return Err(ValidationError::LabeledTypeLengthMismatch {
                value,
                labels: labels.len(),
                types: type_count,
            });
        }
        self.validate_canonical_labels(value, labels)
    }

    fn validate_canonical_labels(
        &self,
        value: ValueId,
        labels: &[String],
    ) -> Result<(), ValidationError> {
        for pair in labels.windows(2) {
            if pair[0] >= pair[1] {
                return Err(ValidationError::StructuralLabelsNotCanonical {
                    value,
                    label: pair[0].clone(),
                    next_label: pair[1].clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_structural_range(
        &self,
        value: ValueId,
        domain: &RangeDomain,
        low: &ScalarBound,
        high: &ScalarBound,
    ) -> Result<(), ValidationError> {
        let valid = match domain {
            RangeDomain::Integer => {
                match (canonical_integer_bound(low), canonical_integer_bound(high)) {
                    (Some(Some(low)), Some(Some(high))) => low <= high,
                    (Some(_), Some(_)) => true,
                    _ => false,
                }
            }
            RangeDomain::Text => match (low, high) {
                (ScalarBound::Unbounded, ScalarBound::Unbounded)
                | (ScalarBound::Unbounded, ScalarBound::Text { .. })
                | (ScalarBound::Text { .. }, ScalarBound::Unbounded) => true,
                (ScalarBound::Text { value: low }, ScalarBound::Text { value: high }) => {
                    low <= high
                }
                _ => false,
            },
            RangeDomain::Float64 | RangeDomain::Float32 => {
                matches!(low, ScalarBound::Unbounded) && matches!(high, ScalarBound::Unbounded)
            }
        };
        if !valid {
            return Err(ValidationError::InvalidStructuralRange {
                value,
                domain: domain.clone(),
                low: low.clone(),
                high: high.clone(),
            });
        }
        Ok(())
    }

    fn visit_roots(&mut self) -> Result<(), ValidationError> {
        for (index, import) in self.module.imports.iter().enumerate() {
            self.mark_origin(ReferenceSource::Import(index), import.origin)?;
        }
        for index in 0..self.module.definitions.len() {
            let definition = self.module.definitions[index].clone();
            self.mark_origin(
                ReferenceSource::Definition(index),
                definition.reference.origin,
            )?;
            match definition.body {
                DefinitionBody::Value {
                    value,
                    expected_type,
                } => {
                    self.visit_value(value, 0, &[])?;
                    self.visit_value(expected_type, 0, &[])?;
                }
                DefinitionBody::Computation {
                    computation,
                    result_type,
                    effects,
                } => {
                    self.visit_computation(computation, 0, &[])?;
                    self.visit_value(result_type, 0, &[])?;
                    self.visit_effect_row(effects)?;
                }
            }
        }
        Ok(())
    }

    fn visit_value(
        &mut self,
        id: ValueId,
        depth: u32,
        rigids: &[u32],
    ) -> Result<(), ValidationError> {
        let reference = ArenaReference::Value(id);
        if self.active_terms.contains(&reference) {
            return Err(ValidationError::DirectArenaCycle { reference });
        }
        if !self
            .scoped_terms
            .insert(ScopedReference::Value(id, depth, rigids.to_vec()))
        {
            return Ok(());
        }
        self.active_terms.insert(reference);
        let index = arena_offset(id.0);
        self.reachable_values[index] = true;
        let node = self.module.arena.values[index].clone();
        self.mark_origin(ReferenceSource::Value(id), node.origin)?;
        match node.term {
            Value::BoundVariable { index } => {
                if index >= depth {
                    return Err(ValidationError::BoundVariableOutOfScope {
                        value: id,
                        index,
                        depth,
                    });
                }
            }
            Value::GlobalDefinition { .. }
            | Value::Universe { .. }
            | Value::StructuralRange { .. }
            | Value::StructuralUnit
            | Value::StructuralEffects { .. }
            | Value::StructuralOpaque { .. }
            | Value::StructuralTop
            | Value::StructuralBottom => {}
            Value::StructuralRigid { variable } => {
                if !rigids.contains(&variable) {
                    return Err(ValidationError::StructuralRigidOutOfScope {
                        value: id,
                        variable,
                    });
                }
            }
            Value::DependentPi {
                domain,
                codomain,
                effects,
                grade,
            } => {
                self.visit_value(domain, depth, rigids)?;
                self.visit_value(codomain, self.next_depth(reference, depth)?, rigids)?;
                self.visit_effect_row(effects)?;
                self.visit_grade(grade)?;
            }
            Value::DependentSigma { first, second } => {
                self.visit_value(first, depth, rigids)?;
                self.visit_value(second, self.next_depth(reference, depth)?, rigids)?;
            }
            Value::Lambda { body } => {
                self.visit_computation(body, self.next_depth(reference, depth)?, rigids)?;
            }
            Value::Pair { first, second } => {
                self.visit_value(first, depth, rigids)?;
                self.visit_value(second, depth, rigids)?;
            }
            Value::FirstProjection { pair } | Value::SecondProjection { pair } => {
                self.visit_value(pair, depth, rigids)?;
            }
            Value::Thunk { computation } => self.visit_computation(computation, depth, rigids)?,
            Value::EffectRow { row } => self.visit_effect_row(row)?,
            Value::IntervalGrade { grade } => self.visit_grade(grade)?,
            Value::Proof { proof, proposition } => {
                let proof_reference = self.module.arena.proofs[arena_offset(proof.0)].clone();
                if proposition != proof_reference.proposition {
                    return Err(ValidationError::ProofPropositionMismatch {
                        proof,
                        value_proposition: proposition,
                        proof_proposition: proof_reference.proposition,
                    });
                }
                self.visit_proof(proof, depth, rigids)?;
            }
            Value::StructuralForall { variables, body } => {
                let mut extended = rigids.to_vec();
                for variable in variables {
                    if extended.contains(&variable) {
                        return Err(ValidationError::DuplicateStructuralBinder {
                            value: id,
                            variable,
                        });
                    }
                    extended.push(variable);
                }
                self.visit_value(body, depth, &extended)?;
            }
            Value::StructuralFunction {
                parameter,
                effects,
                result,
                ..
            } => {
                self.visit_value(parameter, depth, rigids)?;
                self.visit_value(effects, depth, rigids)?;
                self.visit_value(result, depth, rigids)?;
            }
            Value::StructuralRecord { field_types, .. }
            | Value::StructuralVariant {
                payload_types: field_types,
                ..
            }
            | Value::StructuralUnion {
                members: field_types,
            } => {
                for child in field_types {
                    self.visit_value(child, depth, rigids)?;
                }
            }
            Value::StructuralRecordUpdate {
                base, field_types, ..
            } => {
                self.visit_value(base, depth, rigids)?;
                for child in field_types {
                    self.visit_value(child, depth, rigids)?;
                }
            }
            Value::StructuralArray { element }
            | Value::StructuralRegion { element }
            | Value::StructuralScratch { element } => {
                self.visit_value(element, depth, rigids)?;
            }
            Value::StructuralOpenEffects { tail, .. } => {
                self.visit_value(tail, depth, rigids)?;
            }
        }
        self.active_terms.remove(&reference);
        Ok(())
    }

    fn visit_computation(
        &mut self,
        id: ComputationId,
        depth: u32,
        rigids: &[u32],
    ) -> Result<(), ValidationError> {
        let reference = ArenaReference::Computation(id);
        if self.active_terms.contains(&reference) {
            return Err(ValidationError::DirectArenaCycle { reference });
        }
        if !self
            .scoped_terms
            .insert(ScopedReference::Computation(id, depth, rigids.to_vec()))
        {
            return Ok(());
        }
        self.active_terms.insert(reference);
        let index = arena_offset(id.0);
        self.reachable_computations[index] = true;
        let node = self.module.arena.computations[index].clone();
        self.mark_origin(ReferenceSource::Computation(id), node.origin)?;
        match node.term {
            Computation::ReturnValue { value } | Computation::Force { thunk: value } => {
                self.visit_value(value, depth, rigids)?;
            }
            Computation::LetValue { value, body } => {
                self.visit_value(value, depth, rigids)?;
                self.visit_computation(body, self.next_depth(reference, depth)?, rigids)?;
            }
            Computation::Bind { first, body } => {
                self.visit_computation(first, depth, rigids)?;
                self.visit_computation(body, self.next_depth(reference, depth)?, rigids)?;
            }
            Computation::Apply { function, argument } => {
                self.visit_value(function, depth, rigids)?;
                self.visit_value(argument, depth, rigids)?;
            }
            Computation::Perform { argument, .. } => self.visit_value(argument, depth, rigids)?,
            Computation::Handle { body, handler, .. } => {
                self.visit_computation(body, depth, rigids)?;
                self.visit_value(handler, depth, rigids)?;
            }
        }
        self.active_terms.remove(&reference);
        Ok(())
    }

    fn visit_effect_row(&mut self, id: EffectRowId) -> Result<(), ValidationError> {
        let index = arena_offset(id.0);
        if self.reachable_effect_rows[index] {
            return Ok(());
        }
        self.reachable_effect_rows[index] = true;
        let node = self.module.arena.effect_rows[index].clone();
        self.mark_origin(ReferenceSource::EffectRow(id), node.origin)?;
        if let EffectRow::Extend { tail, .. } = node.row {
            self.visit_effect_row(tail)?;
        }
        Ok(())
    }

    fn visit_grade(&mut self, id: GradeId) -> Result<(), ValidationError> {
        let index = arena_offset(id.0);
        if self.reachable_grades[index] {
            return Ok(());
        }
        self.reachable_grades[index] = true;
        let origin = self.module.arena.grades[index].origin;
        self.mark_origin(ReferenceSource::Grade(id), origin)
    }

    fn visit_proof(
        &mut self,
        id: ProofId,
        depth: u32,
        rigids: &[u32],
    ) -> Result<(), ValidationError> {
        let index = arena_offset(id.0);
        self.reachable_proofs[index] = true;
        let proof = self.module.arena.proofs[index].clone();
        self.mark_origin(ReferenceSource::Proof(id), proof.origin)?;
        self.visit_value(proof.proposition, depth, rigids)
    }

    fn mark_origin(
        &mut self,
        source: ReferenceSource,
        id: SourceOriginId,
    ) -> Result<(), ValidationError> {
        self.ensure_origin(source, id)?;
        self.reachable_origins[arena_offset(id.0)] = true;
        Ok(())
    }

    fn next_depth(&self, source: ArenaReference, depth: u32) -> Result<u32, ValidationError> {
        depth
            .checked_add(1)
            .ok_or(ValidationError::BindingDepthOverflow { source })
    }

    fn validate_reachability(&self) -> Result<(), ValidationError> {
        for (index, reachable) in self.reachable_origins.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::Origin(SourceOriginId(arena_index(index))),
                });
            }
        }
        for (index, reachable) in self.reachable_values.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::Value(ValueId(arena_index(index))),
                });
            }
        }
        for (index, reachable) in self.reachable_computations.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::Computation(ComputationId(arena_index(index))),
                });
            }
        }
        for (index, reachable) in self.reachable_effect_rows.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::EffectRow(EffectRowId(arena_index(index))),
                });
            }
        }
        for (index, reachable) in self.reachable_grades.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::Grade(GradeId(arena_index(index))),
                });
            }
        }
        for (index, reachable) in self.reachable_proofs.iter().enumerate() {
            if !reachable {
                return Err(ValidationError::UnreachableArenaEntry {
                    reference: ArenaReference::Proof(ProofId(arena_index(index))),
                });
            }
        }
        Ok(())
    }

    fn ensure_origin(
        &self,
        source: ReferenceSource,
        id: SourceOriginId,
    ) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::Origin(id),
            self.module.arena.origins.len(),
            id.0,
        )
    }

    fn ensure_value(&self, source: ReferenceSource, id: ValueId) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::Value(id),
            self.module.arena.values.len(),
            id.0,
        )
    }

    fn ensure_computation(
        &self,
        source: ReferenceSource,
        id: ComputationId,
    ) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::Computation(id),
            self.module.arena.computations.len(),
            id.0,
        )
    }

    fn ensure_effect_row(
        &self,
        source: ReferenceSource,
        id: EffectRowId,
    ) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::EffectRow(id),
            self.module.arena.effect_rows.len(),
            id.0,
        )
    }

    fn ensure_grade(&self, source: ReferenceSource, id: GradeId) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::Grade(id),
            self.module.arena.grades.len(),
            id.0,
        )
    }

    fn ensure_proof(&self, source: ReferenceSource, id: ProofId) -> Result<(), ValidationError> {
        self.ensure_reference(
            source,
            ArenaReference::Proof(id),
            self.module.arena.proofs.len(),
            id.0,
        )
    }

    fn ensure_reference(
        &self,
        source: ReferenceSource,
        target: ArenaReference,
        length: usize,
        index: u32,
    ) -> Result<(), ValidationError> {
        if arena_offset(index) >= length {
            return Err(ValidationError::MissingReference { source, target });
        }
        Ok(())
    }
}

fn arena_index(index: usize) -> u32 {
    u32::try_from(index).expect("QCore arena length was checked before indexing")
}

fn arena_offset(index: u32) -> usize {
    usize::try_from(index).expect("QCore u32 indices fit every supported target")
}

fn canonical_integer_bound(bound: &ScalarBound) -> Option<Option<BigInt>> {
    match bound {
        ScalarBound::Unbounded => Some(None),
        ScalarBound::Integer { decimal } => {
            let value = decimal.parse::<BigInt>().ok()?;
            if value.to_string() != *decimal {
                return None;
            }
            Some(Some(value))
        }
        ScalarBound::Text { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::rc::Rc;

    use crate::ast::{AstArena, Expression, ResultEffects};
    use crate::eval::{Context, LoadedModule};
    use crate::qcore_generated::{
        ComputationNode, Definition, DefinitionReference, EffectRowNode, GradeNode, ProofReference,
        QArena, SourceOrigin, Universe, ValueNode, ValueTag,
    };
    use crate::typecheck::{CHECKED_MODULE_CERTIFICATE_SCHEMA, Checker};

    use super::*;

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

    fn empty_arena() -> QArena {
        QArena {
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
        }
    }

    fn module_with_value_root(values: Vec<ValueNode>, root: ValueId) -> QModule {
        let mut arena = empty_arena();
        arena.values = values;
        QModule {
            schema_version: QCORE_SCHEMA_VERSION,
            module: semantic_key("module:test"),
            effect_parameter_count: 0,
            imports: Vec::new(),
            definitions: vec![Definition {
                reference: definition_reference("root"),
                body: DefinitionBody::Value {
                    value: root,
                    expected_type: root,
                },
            }],
            arena,
        }
    }

    fn value(term: Value) -> ValueNode {
        ValueNode {
            origin: SourceOriginId(0),
            term,
        }
    }

    #[test]
    fn structural_rigid_requires_its_nominal_forall_scope() {
        let module = module_with_value_root(
            vec![value(Value::StructuralRigid { variable: 7 })],
            ValueId(0),
        );

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::StructuralRigidOutOfScope {
                value: ValueId(0),
                variable: 7,
            }),
        );
    }

    #[test]
    fn structural_record_labels_must_be_canonical() {
        let module = module_with_value_root(
            vec![
                value(Value::StructuralUnit),
                value(Value::StructuralRecord {
                    labels: vec!["z".to_owned(), "a".to_owned()],
                    field_types: vec![ValueId(0), ValueId(0)],
                }),
            ],
            ValueId(1),
        );

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::StructuralLabelsNotCanonical {
                value: ValueId(1),
                label: "z".to_owned(),
                next_label: "a".to_owned(),
            }),
        );
    }

    #[test]
    fn checked_certificate_shadow_preserves_the_complete_flat_type_algebra() {
        let types = vec![
            FlatTypeNode::Rigid(7),
            FlatTypeNode::Forall {
                variables: vec![7],
                body: FlatTypeId(0),
            },
            FlatTypeNode::Range {
                domain: Domain::Int,
                low: Some(Scalar::Int(
                    "-18446744073709551617".parse().expect("integer bound"),
                )),
                high: Some(Scalar::Int(
                    "18446744073709551617".parse().expect("integer bound"),
                )),
            },
            FlatTypeNode::Range {
                domain: Domain::Text,
                low: Some(Scalar::Text("a".to_owned())),
                high: Some(Scalar::Text("z".to_owned())),
            },
            FlatTypeNode::Range {
                domain: Domain::Float,
                low: None,
                high: None,
            },
            FlatTypeNode::Range {
                domain: Domain::Float32,
                low: None,
                high: None,
            },
            FlatTypeNode::Unit,
            FlatTypeNode::Effects(BTreeSet::from(["Console".to_owned()])),
            FlatTypeNode::OpenEffects {
                labels: BTreeSet::from(["Clock".to_owned()]),
                tail: FlatTypeId(7),
            },
            FlatTypeNode::Function {
                deferred: true,
                parameter: FlatTypeId(2),
                effects: FlatTypeId(8),
                result: FlatTypeId(1),
            },
            FlatTypeNode::Record(vec![
                ("z".to_owned(), FlatTypeId(3)),
                ("a".to_owned(), FlatTypeId(2)),
            ]),
            FlatTypeNode::RecordUpdate {
                base: FlatTypeId(10),
                fields: vec![("f".to_owned(), FlatTypeId(4))],
            },
            FlatTypeNode::Array(FlatTypeId(2)),
            FlatTypeNode::Region(FlatTypeId(3)),
            FlatTypeNode::Scratch(FlatTypeId(4)),
            FlatTypeNode::Variant {
                cases: vec![
                    ("Some".to_owned(), FlatTypeId(2)),
                    ("None".to_owned(), FlatTypeId(6)),
                ],
                open: true,
            },
            FlatTypeNode::Opaque("SIMD.F32x4".to_owned()),
            FlatTypeNode::Top,
            FlatTypeNode::Bottom,
            FlatTypeNode::Union((1..19).map(FlatTypeId).collect()),
        ];
        let certificate = CheckedModuleCertificate {
            schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types,
            result: FlatTypeId(19),
            effects: FlatTypeId(8),
            parameter: None,
            expression_types: vec![(ExpressionId(0), FlatTypeId(19))],
            closure_signatures: Vec::new(),
            recursive_closures: Vec::new(),
            ownership_contracts: Vec::new(),
            simplifications: Vec::new(),
            readability: Vec::new(),
        };
        let mut arena = AstArena::default();
        let result = arena.expression(Expression::Unit {
            span: Span { start: 10, end: 12 },
        });
        let ast = Module {
            parameter: None,
            declarations: Vec::new(),
            result,
            result_effects: ResultEffects::Pure,
            span: Span { start: 0, end: 20 },
            arena,
        };

        let module = shadow_module_from_checked_certificate("example.blot", &ast, &certificate)
            .expect("complete closed certificate must translate");

        for tag in [
            ValueTag::StructuralRigid,
            ValueTag::StructuralForall,
            ValueTag::StructuralRange,
            ValueTag::StructuralUnit,
            ValueTag::StructuralFunction,
            ValueTag::StructuralRecord,
            ValueTag::StructuralRecordUpdate,
            ValueTag::StructuralArray,
            ValueTag::StructuralRegion,
            ValueTag::StructuralScratch,
            ValueTag::StructuralVariant,
            ValueTag::StructuralEffects,
            ValueTag::StructuralOpenEffects,
            ValueTag::StructuralUnion,
            ValueTag::StructuralOpaque,
            ValueTag::StructuralTop,
            ValueTag::StructuralBottom,
        ] {
            assert!(
                module
                    .arena
                    .values
                    .iter()
                    .any(|node| node.term.tag() == tag),
                "missing translated constructor {tag:?}"
            );
        }
        assert!(matches!(
            &module.arena.values[2].term,
            Value::StructuralRange {
                low: ScalarBound::Integer { decimal },
                high: ScalarBound::Integer { decimal: high },
                ..
            } if decimal == "-18446744073709551617" && high == "18446744073709551617"
        ));
        assert!(matches!(
            &module.arena.values[10].term,
            Value::StructuralRecord { labels, .. } if labels == &["a", "z"]
        ));
        assert!(matches!(
            &module.arena.values[8].term,
            Value::StructuralOpenEffects { labels, tail }
                if labels == &["Clock"] && *tail == ValueId(7)
        ));
        assert!(matches!(
            &module.arena.values[9].term,
            Value::StructuralFunction { deferred: true, .. }
        ));
        assert!(matches!(
            &module.arena.values[15].term,
            Value::StructuralVariant { labels, open: true, .. }
                if labels == &["None", "Some"]
        ));
        assert!(matches!(
            &module.arena.values[20].term,
            Value::Universe {
                universe: Universe::TypeUniverse { level: 0 }
            }
        ));
        let result_origin = module.definitions[0].reference.origin;
        assert_eq!(module.arena.origins[result_origin.0 as usize].start, 10);
        assert_eq!(module.arena.origins[result_origin.0 as usize].end, 12);
        assert_eq!(module.arena.origins[0].source.0, "source:example.blot");
    }

    #[test]
    fn sealed_boundary_shadow_uses_a_real_supplied_origin() {
        let boundary = SealedModuleBoundary {
            schema: 1,
            compiler_semantic_version: env!("CARGO_PKG_VERSION").to_owned(),
            certificate_schema: CHECKED_MODULE_CERTIFICATE_SCHEMA,
            types: vec![FlatTypeNode::Unit, FlatTypeNode::Effects(BTreeSet::new())],
            result: FlatTypeId(0),
            effects: FlatTypeId(1),
            parameter: None,
        };

        let module = shadow_module_from_sealed_boundary(
            "sealed.blot",
            Span { start: 4, end: 21 },
            &boundary,
        )
        .expect("sealed boundary must translate");

        assert_eq!(module.arena.origins.len(), 1);
        assert_eq!(module.arena.origins[0].source.0, "source:sealed.blot");
        assert_eq!(module.arena.origins[0].start, 4);
        assert_eq!(module.arena.origins[0].end, 21);
    }

    #[test]
    fn accepted_source_corpus_produces_valid_shadow_certificates() {
        for (path, source) in [
            ("literal.blot", "return 42\n"),
            ("text.blot", "return \"blot\"\n"),
            ("float.blot", "return 3.5\n"),
            ("array.blot", "return [1, 2, 3]\n"),
            ("record.blot", "return { .number = 1; .label = \"one\"; }\n"),
            ("variant.blot", "return (#Some 1)\n"),
            (
                "record-update.blot",
                "let value = { .x = 1; }\nreturn { ...value; .tag = 2; }\n",
            ),
            ("identity.blot", "return fn value => value\n"),
            ("deferred.blot", "return fn ~value => value\n"),
        ] {
            let lowered =
                crate::source::lower_incremental(&source.encode_utf16().collect::<Vec<_>>(), None)
                    .expect("representative source must lower");
            let ast = lowered.module;
            let context = Rc::new(Context::default());
            context.modules.borrow_mut().insert(
                path.to_owned(),
                LoadedModule::new(
                    path,
                    Rc::new(ast.clone()),
                    Default::default(),
                    Default::default(),
                ),
            );
            let checker = Checker::new(context);
            let certificate = checker
                .certificate(path)
                .expect("representative source must have a closed certificate");

            shadow_module_from_checked_certificate(path, &ast, &certificate)
                .expect("representative source shadow must validate");
        }
    }

    #[test]
    fn lambda_binds_its_computation_body() {
        let mut module = module_with_value_root(
            vec![
                value(Value::BoundVariable { index: 0 }),
                value(Value::Lambda {
                    body: ComputationId(0),
                }),
            ],
            ValueId(1),
        );
        module.arena.computations.push(ComputationNode {
            origin: SourceOriginId(0),
            term: Computation::ReturnValue { value: ValueId(0) },
        });

        let validated = validate_module(&module).expect("closed lambda must validate");
        assert_eq!(validated.module(), &module);
    }

    #[test]
    fn computation_definition_reaches_its_result_type_and_effect_row() {
        let mut arena = empty_arena();
        arena.values.push(value(Value::Universe {
            universe: Universe::Prop,
        }));
        arena.computations.push(ComputationNode {
            origin: SourceOriginId(0),
            term: Computation::ReturnValue { value: ValueId(0) },
        });
        arena.effect_rows.push(EffectRowNode {
            origin: SourceOriginId(0),
            row: EffectRow::Empty,
        });
        let module = QModule {
            schema_version: QCORE_SCHEMA_VERSION,
            module: semantic_key("module:test"),
            effect_parameter_count: 0,
            imports: Vec::new(),
            definitions: vec![Definition {
                reference: definition_reference("root"),
                body: DefinitionBody::Computation {
                    computation: ComputationId(0),
                    result_type: ValueId(0),
                    effects: EffectRowId(0),
                },
            }],
            arena,
        };

        validate_module(&module).expect("closed computation boundary must validate");
    }

    #[test]
    fn value_definition_checks_its_expected_type_at_closed_scope() {
        let module = module_with_value_root(
            vec![
                value(Value::Universe {
                    universe: Universe::Prop,
                }),
                value(Value::BoundVariable { index: 0 }),
            ],
            ValueId(0),
        );
        let mut module = module;
        module.definitions[0].body = DefinitionBody::Value {
            value: ValueId(0),
            expected_type: ValueId(1),
        };

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::BoundVariableOutOfScope {
                value: ValueId(1),
                index: 0,
                depth: 0,
            }),
        );
    }

    #[test]
    fn closed_root_rejects_a_free_bound_variable() {
        let module =
            module_with_value_root(vec![value(Value::BoundVariable { index: 0 })], ValueId(0));

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::BoundVariableOutOfScope {
                value: ValueId(0),
                index: 0,
                depth: 0,
            }),
        );
    }

    #[test]
    fn missing_arena_reference_identifies_its_source_and_target() {
        let module = module_with_value_root(
            vec![value(Value::Pair {
                first: ValueId(7),
                second: ValueId(0),
            })],
            ValueId(0),
        );

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::MissingReference {
                source: ReferenceSource::Value(ValueId(0)),
                target: ArenaReference::Value(ValueId(7)),
            }),
        );
    }

    #[test]
    fn global_definition_must_match_a_declared_semantic_identity() {
        let mut module = module_with_value_root(
            vec![value(Value::GlobalDefinition {
                definition: DefinitionKey("external".to_owned()),
                semantics: semantic_key("semantic:wrong"),
            })],
            ValueId(0),
        );
        module.imports.push(definition_reference("external"));

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::DefinitionSemanticMismatch {
                definition: DefinitionKey("external".to_owned()),
                expected: semantic_key("semantic:external"),
                actual: semantic_key("semantic:wrong"),
            }),
        );
    }

    #[test]
    fn direct_value_computation_cycle_is_rejected() {
        let mut module = module_with_value_root(
            vec![value(Value::Thunk {
                computation: ComputationId(0),
            })],
            ValueId(0),
        );
        module.arena.computations.push(ComputationNode {
            origin: SourceOriginId(0),
            term: Computation::ReturnValue { value: ValueId(0) },
        });

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::DirectArenaCycle {
                reference: ArenaReference::Value(ValueId(0)),
            }),
        );
    }

    #[test]
    fn effect_extensions_validate_in_strict_key_order() {
        let mut module = module_with_value_root(
            vec![value(Value::EffectRow {
                row: EffectRowId(0),
            })],
            ValueId(0),
        );
        module.arena.effect_rows = vec![
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Extend {
                    effect: semantic_key("effect:a"),
                    tail: EffectRowId(1),
                },
            },
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Extend {
                    effect: semantic_key("effect:b"),
                    tail: EffectRowId(2),
                },
            },
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Empty,
            },
        ];

        validate_module(&module).expect("strictly ordered effect row must validate");
    }

    #[test]
    fn effect_extensions_reject_duplicate_or_descending_keys() {
        let mut module = module_with_value_root(
            vec![value(Value::EffectRow {
                row: EffectRowId(0),
            })],
            ValueId(0),
        );
        module.arena.effect_rows = vec![
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Extend {
                    effect: semantic_key("effect:b"),
                    tail: EffectRowId(1),
                },
            },
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Extend {
                    effect: semantic_key("effect:a"),
                    tail: EffectRowId(2),
                },
            },
            EffectRowNode {
                origin: SourceOriginId(0),
                row: EffectRow::Empty,
            },
        ];

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::EffectRowNotCanonical {
                row: EffectRowId(0),
                effect: semantic_key("effect:b"),
                next_effect: semantic_key("effect:a"),
            }),
        );
    }

    #[test]
    fn effect_variable_uses_the_module_parameter_scope() {
        let mut module = module_with_value_root(
            vec![value(Value::EffectRow {
                row: EffectRowId(0),
            })],
            ValueId(0),
        );
        module.arena.effect_rows.push(EffectRowNode {
            origin: SourceOriginId(0),
            row: EffectRow::Variable { index: 0 },
        });

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::EffectVariableOutOfScope {
                row: EffectRowId(0),
                index: 0,
                parameter_count: 0,
            }),
        );
        module.effect_parameter_count = 1;
        validate_module(&module).expect("declared effect parameter must be in scope");
    }

    #[test]
    fn unreachable_arena_entry_is_rejected() {
        let module = module_with_value_root(
            vec![
                value(Value::Universe {
                    universe: Universe::Prop,
                }),
                value(Value::Universe {
                    universe: Universe::Prop,
                }),
            ],
            ValueId(0),
        );

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::UnreachableArenaEntry {
                reference: ArenaReference::Value(ValueId(1)),
            }),
        );
    }

    #[test]
    fn proof_value_and_proof_record_must_name_the_same_proposition() {
        let mut module = module_with_value_root(
            vec![
                value(Value::Proof {
                    proof: ProofId(0),
                    proposition: ValueId(1),
                }),
                value(Value::Universe {
                    universe: Universe::Prop,
                }),
            ],
            ValueId(0),
        );
        module.arena.proofs.push(ProofReference {
            proof: ProofId(0),
            proposition: ValueId(0),
            origin: SourceOriginId(0),
        });

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::ProofPropositionMismatch {
                proof: ProofId(0),
                value_proposition: ValueId(1),
                proof_proposition: ValueId(0),
            }),
        );
    }

    #[test]
    fn finite_grade_order_is_interval_containment() {
        let narrow = GradeInterval {
            lower: 1,
            upper: GradeUpperBound::Finite { value: 2 },
        };
        let wide = GradeInterval {
            lower: 0,
            upper: GradeUpperBound::Finite { value: 3 },
        };

        assert_eq!(grade_leq(&narrow, &wide), Ok(true));
        assert_eq!(grade_leq(&wide, &narrow), Ok(false));
    }

    #[test]
    fn grade_operations_preserve_finite_bounds() {
        let left = GradeInterval {
            lower: 1,
            upper: GradeUpperBound::Finite { value: 2 },
        };
        let right = GradeInterval {
            lower: 3,
            upper: GradeUpperBound::Finite { value: 4 },
        };

        assert_eq!(
            add_grades(&left, &right),
            Ok(GradeInterval {
                lower: 4,
                upper: GradeUpperBound::Finite { value: 6 },
            }),
        );
        assert_eq!(
            multiply_grades(&left, &right),
            Ok(GradeInterval {
                lower: 3,
                upper: GradeUpperBound::Finite { value: 8 },
            }),
        );
    }

    #[test]
    fn zero_times_unbounded_grade_is_zero() {
        let zero = GradeInterval {
            lower: 0,
            upper: GradeUpperBound::Finite { value: 0 },
        };
        let unbounded = GradeInterval {
            lower: 1,
            upper: GradeUpperBound::Unbounded,
        };

        assert_eq!(
            multiply_grades(&zero, &unbounded),
            Ok(GradeInterval {
                lower: 0,
                upper: GradeUpperBound::Finite { value: 0 },
            }),
        );
    }

    #[test]
    fn grade_operations_reject_invalid_or_overflowing_intervals() {
        let invalid = GradeInterval {
            lower: 2,
            upper: GradeUpperBound::Finite { value: 1 },
        };
        let maximum = GradeInterval {
            lower: u32::MAX,
            upper: GradeUpperBound::Finite { value: u32::MAX },
        };
        let one = GradeInterval {
            lower: 1,
            upper: GradeUpperBound::Finite { value: 1 },
        };

        assert_eq!(
            add_grades(&invalid, &one),
            Err(GradeArithmeticError::InvalidInterval(invalid)),
        );
        assert_eq!(
            add_grades(&maximum, &one),
            Err(GradeArithmeticError::Overflow {
                operation: GradeOperation::Addition,
            }),
        );
    }

    #[test]
    fn validated_module_rejects_an_invalid_grade_entry() {
        let mut module = module_with_value_root(
            vec![value(Value::IntervalGrade { grade: GradeId(0) })],
            ValueId(0),
        );
        module.arena.grades.push(GradeNode {
            origin: SourceOriginId(0),
            interval: GradeInterval {
                lower: 2,
                upper: GradeUpperBound::Finite { value: 1 },
            },
        });

        assert_eq!(
            validate_module(&module),
            Err(ValidationError::InvalidGrade {
                grade: GradeId(0),
                lower: 2,
                upper: GradeUpperBound::Finite { value: 1 },
            }),
        );
    }
}
