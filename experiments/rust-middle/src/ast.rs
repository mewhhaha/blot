use num_bigint::BigInt;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ExpressionId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PatternId(pub u32);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DeclarationId(pub u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Qualifier {
    None,
    Linear,
    Affine,
    Borrow,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
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
        #[serde(serialize_with = "serialize_big_int")]
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ShapePatternField {
    pub name: String,
    pub pattern: PatternId,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ArrayElement {
    pub spread: bool,
    pub value: ExpressionId,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "lowercase")]
pub enum ShapeMember {
    Field { name: String, value: ExpressionId },
    Spread { value: ExpressionId },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Branch {
    pub condition: ExpressionId,
    pub consequence: ExpressionId,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Arm {
    pub pattern: PatternId,
    pub body: ExpressionId,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "tag", rename_all = "kebab-case")]
pub enum Expression {
    Var {
        name: String,
        span: Span,
    },
    Int {
        #[serde(serialize_with = "serialize_big_int")]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultEffects {
    Pure,
    Ambient,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeclarationKind {
    Let,
    Effect,
    Const,
    Sig,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeclarationTag {
    pub descriptor: ExpressionId,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OpenMapping {
    pub source: String,
    pub target: Option<String>,
    pub span: Span,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
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
        mappings: Vec<OpenMapping>,
        value: ExpressionId,
        span: Span,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Associativity {
    Left,
    Right,
    None,
    Prefix,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Fixity {
    pub operator: String,
    pub associativity: Associativity,
    pub precedence: u32,
    pub target: Vec<String>,
    pub span: Span,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Module {
    pub parameter: Option<PatternId>,
    pub fixities: Vec<Fixity>,
    pub declarations: Vec<DeclarationId>,
    pub result: ExpressionId,
    pub result_effects: ResultEffects,
    pub span: Span,
    pub arena: AstArena,
}

fn serialize_big_int<S>(value: &BigInt, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}
