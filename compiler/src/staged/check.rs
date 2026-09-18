//! Rank-one parametric inference and staging demands over Baba's lowered AST.
use super::core::{Dependency, Global, Local, Node, Primitive, Symbol, TermId, Value};
use super::types::{self, InferId, Inference, Kind, TypeId};
use super::{Budget, Failure, PrototypeSession, Site, Work};
use crate::ast::{
    Declaration, DeclarationKind, Expression, ExpressionId, Module, Pattern, PatternId, Qualifier,
    ShapeMember,
};
use num_traits::ToPrimitive;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Runtime,
    Static,
}
#[derive(Clone)]
struct LocalBinding {
    node: usize,
    ty: InferId,
    quantified: BTreeSet<InferId>,
}
#[derive(Clone)]
struct Draft {
    node: Node,
    ty: InferId,
    site: Site,
}
struct Checker<'a> {
    session: &'a mut PrototypeSession,
    module: &'a Module,
    names: &'a BTreeMap<String, Symbol>,
    globals: &'a BTreeMap<Symbol, Global>,
    inference: Inference,
    drafts: Vec<Draft>,
    locals: BTreeMap<String, LocalBinding>,
    next_local: Local,
    dependencies: Vec<Dependency>,
    dependency_set: HashSet<Dependency>,
    budget: &'a Budget,
    work: &'a mut Work,
}

pub(super) struct Input<'a> {
    pub module: &'a Module,
    pub names: &'a BTreeMap<String, Symbol>,
    pub globals: &'a BTreeMap<Symbol, Global>,
    pub expression: ExpressionId,
    pub annotation: Option<ExpressionId>,
}

pub(super) fn definition(
    session: &mut PrototypeSession,
    input: Input<'_>,
    budget: &Budget,
    work: &mut Work,
) -> Result<(Global, Vec<Dependency>), Failure> {
    let Input {
        module,
        names,
        globals,
        expression: expr,
        annotation,
    } = input;
    let mut checker = Checker {
        session,
        module,
        names,
        globals,
        inference: Inference::new(budget.clone()),
        drafts: Vec::new(),
        locals: BTreeMap::new(),
        next_local: 0,
        dependencies: Vec::new(),
        dependency_set: HashSet::new(),
        budget,
        work,
    };
    let root = checker.infer(expr, Phase::Runtime, 0)?;
    if let Some(annotation) = annotation {
        let expected = checker.annotation(annotation, 0)?;
        checker
            .inference
            .unify(checker.drafts[root].ty, expected, checker.site(annotation))?;
    }
    let term = checker.freeze(root)?;
    let ty = checker.session.terms.nodes[term].ty;
    checker.work.unification_steps += checker.inference.steps;
    Ok((Global { term, ty }, checker.dependencies))
}

