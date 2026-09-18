use super::types::TypeId;
use super::{Budget, Failure, Site};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub(super) type TermId = usize;
pub(super) type ValueId = usize;
pub(super) type Symbol = usize;
pub(super) type Local = u32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Primitive {
    Add,
    Sub,
    Mul,
    Equal,
    Less,
    RecordType,
    Getter,
    Fresh,
    Iterate,
    Arrow,
    ArrayType,
    ArrayLen,
    ArrayAt,
    ArrayPush,
    ArrayFold,
    TypeFields,
    RecordFields,
    TypeEqual,
    CodeLambda,
    CodeApply,
    CodeLift,
    CodeIf,
    CodeField,
    CodeTuple,
    CodeRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Node {
    /// Checker-only hole. Freezing rejects this variant before publishing core.
    Blocked(usize),
    Constant(ValueId),
    Primitive(Primitive),
    Local(Local),
    Global(Symbol),
    Function {
        parameter: Local,
        body: TermId,
    },
    RecursiveFunction {
        recursive: Local,
        parameter: Local,
        body: TermId,
    },
    Call(TermId, TermId),
    Array(Vec<TermId>),
    Variant(String, Option<TermId>),
    Case {
        target: TermId,
        arms: Vec<(String, Option<Local>, TermId)>,
        fallback: Option<(Local, TermId)>,
    },
    Tuple(Vec<TermId>),
    Record(Vec<(String, TermId)>),
    Project(TermId, usize),
    Field(TermId, String),
    Let {
        local: Local,
        value: TermId,
        body: TermId,
    },
    If(TermId, TermId, TermId),
    Quote(TermId),
    Instance(TermId),
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Term {
    pub ty: TypeId,
    pub node: Node,
}

#[derive(Default)]
pub(super) struct Terms {
    pub nodes: Vec<Term>,
    index: HashMap<Term, TermId>,
    pub storage_bytes: usize,
}
impl Terms {
    pub fn intern(&mut self, node: Node, ty: TypeId) -> TermId {
        if let Node::Instance(id) = node
            && self.nodes[id].ty == ty
        {
            return id;
        }
        let term = Term { ty, node };
        if let Some(id) = self.index.get(&term) {
            return *id;
        }
        self.storage_bytes += 2
            * (std::mem::size_of::<Term>()
                + match &term.node {
                    Node::Record(fs) => fs.iter().map(|(name, _)| name.len() + 32).sum(),
                    Node::Field(_, name) | Node::Variant(name, _) => name.len(),
                    Node::Case { arms, .. } => {
                        arms.iter().map(|(name, _, _)| name.len() + 32).sum()
                    }
                    Node::Tuple(xs) | Node::Array(xs) => xs.len() * std::mem::size_of::<TermId>(),
                    _ => 0,
                });
        let id = self.nodes.len();
        self.nodes.push(term.clone());
        self.index.insert(term, id);
        id
    }
    pub fn children(&self, id: TermId) -> Vec<TermId> {
        match &self.nodes[id].node {
            Node::Function { body, .. }
            | Node::RecursiveFunction { body, .. }
            | Node::Project(body, _)
            | Node::Field(body, _)
            | Node::Quote(body)
            | Node::Instance(body) => vec![*body],
            Node::Call(a, b) => vec![*a, *b],
            Node::If(a, b, c) => vec![*a, *b, *c],
            Node::Let { value, body, .. } => vec![*value, *body],
            Node::Tuple(xs) | Node::Array(xs) => xs.clone(),
            Node::Variant(_, value) => value.iter().copied().collect(),
            Node::Case {
                target,
                arms,
                fallback,
            } => std::iter::once(*target)
                .chain(arms.iter().map(|(_, _, body)| *body))
                .chain(fallback.iter().map(|(_, body)| *body))
                .collect(),
            Node::Record(fs) => fs.iter().map(|(_, v)| *v).collect(),
            _ => vec![],
        }
    }
    // A set of free local slots, not a transitive lexical environment. Completion
    // is memoized after children; local bindings remove only their own slot.
    pub fn free_locals(
        &self,
        root: TermId,
        budget: &Budget,
        site: Site,
    ) -> Result<BTreeSet<Local>, Failure> {
        let mut pending = vec![(root, false)];
        let mut memo = HashMap::<TermId, BTreeSet<Local>>::new();
        while let Some((id, done)) = pending.pop() {
            budget.tick(site)?;
            if memo.contains_key(&id) {
                continue;
            }
            if !done {
                pending.push((id, true));
                pending.extend(self.children(id).into_iter().map(|c| (c, false)));
                continue;
            }
            let mut vars = BTreeSet::new();
            match self.nodes[id].node {
                Node::Local(n) => {
                    vars.insert(n);
                }
                Node::Function { parameter, body } => {
                    vars = memo[&body].clone();
                    vars.remove(&parameter);
                }
                Node::RecursiveFunction {
                    recursive,
                    parameter,
                    body,
                } => {
                    vars = memo[&body].clone();
                    vars.remove(&parameter);
                    vars.remove(&recursive);
                }
                Node::Case {
                    target,
                    ref arms,
                    ref fallback,
                } => {
                    vars = memo[&target].clone();
                    for (_, parameter, body) in arms {
                        let mut arm = memo[body].clone();
                        if let Some(parameter) = parameter {
                            arm.remove(parameter);
                        }
                        vars.extend(arm);
                    }
                    if let Some((parameter, body)) = fallback {
                        let mut arm = memo[body].clone();
                        arm.remove(parameter);
                        vars.extend(arm);
                    }
                }
                Node::Let { local, value, body } => {
                    vars = memo[&body].clone();
                    vars.remove(&local);
                    vars.extend(&memo[&value]);
                }
                _ => {
                    for c in self.children(id) {
                        vars.extend(&memo[&c]);
                    }
                }
            }
            memo.insert(id, vars);
        }
        Ok(memo.remove(&root).unwrap())
    }
    pub fn globals(
        &self,
        root: TermId,
        budget: &Budget,
        site: Site,
    ) -> Result<BTreeSet<Symbol>, Failure> {
        let mut pending = vec![root];
        let mut seen = HashSet::new();
        let mut globals = BTreeSet::new();
        while let Some(id) = pending.pop() {
            budget.tick(site)?;
            if !seen.insert(id) {
                continue;
            }
            if let Node::Global(s) = self.nodes[id].node {
                globals.insert(s);
            }
            pending.extend(self.children(id));
        }
        Ok(globals)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Value {
    Int(i64),
    Bool(bool),
    Unit,
    Text(String),
    Type(TypeId),
    Code(TermId),
    Tuple(Vec<ValueId>),
    Array(Vec<ValueId>),
    Variant(String, Option<ValueId>),
    Record(BTreeMap<String, ValueId>),
    Closure {
        function: TermId,
        captures: BTreeMap<Local, ValueId>,
    },
    Primitive(Primitive, Vec<ValueId>),
}
#[derive(Default)]
pub(super) struct Values {
    pub nodes: Vec<Value>,
    index: HashMap<Value, ValueId>,
    pub storage_bytes: usize,
}
impl Values {
    pub fn intern(&mut self, value: Value) -> ValueId {
        if let Some(id) = self.index.get(&value) {
            return *id;
        }
        self.storage_bytes += 2
            * (std::mem::size_of::<Value>()
                + match &value {
                    Value::Text(text) | Value::Variant(text, _) => text.len(),
                    Value::Record(fs) => fs.keys().map(|name| name.len() + 32).sum(),
                    Value::Tuple(xs) | Value::Array(xs) | Value::Primitive(_, xs) => {
                        xs.len() * std::mem::size_of::<ValueId>()
                    }
                    Value::Closure { captures, .. } => captures.len() * 32,
                    _ => 0,
                });
        let id = self.nodes.len();
        self.nodes.push(value.clone());
        self.index.insert(value, id);
        id
    }
}

#[derive(Clone, Debug)]
pub(super) struct Global {
    pub term: TermId,
    pub ty: TypeId,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Dependency {
    Interface {
        name: String,
        symbol: Symbol,
        ty: TypeId,
    },
    StaticBody {
        symbol: Symbol,
        term: TermId,
    },
}
impl Dependency {
    pub fn valid(
        &self,
        names: &BTreeMap<String, Symbol>,
        globals: &BTreeMap<Symbol, Global>,
    ) -> bool {
        match self {
            Self::Interface { name, symbol, ty } => {
                names.get(name) == Some(symbol) && globals.get(symbol).is_some_and(|g| g.ty == *ty)
            }
            Self::StaticBody { symbol, term } => {
                globals.get(symbol).is_some_and(|g| g.term == *term)
            }
        }
    }
}
