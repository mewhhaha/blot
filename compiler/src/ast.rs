use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ExpressionId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PatternId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeclarationId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Qualifier {
    None,
    Linear,
    Affine,
    Borrow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "lowercase")]
pub enum Pattern {
    Name {
        name: String,
        qualifier: Qualifier,
        span: Span,
    },
    Wildcard {
        span: Span,
    },
    Pin {
        name: String,
        span: Span,
    },
    Int {
        #[serde(
            serialize_with = "serialize_big_int",
            deserialize_with = "deserialize_big_int"
        )]
        value: BigInt,
        span: Span,
    },
    Float {
        value: f64,
        span: Span,
    },
    Text {
        value: String,
        span: Span,
    },
    Unit {
        span: Span,
    },
    Tuple {
        elements: Vec<PatternId>,
        span: Span,
    },
    Array {
        elements: Vec<PatternId>,
        span: Span,
    },
    Constructor {
        name: String,
        payload: Option<PatternId>,
        span: Span,
    },
    Shape {
        fields: Vec<ShapePatternField>,
        span: Span,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ShapePatternField {
    pub name: String,
    pub pattern: PatternId,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ArrayElement {
    pub spread: bool,
    pub value: ExpressionId,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "lowercase")]
pub enum ShapeMember {
    Field { name: String, value: ExpressionId },
    Spread { value: ExpressionId },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Branch {
    pub condition: ExpressionId,
    pub consequence: ExpressionId,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Arm {
    pub pattern: PatternId,
    pub body: ExpressionId,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "kebab-case")]
pub enum Expression {
    Var {
        name: String,
        span: Span,
    },
    Int {
        #[serde(
            serialize_with = "serialize_big_int",
            deserialize_with = "deserialize_big_int"
        )]
        value: BigInt,
        span: Span,
    },
    Float {
        value: f64,
        span: Span,
    },
    Text {
        value: String,
        span: Span,
    },
    Unit {
        span: Span,
    },
    Intrinsic {
        name: String,
        span: Span,
    },
    Tag {
        name: String,
        span: Span,
    },
    Apply {
        function: ExpressionId,
        argument: ExpressionId,
        span: Span,
    },
    Field {
        target: ExpressionId,
        name: String,
        span: Span,
    },
    Lambda {
        parameter: PatternId,
        body: ExpressionId,
        /// The caller suspends the argument until the parameter is read.
        /// Always serialized: the module snapshot encodes a struct as a
        /// sequence, so a field that comes and goes shifts every field after
        /// it. `canonicalModule` drops the strict case instead, which is what
        /// makes this the same node source elaboration builds.
        #[serde(default)]
        deferred: bool,
        span: Span,
    },
    Array {
        elements: Vec<ArrayElement>,
        span: Span,
    },
    Tuple {
        elements: Vec<ExpressionId>,
        span: Span,
    },
    Shape {
        members: Vec<ShapeMember>,
        span: Span,
    },
    If {
        branches: Vec<Branch>,
        fallback: Option<ExpressionId>,
        span: Span,
    },
    Case {
        target: ExpressionId,
        arms: Vec<Arm>,
        span: Span,
    },
    Block {
        declarations: Vec<DeclarationId>,
        result: ExpressionId,
        result_effects: ResultEffects,
        span: Span,
    },
    Rec {
        lambda: ExpressionId,
        span: Span,
    },
    Comptime {
        body: ExpressionId,
        span: Span,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultEffects {
    Pure,
    Ambient,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeclarationKind {
    Let,
    Effect,
    Const,
    Sig,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DeclarationTag {
    pub descriptor: ExpressionId,
    pub span: Span,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "lowercase")]
pub enum Declaration {
    Binding {
        kind: DeclarationKind,
        tags: Vec<DeclarationTag>,
        pattern: PatternId,
        value: ExpressionId,
        span: Span,
    },
    Shadow {
        name: String,
        value: ExpressionId,
        span: Span,
    },
    Open {
        value: ExpressionId,
        span: Span,
    },
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct AstArena {
    pub expressions: Vec<Expression>,
    pub patterns: Vec<Pattern>,
    pub declarations: Vec<Declaration>,
}

impl AstArena {
    pub fn expression(&mut self, expression: Expression) -> ExpressionId {
        let id = ExpressionId(self.expressions.len() as u32);
        self.expressions.push(expression);
        id
    }

    pub fn pattern(&mut self, pattern: Pattern) -> PatternId {
        let id = PatternId(self.patterns.len() as u32);
        self.patterns.push(pattern);
        id
    }

    pub fn declaration(&mut self, declaration: Declaration) -> DeclarationId {
        let id = DeclarationId(self.declarations.len() as u32);
        self.declarations.push(declaration);
        id
    }

    pub fn expression_span(&self, id: ExpressionId) -> Span {
        match &self.expressions[id.0 as usize] {
            Expression::Var { span, .. }
            | Expression::Int { span, .. }
            | Expression::Float { span, .. }
            | Expression::Text { span, .. }
            | Expression::Unit { span }
            | Expression::Intrinsic { span, .. }
            | Expression::Tag { span, .. }
            | Expression::Apply { span, .. }
            | Expression::Field { span, .. }
            | Expression::Lambda { span, .. }
            | Expression::Array { span, .. }
            | Expression::Tuple { span, .. }
            | Expression::Shape { span, .. }
            | Expression::If { span, .. }
            | Expression::Case { span, .. }
            | Expression::Block { span, .. }
            | Expression::Rec { span, .. }
            | Expression::Comptime { span, .. } => *span,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Module {
    pub parameter: Option<PatternId>,
    pub declarations: Vec<DeclarationId>,
    pub result: ExpressionId,
    pub result_effects: ResultEffects,
    pub span: Span,
    pub arena: AstArena,
}

impl Module {
    pub fn validate(&self) -> Result<(), String> {
        validate_span(self.span, "module")?;
        let expression_count = self.arena.expressions.len();
        let pattern_count = self.arena.patterns.len();
        let declaration_count = self.arena.declarations.len();
        let pattern_offset = expression_count;
        let declaration_offset = expression_count + pattern_count;
        let mut edges = vec![Vec::new(); declaration_offset + declaration_count];

        let expression_index = |id: ExpressionId, location: &str| {
            let index = id.0 as usize;
            if index >= expression_count {
                return Err(format!(
                    "{location} expression {} is outside arena length {expression_count}",
                    id.0
                ));
            }
            Ok(index)
        };
        let pattern_index = |id: PatternId, location: &str| {
            let index = id.0 as usize;
            if index >= pattern_count {
                return Err(format!(
                    "{location} pattern {} is outside arena length {pattern_count}",
                    id.0
                ));
            }
            Ok(pattern_offset + index)
        };
        let declaration_index = |id: DeclarationId, location: &str| {
            let index = id.0 as usize;
            if index >= declaration_count {
                return Err(format!(
                    "{location} declaration {} is outside arena length {declaration_count}",
                    id.0
                ));
            }
            Ok(declaration_offset + index)
        };

        if let Some(parameter) = self.parameter {
            pattern_index(parameter, "module parameter")?;
        }
        for (ordinal, declaration) in self.declarations.iter().enumerate() {
            declaration_index(*declaration, &format!("module declaration {ordinal}"))?;
        }
        expression_index(self.result, "module result")?;
        for (index, expression) in self.arena.expressions.iter().enumerate() {
            let location = format!("expression {index}");
            validate_span(
                self.arena.expression_span(ExpressionId(index as u32)),
                &location,
            )?;
            let targets = &mut edges[index];
            match expression {
                Expression::Var { .. }
                | Expression::Int { .. }
                | Expression::Float { .. }
                | Expression::Text { .. }
                | Expression::Unit { .. }
                | Expression::Intrinsic { .. }
                | Expression::Tag { .. } => {}
                Expression::Apply {
                    function, argument, ..
                } => {
                    targets.push(expression_index(*function, &location)?);
                    targets.push(expression_index(*argument, &location)?);
                }
                Expression::Field { target, .. } => {
                    targets.push(expression_index(*target, &location)?);
                }
                Expression::Lambda {
                    parameter, body, ..
                } => {
                    targets.push(pattern_index(*parameter, &location)?);
                    targets.push(expression_index(*body, &location)?);
                }
                Expression::Array { elements, .. } => {
                    for element in elements {
                        targets.push(expression_index(element.value, &location)?);
                    }
                }
                Expression::Tuple { elements, .. } => {
                    for element in elements {
                        targets.push(expression_index(*element, &location)?);
                    }
                }
                Expression::Shape { members, .. } => {
                    for member in members {
                        let value = match member {
                            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                                *value
                            }
                        };
                        targets.push(expression_index(value, &location)?);
                    }
                }
                Expression::If {
                    branches, fallback, ..
                } => {
                    for branch in branches {
                        targets.push(expression_index(branch.condition, &location)?);
                        targets.push(expression_index(branch.consequence, &location)?);
                    }
                    if let Some(fallback) = fallback {
                        targets.push(expression_index(*fallback, &location)?);
                    }
                }
                Expression::Case { target, arms, .. } => {
                    targets.push(expression_index(*target, &location)?);
                    for arm in arms {
                        targets.push(pattern_index(arm.pattern, &location)?);
                        targets.push(expression_index(arm.body, &location)?);
                    }
                }
                Expression::Block {
                    declarations,
                    result,
                    ..
                } => {
                    for declaration in declarations {
                        targets.push(declaration_index(*declaration, &location)?);
                    }
                    targets.push(expression_index(*result, &location)?);
                }
                Expression::Rec { lambda, .. } => {
                    targets.push(expression_index(*lambda, &location)?);
                }
                Expression::Comptime { body, .. } => {
                    targets.push(expression_index(*body, &location)?);
                }
            }
        }

        for (index, pattern) in self.arena.patterns.iter().enumerate() {
            let location = format!("pattern {index}");
            let targets = &mut edges[pattern_offset + index];
            match pattern {
                Pattern::Name { span, .. }
                | Pattern::Wildcard { span }
                | Pattern::Pin { span, .. }
                | Pattern::Int { span, .. }
                | Pattern::Float { span, .. }
                | Pattern::Text { span, .. }
                | Pattern::Unit { span } => validate_span(*span, &location)?,
                Pattern::Tuple { elements, span } | Pattern::Array { elements, span } => {
                    validate_span(*span, &location)?;
                    for element in elements {
                        targets.push(pattern_index(*element, &location)?);
                    }
                }
                Pattern::Constructor { payload, span, .. } => {
                    validate_span(*span, &location)?;
                    if let Some(payload) = payload {
                        targets.push(pattern_index(*payload, &location)?);
                    }
                }
                Pattern::Shape { fields, span } => {
                    validate_span(*span, &location)?;
                    for field in fields {
                        targets.push(pattern_index(field.pattern, &location)?);
                    }
                }
            }
        }

        for (index, declaration) in self.arena.declarations.iter().enumerate() {
            let location = format!("declaration {index}");
            let targets = &mut edges[declaration_offset + index];
            match declaration {
                Declaration::Binding {
                    tags,
                    pattern,
                    value,
                    span,
                    ..
                } => {
                    validate_span(*span, &location)?;
                    for tag in tags {
                        validate_span(tag.span, &location)?;
                        targets.push(expression_index(tag.descriptor, &location)?);
                    }
                    targets.push(pattern_index(*pattern, &location)?);
                    targets.push(expression_index(*value, &location)?);
                }
                Declaration::Shadow { value, span, .. } => {
                    validate_span(*span, &location)?;
                    targets.push(expression_index(*value, &location)?);
                }
                Declaration::Open { value, span } => {
                    validate_span(*span, &location)?;
                    targets.push(expression_index(*value, &location)?);
                }
            }
        }

        let mut states = vec![0_u8; edges.len()];
        for root in 0..edges.len() {
            if states[root] != 0 {
                continue;
            }
            let mut stack = vec![(root, false)];
            while let Some((node, exiting)) = stack.pop() {
                if exiting {
                    states[node] = 2;
                    continue;
                }
                if states[node] == 2 {
                    continue;
                }
                if states[node] == 1 {
                    return Err(format!(
                        "portable AST contains a cycle at arena node {node}"
                    ));
                }
                states[node] = 1;
                stack.push((node, true));
                for target in edges[node].iter().rev() {
                    if states[*target] == 1 {
                        return Err(format!(
                            "portable AST contains a cycle from arena node {node} to {target}"
                        ));
                    }
                    if states[*target] == 0 {
                        stack.push((*target, false));
                    }
                }
            }
        }
        Ok(())
    }
}

fn validate_span(span: Span, location: &str) -> Result<(), String> {
    if span.end < span.start {
        return Err(format!("{location} span ends before it starts"));
    }
    Ok(())
}

fn serialize_big_int<S>(value: &BigInt, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}

fn deserialize_big_int<'de, D>(deserializer: D) -> Result<BigInt, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let encoded = String::deserialize(deserializer)?;
    encoded.parse().map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::Module;

    #[test]
    fn portable_ast_accepts_a_valid_integer_module() {
        let module: Module = serde_json::from_str(
            r#"{
                "parameter": null,
                "declarations": [],
                "result": 0,
                "result_effects": "pure",
                "span": { "start": 0, "end": 10 },
                "arena": {
                    "expressions": [
                        { "tag": "int", "value": "41", "span": { "start": 7, "end": 9 } }
                    ],
                    "patterns": [],
                    "declarations": []
                }
            }"#,
        )
        .expect("fixture must decode");

        assert_eq!(module.validate(), Ok(()));
    }

    #[test]
    fn portable_ast_rejects_a_cyclic_expression() {
        let module: Module = serde_json::from_str(
            r#"{
                "parameter": null,
                "declarations": [],
                "result": 0,
                "result_effects": "pure",
                "span": { "start": 0, "end": 20 },
                "arena": {
                    "expressions": [
                        { "tag": "rec", "lambda": 0, "span": { "start": 7, "end": 19 } }
                    ],
                    "patterns": [],
                    "declarations": []
                }
            }"#,
        )
        .expect("fixture must decode");

        assert_eq!(
            module.validate(),
            Err("portable AST contains a cycle from arena node 0 to 0".to_owned())
        );
    }
}