impl Checker<'_> {
    fn site(&self, id: ExpressionId) -> Site {
        self.module.arena.expression_span(id).into()
    }
    fn add(&mut self, node: Node, ty: InferId, site: Site) -> usize {
        let id = self.drafts.len();
        self.drafts.push(Draft { node, ty, site });
        id
    }
    fn constant(&mut self, value: Value, ty: TypeId, site: Site) -> usize {
        let value = self.session.values.intern(value);
        let ty = self.inference.atom(ty);
        self.add(Node::Constant(value), ty, site)
    }
    fn local(&mut self) -> Local {
        let id = self.next_local;
        self.next_local += 1;
        id
    }
    fn ty(&self, id: usize) -> InferId {
        self.drafts[id].ty
    }
    fn remember(&mut self, dependency: Dependency) {
        if self.dependency_set.insert(dependency.clone()) {
            self.dependencies.push(dependency);
        }
    }
    fn primitive(&mut self, p: Primitive, phase: Phase, site: Site) -> Result<usize, Failure> {
        let int = self.inference.atom(types::INT);
        let boolean = self.inference.atom(types::BOOL);
        let uni = self.inference.atom(types::UNIVERSE);
        let code = self.inference.atom(types::CODE);
        let unit = self.inference.atom(types::UNIT);
        let text = self.inference.atom(types::TEXT);
        let ty = match p {
            Primitive::Add | Primitive::Sub | Primitive::Mul => {
                let pair = self.inference.tuple(vec![int, int]);
                self.inference.function(pair, int)
            }
            Primitive::Equal | Primitive::Less => {
                let pair = self.inference.tuple(vec![int, int]);
                self.inference.function(pair, boolean)
            }
            _ if phase == Phase::Runtime => {
                return Err(Failure::source(
                    site,
                    "type/code construction must be demanded explicitly by @staged.static or @staged.splice",
                ));
            }
            Primitive::RecordType => {
                let input = self.inference.fresh(Kind::Value);
                self.inference.function(input, uni)
            }
            Primitive::Getter => {
                let pair = self.inference.tuple(vec![uni, text]);
                self.inference.function(pair, code)
            }
            Primitive::Fresh => self.inference.function(unit, uni),
            Primitive::Iterate => {
                let value = self.inference.fresh(Kind::Value);
                let step = self.inference.function(value, value);
                let input = self.inference.tuple(vec![int, step, value]);
                self.inference.function(input, value)
            }
            Primitive::Arrow => {
                let result = self.inference.function(uni, uni);
                self.inference.function(uni, result)
            }
        };
        Ok(self.add(Node::Primitive(p), ty, site))
    }
    fn infer(&mut self, id: ExpressionId, phase: Phase, depth: usize) -> Result<usize, Failure> {
        let site = self.site(id);
        self.budget.depth(site, depth)?;
        self.budget.tick(site)?;
        match self.module.arena.expressions[id.0 as usize].clone() {
            Expression::Int { value, .. } => {
                let value = value.to_i64().ok_or_else(|| {
                    Failure::unsupported(site, "prototype integers are signed 64-bit")
                })?;
                Ok(self.constant(Value::Int(value), types::INT, site))
            }
            Expression::Text { value, .. } => {
                Ok(self.constant(Value::Text(value), types::TEXT, site))
            }
            Expression::Unit { .. } => Ok(self.constant(Value::Unit, types::UNIT, site)),
            Expression::Var { name, .. } => {
                if let Some(binding) = self.locals.get(&name).cloned() {
                    let ty = self
                        .inference
                        .instantiate(binding.ty, &binding.quantified, site)?;
                    return Ok(self.add(self.drafts[binding.node].node.clone(), ty, site));
                }
                let symbol=*self.names.get(&name).ok_or_else(||Failure::source(site,format!("unknown name `{name}` (or a runtime value crossing a static/quotation boundary)")))?;
                let global = &self.globals[&symbol];
                let ty = global.ty;
                self.remember(Dependency::Interface { name, symbol, ty });
                let ty = self.inference.import(&self.session.types, ty, site)?;
                Ok(self.add(Node::Global(symbol), ty, site))
            }
            Expression::Intrinsic { name, .. } => {
                let value = match name.as_str() {
                    "@staged.int" => Some(Value::Type(types::INT)),
                    "@staged.bool" => Some(Value::Type(types::BOOL)),
                    "@staged.unit" => Some(Value::Type(types::UNIT)),
                    "@staged.true" => Some(Value::Bool(true)),
                    "@staged.false" => Some(Value::Bool(false)),
                    _ => None,
                };
                if let Some(value) = value {
                    let ty = if matches!(value, Value::Bool(_)) {
                        types::BOOL
                    } else {
                        types::UNIVERSE
                    };
                    return Ok(self.constant(value, ty, site));
                }
                let primitive = match name.as_str() {
                    "@staged.add" => Primitive::Add,
                    "@staged.sub" => Primitive::Sub,
                    "@staged.mul" => Primitive::Mul,
                    "@staged.eq" => Primitive::Equal,
                    "@staged.lt" => Primitive::Less,
                    "@staged.record" => Primitive::RecordType,
                    "@staged.getter" => Primitive::Getter,
                    "@staged.fresh" => Primitive::Fresh,
                    "@staged.iterate" => Primitive::Iterate,
                    "@type.arrow" => Primitive::Arrow,
                    _ => {
                        return Err(Failure::unsupported(
                            site,
                            format!("intrinsic `{name}` is not in the staged prototype"),
                        ));
                    }
                };
                self.primitive(primitive, phase, site)
            }
            Expression::Apply {
                function, argument, ..
            } => {
                if let Expression::Intrinsic { name, .. } =
                    &self.module.arena.expressions[function.0 as usize]
                {
                    if name == "@staged.static" || name == "@staged.splice" {
                        if phase == Phase::Static && name == "@staged.static" {
                            return self.infer(argument, phase, depth + 1);
                        }
                        if phase == Phase::Static {
                            return Err(Failure::unsupported(
                                site,
                                "nested dynamic splicing is not in this first prototype",
                            ));
                        }
                        let splice = name == "@staged.splice";
                        let argument = self.infer(argument, Phase::Static, depth + 1)?;
                        let term = self.freeze(argument)?;
                        let (value, deps) = super::static_eval::evaluate(
                            self.session,
                            self.globals,
                            term,
                            self.budget,
                            self.work,
                            site,
                        )?;
                        for dep in deps {
                            self.remember(dep);
                        }
                        if splice {
                            let Value::Code(code) = self.session.values.nodes[value] else {
                                return Err(Failure::source(
                                    site,
                                    "splice requires a scoped typed Code value",
                                ));
                            };
                            let ty = self.inference.import(
                                &self.session.types,
                                self.session.terms.nodes[code].ty,
                                site,
                            )?;
                            return Ok(self.add(Node::Instance(code), ty, site));
                        }
                        let ty = self.session.value_type(value, self.budget, site)?;
                        let ty = self.inference.import(&self.session.types, ty, site)?;
                        return Ok(self.add(Node::Constant(value), ty, site));
                    }
                    if name == "@staged.quote" {
                        if phase != Phase::Static {
                            return Err(Failure::source(
                                site,
                                "quote belongs inside an explicit static demand",
                            ));
                        }
                        // Closed quotation is the initial hygiene boundary. A future
                        // scoped splice API may abstract static locals, never capture
                        // them implicitly or grant raw AST nodes checking authority.
                        let saved = std::mem::take(&mut self.locals);
                        let quoted = self.infer(argument, Phase::Runtime, depth + 1);
                        self.locals = saved;
                        let quoted = quoted?;
                        let ty = self.inference.atom(types::CODE);
                        return Ok(self.add(Node::Quote(quoted), ty, site));
                    }
                }
                let f = self.infer(function, phase, depth + 1)?;
                let arg = self.infer(argument, phase, depth + 1)?;
                let out = self.inference.fresh(Kind::Value);
                let arrow = self.inference.function(self.ty(arg), out);
                self.inference.unify(self.ty(f), arrow, site)?;
                Ok(self.add(Node::Call(f, arg), out, site))
            }
            Expression::Lambda {
                parameter,
                body,
                deferred,
                ..
            } => {
                if deferred {
                    return Err(Failure::unsupported(
                        site,
                        "deferred parameters are outside the pure prototype fragment",
                    ));
                }
                let saved = self.locals.clone();
                let param = self.local();
                let input = self.inference.fresh(Kind::Value);
                let local = self.add(Node::Local(param), input, site);
                self.bind_pattern(parameter, local, depth + 1)?;
                let body = self.infer(body, phase, depth + 1)?;
                self.locals = saved;
                let ty = self.inference.function(input, self.ty(body));
                Ok(self.add(
                    Node::Function {
                        parameter: param,
                        body,
                    },
                    ty,
                    site,
                ))
            }
            Expression::Tuple { elements, .. } => {
                let xs = elements
                    .into_iter()
                    .map(|e| self.infer(e, phase, depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                let ty = self
                    .inference
                    .tuple(xs.iter().map(|x| self.ty(*x)).collect());
                Ok(self.add(Node::Tuple(xs), ty, site))
            }
            Expression::Shape { members, .. } => {
                let mut fields = Vec::new();
                let mut tys = BTreeMap::new();
                for member in members {
                    let ShapeMember::Field { name, value } = member else {
                        return Err(Failure::unsupported(
                            site,
                            "computed/spread fields are not in the first prototype",
                        ));
                    };
                    if tys.contains_key(&name) {
                        return Err(Failure::source(site, "duplicate field"));
                    }
                    let value = self.infer(value, phase, depth + 1)?;
                    tys.insert(name.clone(), self.ty(value));
                    fields.push((name, value));
                }
                let ty = self.inference.record(tys, false);
                Ok(self.add(Node::Record(fields), ty, site))
            }
            Expression::Field { target, name, .. } => {
                let target = self.infer(target, phase, depth + 1)?;
                let ty = self.inference.fresh(Kind::Value);
                let record = self
                    .inference
                    .record(BTreeMap::from([(name.clone(), ty)]), true);
                self.inference.unify(self.ty(target), record, site)?;
                Ok(self.add(Node::Field(target, name), ty, site))
            }
            Expression::If {
                branches, fallback, ..
            } => {
                let fallback = fallback
                    .ok_or_else(|| Failure::source(site, "value conditional needs else"))?;
                let mut out = self.infer(fallback, phase, depth + 1)?;
                for branch in branches.into_iter().rev() {
                    let condition = self.infer(branch.condition, phase, depth + 1)?;
                    let boolean = self.inference.atom(types::BOOL);
                    self.inference.unify(
                        self.ty(condition),
                        boolean,
                        self.site(branch.condition),
                    )?;
                    let body = self.infer(branch.consequence, phase, depth + 1)?;
                    self.inference.unify(self.ty(body), self.ty(out), site)?;
                    out = self.add(Node::If(condition, body, out), self.ty(out), site);
                }
                Ok(out)
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                let saved = self.locals.clone();
                let mut signatures = BTreeMap::new();
                let mut bindings = Vec::new();
                for declaration in declarations {
                    match self.module.arena.declarations[declaration.0 as usize].clone() {
                        Declaration::Signature {
                            name,
                            value,
                            recursive,
                            kind,
                            span,
                        } => {
                            if recursive || kind == DeclarationKind::Effect {
                                return Err(Failure::unsupported(
                                    span.into(),
                                    "recursive/effect block signature",
                                ));
                            }
                            if signatures.insert(name, value).is_some() {
                                return Err(Failure::source(
                                    span.into(),
                                    "duplicate local signature",
                                ));
                            }
                        }
                        Declaration::Binding {
                            kind,
                            tags,
                            pattern,
                            value,
                            span,
                        } => {
                            if kind == DeclarationKind::Effect || !tags.is_empty() {
                                return Err(Failure::unsupported(
                                    span.into(),
                                    "effectful/tagged local declaration",
                                ));
                            }
                            let Pattern::Name {
                                name,
                                qualifier: Qualifier::None,
                                ..
                            } = &self.module.arena.patterns[pattern.0 as usize]
                            else {
                                return Err(Failure::unsupported(
                                    span.into(),
                                    "local declaration must bind one name",
                                ));
                            };
                            let name = name.clone();
                            let node = self.infer(value, phase, depth + 1)?;
                            let ty = self.ty(node);
                            if let Some(annotation) = signatures.remove(&name) {
                                let expected = self.annotation(annotation, depth + 1)?;
                                self.inference.unify(ty, expected, span.into())?;
                            }
                            let mut quantified = self.inference.free(ty, span.into())?;
                            for binding in self.locals.values() {
                                for free in self
                                    .inference
                                    .free(binding.ty, span.into())?
                                    .difference(&binding.quantified)
                                {
                                    quantified.remove(free);
                                }
                            }
                            let slot = self.local();
                            let local = self.add(Node::Local(slot), ty, span.into());
                            self.locals.insert(
                                name,
                                LocalBinding {
                                    node: local,
                                    ty,
                                    quantified,
                                },
                            );
                            bindings.push((slot, node));
                        }
                        _ => {
                            return Err(Failure::unsupported(
                                site,
                                "block open/rebinding is not in the prototype",
                            ));
                        }
                    }
                }
                if !signatures.is_empty() {
                    return Err(Failure::source(site, "unbound local signature"));
                }
                let mut body = self.infer(result, phase, depth + 1)?;
                for (local, value) in bindings.into_iter().rev() {
                    body = self.add(Node::Let { local, value, body }, self.ty(body), site);
                }
                self.locals = saved;
                Ok(body)
            }
            _ => Err(Failure::unsupported(
                site,
                "this surface form requires the production compiler; no fallback was performed",
            )),
        }
    }
    fn bind_pattern(&mut self, id: PatternId, node: usize, depth: usize) -> Result<(), Failure> {
        let site = self.drafts[node].site;
        self.budget.depth(site, depth)?;
        self.budget.tick(site)?;
        match self.module.arena.patterns[id.0 as usize].clone() {
            Pattern::Name {
                name,
                qualifier: Qualifier::None,
                ..
            } => {
                self.locals.insert(
                    name,
                    LocalBinding {
                        node,
                        ty: self.ty(node),
                        quantified: BTreeSet::new(),
                    },
                );
            }
            Pattern::Wildcard { .. } => {}
            Pattern::Unit { .. } => {
                let unit = self.inference.atom(types::UNIT);
                self.inference.unify(self.ty(node), unit, site)?;
            }
            Pattern::Tuple { elements, .. } => {
                let tys = elements
                    .iter()
                    .map(|_| self.inference.fresh(Kind::Value))
                    .collect::<Vec<_>>();
                let tuple = self.inference.tuple(tys.clone());
                self.inference.unify(self.ty(node), tuple, site)?;
                for (i, (p, ty)) in elements.into_iter().zip(tys).enumerate() {
                    let field = self.add(Node::Project(node, i), ty, site);
                    self.bind_pattern(p, field, depth + 1)?;
                }
            }
            _ => {
                return Err(Failure::unsupported(
                    site,
                    "prototype parameters support names, tuples, unit and wildcards without ownership qualifiers",
                ));
            }
        }
        Ok(())
    }
    fn binary(&self, id: ExpressionId, intrinsic: &str) -> Option<(ExpressionId, ExpressionId)> {
        let Expression::Apply {
            function,
            argument: b,
            ..
        } = &self.module.arena.expressions[id.0 as usize]
        else {
            return None;
        };
        let Expression::Apply {
            function,
            argument: a,
            ..
        } = &self.module.arena.expressions[function.0 as usize]
        else {
            return None;
        };
        if matches!(&self.module.arena.expressions[function.0 as usize],Expression::Intrinsic{name,..} if name==intrinsic)
        {
            Some((*a, *b))
        } else {
            None
        }
    }
    fn annotation(&mut self, id: ExpressionId, depth: usize) -> Result<InferId, Failure> {
        let site = self.site(id);
        self.budget.depth(site, depth)?;
        self.budget.tick(site)?;
        if matches!(&self.module.arena.expressions[id.0 as usize],Expression::Var{name,..} if name=="_")
        {
            return Ok(self.inference.fresh(Kind::Value));
        }
        if let Some((a, b)) = self.binary(id, "@type.arrow") {
            let a = self.annotation(a, depth + 1)?;
            let b = self.annotation(b, depth + 1)?;
            return Ok(self.inference.function(a, b));
        }
        if let Some((ty, effects)) = self.binary(id, "@type.performs") {
            let permitted = match &self.module.arena.expressions[effects.0 as usize] {
                Expression::Array { elements, .. } => {
                    elements.is_empty()
                        || (elements.len() == 1
                            && !elements[0].spread
                            && matches!(&self.module.arena.expressions[elements[0].value.0 as usize],Expression::Var{name,..} if name=="_"))
                }
                _ => false,
            };
            if !permitted {
                return Err(Failure::unsupported(
                    site,
                    "nonempty/open source effects are not in the pure prototype",
                ));
            }
            return self.annotation(ty, depth + 1);
        }
        if let Expression::Tuple { elements, .. } =
            self.module.arena.expressions[id.0 as usize].clone()
        {
            let ts = elements
                .into_iter()
                .map(|e| self.annotation(e, depth + 1))
                .collect::<Result<_, _>>()?;
            return Ok(self.inference.tuple(ts));
        }
        let draft = self.infer(id, Phase::Static, depth + 1)?;
        let term = self.freeze(draft)?;
        let (value, deps) = super::static_eval::evaluate(
            self.session,
            self.globals,
            term,
            self.budget,
            self.work,
            site,
        )?;
        for dep in deps {
            self.remember(dep);
        }
        let Value::Type(ty) = self.session.values.nodes[value] else {
            return Err(Failure::source(
                site,
                "annotation must evaluate to a Type value",
            ));
        };
        self.inference.import(&self.session.types, ty, site)
    }
    fn freeze(&mut self, root: usize) -> Result<TermId, Failure> {
        let mut types = HashMap::new();
        let mut bindings = HashMap::new();
        // Freeze the interface first so generic binder numbering is independent
        // of private body allocation order and stable across implementation edits.
        let root_ty = self.ty(root);
        self.inference.freeze(
            &mut self.session.types,
            root_ty,
            &mut bindings,
            &mut types,
            self.drafts[root].site,
        )?;
        let mut pending = vec![(root, false)];
        let mut memo = HashMap::new();
        while let Some((id, done)) = pending.pop() {
            if memo.contains_key(&id) {
                continue;
            }
            self.budget.tick(self.drafts[id].site)?;
            let children = match &self.drafts[id].node {
                Node::Function { body, .. }
                | Node::Project(body, _)
                | Node::Field(body, _)
                | Node::Quote(body) => vec![*body],
                Node::Call(a, b) => vec![*a, *b],
                Node::Let { value, body, .. } => vec![*value, *body],
                Node::If(a, b, c) => vec![*a, *b, *c],
                Node::Tuple(xs) => xs.clone(),
                Node::Record(fs) => fs.iter().map(|(_, x)| *x).collect(),
                _ => vec![],
            };
            if !done {
                pending.push((id, true));
                pending.extend(children.into_iter().map(|c| (c, false)));
                continue;
            }
            let map = |id: &usize| memo[id];
            let node = match &self.drafts[id].node {
                Node::Function { parameter, body } => Node::Function {
                    parameter: *parameter,
                    body: map(body),
                },
                Node::Call(a, b) => Node::Call(map(a), map(b)),
                Node::Tuple(xs) => Node::Tuple(xs.iter().map(map).collect()),
                Node::Record(fs) => {
                    Node::Record(fs.iter().map(|(n, x)| (n.clone(), map(x))).collect())
                }
                Node::Project(x, i) => Node::Project(map(x), *i),
                Node::Field(x, n) => Node::Field(map(x), n.clone()),
                Node::Let { local, value, body } => Node::Let {
                    local: *local,
                    value: map(value),
                    body: map(body),
                },
                Node::If(a, b, c) => Node::If(map(a), map(b), map(c)),
                Node::Quote(x) => Node::Quote(map(x)),
                other => other.clone(),
            };
            let ty = self.inference.freeze(
                &mut self.session.types,
                self.drafts[id].ty,
                &mut bindings,
                &mut types,
                self.drafts[id].site,
            )?;
            let term = self.session.terms.intern(node, ty);
            memo.insert(id, term);
        }
        Ok(memo[&root])
    }
}
