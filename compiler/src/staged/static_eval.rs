//! Execute checked static code. Pure calls cache values plus actual body reads;
//! calls allocating generative identities and failed calls are never memoized.
use super::core::{Dependency, Global, Local, Node, Primitive, Symbol, TermId, Value, ValueId};
use super::types::Type;
use super::{Budget, Failure, PrototypeSession, Site, Work};
use std::collections::BTreeMap;

#[derive(Clone)]
pub(super) struct Memo {
    pub value: ValueId,
    pub dependencies: Vec<Dependency>,
}
enum TailResult {
    Value(ValueId),
    Call(ValueId, ValueId),
}
struct Evaluator<'a> {
    session: &'a mut PrototypeSession,
    globals: &'a BTreeMap<Symbol, Global>,
    budget: &'a Budget,
    work: &'a mut Work,
    site: Site,
    dependencies: Vec<Dependency>,
}

pub(super) fn evaluate(
    session: &mut PrototypeSession,
    globals: &BTreeMap<Symbol, Global>,
    term: TermId,
    budget: &Budget,
    work: &mut Work,
    site: Site,
) -> Result<(ValueId, Vec<Dependency>), Failure> {
    let mut evaluator = Evaluator {
        session,
        globals,
        budget,
        work,
        site,
        dependencies: Vec::new(),
    };
    let value = evaluator.eval(term, &mut BTreeMap::new(), 0)?;
    Ok((value, evaluator.dependencies))
}
impl Evaluator<'_> {
    fn eval(
        &mut self,
        id: TermId,
        locals: &mut BTreeMap<Local, ValueId>,
        depth: usize,
    ) -> Result<ValueId, Failure> {
        self.budget.depth(self.site, depth)?;
        self.budget.tick(self.site)?;
        self.work.static_steps += 1;
        if self.work.static_steps.is_multiple_of(128)
            && self.session.charged_storage() > self.session.limits.retained_storage_bytes
        {
            return Err(Failure::limit(
                self.site,
                "experimental retained-storage budget exhausted; reset the session",
            ));
        }
        let value = match self.session.terms.nodes[id].node.clone() {
            Node::Blocked(_) => {
                return Err(Failure::invariant(
                    self.site,
                    "staging hole reached typed evaluation",
                ));
            }
            Node::Constant(value) => return Ok(value),
            Node::Primitive(p) => Value::Primitive(p, Vec::new()),
            Node::Local(slot) => {
                return locals.get(&slot).copied().ok_or_else(|| {
                    Failure::source(
                        self.site,
                        "runtime binding is unavailable to required compile-time execution",
                    )
                });
            }
            Node::Global(symbol) => {
                let global = self.globals.get(&symbol).ok_or_else(|| {
                    Failure::invariant(
                        self.site,
                        "static global is not in the resolved dependency view",
                    )
                })?;
                self.dependencies.push(Dependency::StaticBody {
                    symbol,
                    term: global.term,
                });
                return self.eval(global.term, &mut BTreeMap::new(), depth + 1);
            }
            Node::Instance(term) => return self.eval(term, locals, depth + 1),
            Node::Function { parameter, body }
            | Node::RecursiveFunction {
                parameter, body, ..
            } => {
                let mut free = self
                    .session
                    .terms
                    .free_locals(body, self.budget, self.site)?;
                free.remove(&parameter);
                if let Node::RecursiveFunction { recursive, .. } = self.session.terms.nodes[id].node
                {
                    free.remove(&recursive);
                }
                let mut captures = BTreeMap::new();
                for slot in free {
                    captures.insert(
                        slot,
                        *locals.get(&slot).ok_or_else(|| {
                            Failure::source(
                                self.site,
                                "compile-time closure captures a runtime binding",
                            )
                        })?,
                    );
                }
                Value::Closure {
                    function: id,
                    captures,
                }
            }
            Node::Call(f, a) => {
                let f = self.eval(f, locals, depth + 1)?;
                let a = self.eval(a, locals, depth + 1)?;
                return self.call(f, a, depth + 1);
            }
            Node::Tuple(xs) => Value::Tuple(
                xs.into_iter()
                    .map(|x| self.eval(x, locals, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Node::Array(xs) => Value::Array(
                xs.into_iter()
                    .map(|x| self.eval(x, locals, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Node::Variant(name, payload) => Value::Variant(
                name,
                payload
                    .map(|x| self.eval(x, locals, depth + 1))
                    .transpose()?,
            ),
            Node::Case {
                target,
                arms,
                fallback,
            } => {
                let value = self.eval(target, locals, depth + 1)?;
                let Value::Variant(name, payload) = self.session.values.nodes[value].clone() else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked case received a non-variant",
                    ));
                };
                let matched = arms.iter().find(|(label, _, _)| label == &name);
                let (binding, body) = if let Some((_, parameter, body)) = matched {
                    if parameter.is_some() != payload.is_some() {
                        return Err(Failure::invariant(
                            self.site,
                            "checked constructor payload arity differs",
                        ));
                    }
                    (parameter.zip(payload), *body)
                } else if let Some((parameter, body)) = fallback {
                    (Some((parameter, value)), body)
                } else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked exhaustive case missed a constructor",
                    ));
                };
                let saved = binding.map(|(local, value)| (local, locals.insert(local, value)));
                let result = self.eval(body, locals, depth + 1);
                if let Some((local, old)) = saved {
                    if let Some(old) = old {
                        locals.insert(local, old);
                    } else {
                        locals.remove(&local);
                    }
                }
                return result;
            }
            Node::Record(fs) => {
                let mut fields = BTreeMap::new();
                for (n, x) in fs {
                    fields.insert(n, self.eval(x, locals, depth + 1)?);
                }
                Value::Record(fields)
            }
            Node::Project(x, index) => {
                let value = self.eval(x, locals, depth + 1)?;
                let Value::Tuple(xs) = &self.session.values.nodes[value] else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked tuple projection received a non-tuple",
                    ));
                };
                return xs.get(index).copied().ok_or_else(|| {
                    Failure::invariant(self.site, "checked tuple projection is out of range")
                });
            }
            Node::Field(x, name) => {
                let value = self.eval(x, locals, depth + 1)?;
                let Value::Record(fs) = &self.session.values.nodes[value] else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked field projection received a non-record",
                    ));
                };
                return fs.get(&name).copied().ok_or_else(|| {
                    Failure::invariant(self.site, "checked field projection is absent")
                });
            }
            Node::Let { local, value, body } => {
                let value = self.eval(value, locals, depth + 1)?;
                let saved = locals.insert(local, value);
                let result = self.eval(body, locals, depth + 1);
                if let Some(saved) = saved {
                    locals.insert(local, saved);
                } else {
                    locals.remove(&local);
                }
                return result;
            }
            Node::If(test, yes, no) => {
                let test = self.eval(test, locals, depth + 1)?;
                let Value::Bool(test) = self.session.values.nodes[test] else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked condition is not Boolean",
                    ));
                };
                return self.eval(if test { yes } else { no }, locals, depth + 1);
            }
            Node::Quote(term) => {
                if !self
                    .session
                    .terms
                    .free_locals(term, self.budget, self.site)?
                    .is_empty()
                {
                    return Err(Failure::source(
                        self.site,
                        "quotation has escaping local slots",
                    ));
                }
                Value::Code(term)
            }
        };
        Ok(self.session.values.intern(value))
    }
    // A typed tail position does not require retaining the current call frame.
    // Non-tail subexpressions still use the bounded evaluator, and every jump
    // consumes work. This is execution, not source-level unrolling.
    fn eval_tail(
        &mut self,
        mut id: TermId,
        locals: &mut BTreeMap<Local, ValueId>,
        depth: usize,
    ) -> Result<TailResult, Failure> {
        loop {
            self.budget.depth(self.site, depth)?;
            self.budget.tick(self.site)?;
            self.work.static_steps += 1;
            match self.session.terms.nodes[id].node.clone() {
                Node::Instance(term) => id = term,
                Node::Let { local, value, body } => {
                    let value = self.eval(value, locals, depth + 1)?;
                    locals.insert(local, value);
                    id = body;
                }
                Node::If(test, yes, no) => {
                    let test = self.eval(test, locals, depth + 1)?;
                    let Value::Bool(test) = self.session.values.nodes[test] else {
                        return Err(Failure::invariant(
                            self.site,
                            "checked tail condition is not Boolean",
                        ));
                    };
                    id = if test { yes } else { no };
                }
                Node::Case {
                    target,
                    arms,
                    fallback,
                } => {
                    let value = self.eval(target, locals, depth + 1)?;
                    let Value::Variant(name, payload) = self.session.values.nodes[value].clone()
                    else {
                        return Err(Failure::invariant(
                            self.site,
                            "checked tail case has a non-variant subject",
                        ));
                    };
                    if let Some((_, parameter, body)) = arms.iter().find(|(tag, _, _)| tag == &name)
                    {
                        if parameter.is_some() != payload.is_some() {
                            return Err(Failure::invariant(
                                self.site,
                                "checked tail constructor arity differs",
                            ));
                        }
                        if let Some((local, value)) = parameter.zip(payload) {
                            locals.insert(local, value);
                        }
                        id = *body;
                    } else if let Some((parameter, body)) = fallback {
                        locals.insert(parameter, value);
                        id = body;
                    } else {
                        return Err(Failure::invariant(
                            self.site,
                            "checked exhaustive tail case missed a constructor",
                        ));
                    }
                }
                Node::Call(function, argument) => {
                    let function = self.eval(function, locals, depth + 1)?;
                    let argument = self.eval(argument, locals, depth + 1)?;
                    return Ok(TailResult::Call(function, argument));
                }
                _ => return self.eval(id, locals, depth).map(TailResult::Value),
            }
        }
    }

    fn call(
        &mut self,
        function: ValueId,
        argument: ValueId,
        depth: usize,
    ) -> Result<ValueId, Failure> {
        self.budget.depth(self.site, depth)?;
        self.budget.tick(self.site)?;
        let key = (function, argument);
        if let Some(memo) = self.session.static_cache.get(&key).cloned() {
            let valid = memo.dependencies.iter().all(|d| match d {
                Dependency::StaticBody { symbol, term } => {
                    self.globals.get(symbol).is_some_and(|g| g.term == *term)
                }
                _ => false,
            });
            if valid {
                for _ in &memo.dependencies {
                    self.budget.tick(self.site)?;
                }
                self.work.static_cache_hits += 1;
                self.dependencies.extend(memo.dependencies);
                return Ok(memo.value);
            }
        }
        let first = self.dependencies.len();
        let fresh_before = self.work.fresh_identities;
        let mut callable = function;
        let mut argument = argument;
        let result = loop {
            self.budget.tick(self.site)?;
            if self.work.static_calls.is_multiple_of(128)
                && self.session.charged_storage() > self.session.limits.retained_storage_bytes
            {
                return Err(Failure::limit(
                    self.site,
                    "experimental retained-storage budget exhausted; reset the session",
                ));
            }
            self.work.static_calls += 1;
            match self.session.values.nodes[callable].clone() {
                Value::Closure { function, captures } => {
                    let (parameter, body, recursive) = match self.session.terms.nodes[function].node
                    {
                        Node::Function { parameter, body } => (parameter, body, None),
                        Node::RecursiveFunction {
                            recursive,
                            parameter,
                            body,
                        } => (parameter, body, Some(recursive)),
                        _ => {
                            return Err(Failure::invariant(
                                self.site,
                                "closure does not reference a function",
                            ));
                        }
                    };
                    let mut locals = captures;
                    if let Some(recursive) = recursive {
                        locals.insert(recursive, callable);
                    }
                    locals.insert(parameter, argument);
                    match self.eval_tail(body, &mut locals, depth + 1)? {
                        TailResult::Value(value) => break value,
                        TailResult::Call(next, value) => {
                            callable = next;
                            argument = value;
                            self.work.static_tail_calls += 1;
                        }
                    }
                }
                Value::Primitive(p, args) => break self.primitive(p, args, argument, depth)?,
                _ => {
                    return Err(Failure::invariant(
                        self.site,
                        "checked static application has no callable value",
                    ));
                }
            }
        };
        if self.work.fresh_identities == fresh_before {
            let mut seen = std::collections::HashSet::new();
            let dependencies = self.dependencies[first..]
                .iter()
                .filter(|d| seen.insert((*d).clone()))
                .cloned()
                .collect::<Vec<_>>();
            // Admission is bounded; declining a memo never declines execution.
            if dependencies.len() > 4096 {
                return Ok(result);
            }
            if self.session.static_cache.len() >= 1024 {
                self.session.static_cache.clear();
            }
            self.session.static_cache.insert(
                key,
                Memo {
                    value: result,
                    dependencies,
                },
            );
        }
        Ok(result)
    }
    fn code_value(&self, value: ValueId) -> Result<TermId, Failure> {
        if let Value::Code(term) = self.session.values.nodes[value] {
            Ok(term)
        } else {
            Err(Failure::source(
                self.site,
                "typed generation requires a private checked Code value",
            ))
        }
    }
    fn code_primitive(
        &mut self,
        p: Primitive,
        argument: ValueId,
        depth: usize,
    ) -> Result<ValueId, Failure> {
        let term = if p == Primitive::CodeTuple || p == Primitive::CodeRecord {
            let Value::Array(values) = self.session.values.nodes[argument].clone() else {
                return Err(Failure::invariant(
                    self.site,
                    "checked generated aggregate inputs",
                ));
            };
            if p == Primitive::CodeTuple {
                let mut terms = Vec::new();
                for value in values {
                    self.budget.tick(self.site)?;
                    terms.push(self.code_value(value)?);
                }
                let ty = self.session.types.intern(Type::Tuple(
                    terms
                        .iter()
                        .map(|t| self.session.terms.nodes[*t].ty)
                        .collect(),
                ));
                self.session.terms.intern(Node::Tuple(terms), ty)
            } else {
                let mut terms = Vec::new();
                let mut types = BTreeMap::new();
                for value in values {
                    self.budget.tick(self.site)?;
                    let Value::Tuple(pair) = &self.session.values.nodes[value] else {
                        return Err(Failure::invariant(
                            self.site,
                            "checked generated field pair",
                        ));
                    };
                    let Value::Text(name) = &self.session.values.nodes[pair[0]] else {
                        return Err(Failure::invariant(
                            self.site,
                            "checked generated field name",
                        ));
                    };
                    let term = self.code_value(pair[1])?;
                    if types
                        .insert(name.clone(), self.session.terms.nodes[term].ty)
                        .is_some()
                    {
                        return Err(Failure::source(
                            self.site,
                            "duplicate generated record field",
                        ));
                    }
                    terms.push((name.clone(), term));
                }
                let row = self.session.types.intern(Type::Row(types, None));
                let ty = self.session.types.intern(Type::Record(row));
                self.session.terms.intern(Node::Record(terms), ty)
            }
        } else if p == Primitive::CodeLift {
            let mut pending = vec![argument];
            let mut seen = std::collections::HashSet::new();
            while let Some(v) = pending.pop() {
                self.budget.tick(self.site)?;
                if !seen.insert(v) {
                    continue;
                }
                match &self.session.values.nodes[v] {
                    Value::Int(_) | Value::Bool(_) | Value::Unit => {}
                    Value::Array(xs) | Value::Tuple(xs) => pending.extend(xs),
                    Value::Record(fields) => pending.extend(fields.values()),
                    Value::Variant(_, payload) => pending.extend(payload),
                    _ => {
                        return Err(Failure::source(
                            self.site,
                            "code_lift requires immutable runtime data, not Type/Code/Text or static closures",
                        ));
                    }
                }
            }
            let ty = self.session.value_type(argument, self.budget, self.site)?;
            self.session.terms.intern(Node::Constant(argument), ty)
        } else {
            let Value::Tuple(parts) = self.session.values.nodes[argument].clone() else {
                return Err(Failure::invariant(
                    self.site,
                    "checked code-builder argument tuple",
                ));
            };
            if p == Primitive::CodeLambda {
                let Value::Type(input) = self.session.values.nodes[parts[0]] else {
                    return Err(Failure::source(
                        self.site,
                        "code_lambda requires an input Type",
                    ));
                };
                if !self.session.types.closed(input) {
                    return Err(Failure::source(
                        self.site,
                        "generated binders require a settled input Type",
                    ));
                }
                // Ordinary checker slots use the lower half of this space. No
                // generated binder is reused while a session retains code values.
                let parameter = self
                    .session
                    .next_code_local
                    .checked_add(1 << 31)
                    .ok_or_else(|| {
                        Failure::limit(
                            self.site,
                            "generated binder space exhausted; reset the session",
                        )
                    })?;
                self.session.next_code_local += 1;
                let local = self.session.terms.intern(Node::Local(parameter), input);
                let local = self.session.values.intern(Value::Code(local));
                let body = self.call(parts[1], local, depth + 1)?;
                let body = self.code_value(body)?;
                let ty = self
                    .session
                    .types
                    .intern(Type::Function(input, self.session.terms.nodes[body].ty));
                self.session
                    .terms
                    .intern(Node::Function { parameter, body }, ty)
            } else {
                let mut inference = super::types::Inference::new(self.budget.clone());
                let first = self.code_value(parts[0])?;
                let first_ty = inference.import(
                    &self.session.types,
                    self.session.terms.nodes[first].ty,
                    self.site,
                )?;
                let (node, ty) = match p {
                    Primitive::CodeApply => {
                        let argument = self.code_value(parts[1])?;
                        let arg_ty = inference.import(
                            &self.session.types,
                            self.session.terms.nodes[argument].ty,
                            self.site,
                        )?;
                        let output = inference.fresh(super::types::Kind::Value);
                        let function = inference.function(arg_ty, output);
                        inference.unify(first_ty, function, self.site)?;
                        (Node::Call(first, argument), output)
                    }
                    Primitive::CodeIf => {
                        let yes = self.code_value(parts[1])?;
                        let no = self.code_value(parts[2])?;
                        let boolean = inference.atom(super::types::BOOL);
                        inference.unify(first_ty, boolean, self.site)?;
                        let yty = inference.import(
                            &self.session.types,
                            self.session.terms.nodes[yes].ty,
                            self.site,
                        )?;
                        let nty = inference.import(
                            &self.session.types,
                            self.session.terms.nodes[no].ty,
                            self.site,
                        )?;
                        inference.unify(yty, nty, self.site)?;
                        (Node::If(first, yes, no), yty)
                    }
                    Primitive::CodeField => {
                        let Value::Text(name) = &self.session.values.nodes[parts[1]] else {
                            return Err(Failure::invariant(self.site, "checked code field name"));
                        };
                        let output = inference.fresh(super::types::Kind::Value);
                        let record =
                            inference.record(BTreeMap::from([(name.clone(), output)]), true);
                        inference.unify(first_ty, record, self.site)?;
                        (Node::Field(first, name.clone()), output)
                    }
                    _ => {
                        return Err(Failure::invariant(
                            self.site,
                            "invalid code-builder dispatch",
                        ));
                    }
                };
                let ty = inference.freeze(
                    &mut self.session.types,
                    ty,
                    &mut Default::default(),
                    &mut Default::default(),
                    self.site,
                )?;
                self.work.unification_steps += inference.steps;
                self.session.terms.intern(node, ty)
            }
        };
        Ok(self.session.values.intern(Value::Code(term)))
    }
    fn primitive(
        &mut self,
        p: Primitive,
        mut args: Vec<ValueId>,
        arg: ValueId,
        depth: usize,
    ) -> Result<ValueId, Failure> {
        let value = match p {
            Primitive::CodeLambda
            | Primitive::CodeApply
            | Primitive::CodeLift
            | Primitive::CodeIf
            | Primitive::CodeField
            | Primitive::CodeTuple
            | Primitive::CodeRecord => {
                return self.code_primitive(p, arg, depth);
            }
            Primitive::Add
            | Primitive::Sub
            | Primitive::Mul
            | Primitive::Equal
            | Primitive::Less => {
                let Value::Tuple(pair) = &self.session.values.nodes[arg] else {
                    return Err(Failure::invariant(
                        self.site,
                        "arithmetic argument is not a tuple",
                    ));
                };
                if pair.len() != 2 {
                    return Err(Failure::invariant(self.site, "arithmetic arity"));
                }
                let (Value::Int(a), Value::Int(b)) = (
                    &self.session.values.nodes[pair[0]],
                    &self.session.values.nodes[pair[1]],
                ) else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked arithmetic argument is not Int64",
                    ));
                };
                match p {
                    Primitive::Add => Value::Int(a.wrapping_add(*b)),
                    Primitive::Sub => Value::Int(a.wrapping_sub(*b)),
                    Primitive::Mul => Value::Int(a.wrapping_mul(*b)),
                    Primitive::Equal => Value::Bool(a == b),
                    Primitive::Less => Value::Bool(a < b),
                    _ => unreachable!(),
                }
            }
            Primitive::ArrayType => {
                let Value::Type(element) = self.session.values.nodes[arg] else {
                    return Err(Failure::source(self.site, "array type requires a Type"));
                };
                Value::Type(self.session.types.intern(Type::Array(element)))
            }
            Primitive::ArrayLen => {
                let Value::Array(xs) = &self.session.values.nodes[arg] else {
                    return Err(Failure::invariant(self.site, "checked array length"));
                };
                Value::Int(xs.len() as i64)
            }
            Primitive::ArrayAt | Primitive::ArrayPush | Primitive::ArrayFold => {
                let Value::Tuple(parts) = self.session.values.nodes[arg].clone() else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked array operation arity",
                    ));
                };
                let Value::Array(mut xs) = self.session.values.nodes[parts[0]].clone() else {
                    return Err(Failure::invariant(
                        self.site,
                        "checked array operation input",
                    ));
                };
                match p {
                    Primitive::ArrayAt => {
                        let Value::Int(index) = self.session.values.nodes[parts[1]] else {
                            return Err(Failure::invariant(self.site, "checked array index"));
                        };
                        if let Ok(index) = usize::try_from(index) {
                            if let Some(value) = xs.get(index) {
                                Value::Variant("Some".into(), Some(*value))
                            } else {
                                Value::Variant("None".into(), None)
                            }
                        } else {
                            Value::Variant("None".into(), None)
                        }
                    }
                    Primitive::ArrayPush => {
                        for _ in &xs {
                            self.budget.tick(self.site)?;
                        }
                        xs.push(parts[1]);
                        Value::Array(xs)
                    }
                    Primitive::ArrayFold => {
                        let mut out = parts[2];
                        for value in xs {
                            self.budget.tick(self.site)?;
                            let pair = self.session.values.intern(Value::Tuple(vec![out, value]));
                            out = self.call(parts[1], pair, depth + 1)?;
                        }
                        return Ok(out);
                    }
                    _ => unreachable!(),
                }
            }
            Primitive::TypeEqual => {
                let Value::Tuple(pair) = &self.session.values.nodes[arg] else {
                    return Err(Failure::invariant(self.site, "type comparison arity"));
                };
                let (Value::Type(a), Value::Type(b)) = (
                    &self.session.values.nodes[pair[0]],
                    &self.session.values.nodes[pair[1]],
                ) else {
                    return Err(Failure::invariant(self.site, "type comparison inputs"));
                };
                Value::Bool(a == b)
            }
            Primitive::TypeFields => {
                let Value::Type(schema) = self.session.values.nodes[arg] else {
                    return Err(Failure::source(self.site, "fields requires a Type"));
                };
                let Type::Record(row) = self.session.types.nodes[schema] else {
                    return Err(Failure::source(self.site, "fields requires a record type"));
                };
                let Type::Row(fields, None) = self.session.types.nodes[row].clone() else {
                    return Err(Failure::source(
                        self.site,
                        "fields requires a closed record type",
                    ));
                };
                let mut out = Vec::with_capacity(fields.len());
                for (name, ty) in fields {
                    self.budget.tick(self.site)?;
                    let n = self.session.values.intern(Value::Text(name));
                    let t = self.session.values.intern(Value::Type(ty));
                    out.push(self.session.values.intern(Value::Tuple(vec![n, t])));
                }
                Value::Array(out)
            }
            Primitive::RecordFields => {
                let Value::Array(fields) = self.session.values.nodes[arg].clone() else {
                    return Err(Failure::source(
                        self.site,
                        "record_fields requires field pairs",
                    ));
                };
                let mut types = BTreeMap::new();
                for field in fields {
                    self.budget.tick(self.site)?;
                    let Value::Tuple(pair) = &self.session.values.nodes[field] else {
                        return Err(Failure::invariant(self.site, "checked field pair"));
                    };
                    let (Value::Text(name), Value::Type(ty)) = (
                        &self.session.values.nodes[pair[0]],
                        &self.session.values.nodes[pair[1]],
                    ) else {
                        return Err(Failure::invariant(self.site, "checked field pair types"));
                    };
                    if !self.session.types.closed(*ty) {
                        return Err(Failure::source(self.site, "computed field type is open"));
                    }
                    if types.insert(name.clone(), *ty).is_some() {
                        return Err(Failure::source(
                            self.site,
                            format!("duplicate generated field `{name}`"),
                        ));
                    }
                }
                let row = self.session.types.intern(Type::Row(types, None));
                Value::Type(self.session.types.intern(Type::Record(row)))
            }
            Primitive::RecordType => {
                let Value::Record(fields) = self.session.values.nodes[arg].clone() else {
                    return Err(Failure::source(
                        self.site,
                        "record-type bridge requires a record of Type values",
                    ));
                };
                let mut types = BTreeMap::new();
                for (name, value) in fields {
                    self.budget.tick(self.site)?;
                    let Value::Type(ty) = self.session.values.nodes[value] else {
                        return Err(Failure::source(
                            self.site,
                            format!("record-type field `{name}` is not a Type"),
                        ));
                    };
                    if !self.session.types.closed(ty) {
                        return Err(Failure::source(
                            self.site,
                            "open inference variables cannot escape a computed schema",
                        ));
                    }
                    types.insert(name, ty);
                }
                let row = self.session.types.intern(Type::Row(types, None));
                Value::Type(self.session.types.intern(Type::Record(row)))
            }
            Primitive::Getter => {
                let Value::Tuple(pair) = &self.session.values.nodes[arg] else {
                    return Err(Failure::invariant(self.site, "getter arity"));
                };
                if pair.len() != 2 {
                    return Err(Failure::invariant(self.site, "getter arity"));
                }
                let (Value::Type(schema), Value::Text(field)) = (
                    &self.session.values.nodes[pair[0]],
                    &self.session.values.nodes[pair[1]],
                ) else {
                    return Err(Failure::invariant(
                        self.site,
                        "getter's checked argument types",
                    ));
                };
                let schema = *schema;
                let field = field.clone();
                let Type::Record(row) = &self.session.types.nodes[schema] else {
                    return Err(Failure::source(
                        self.site,
                        "getter generator requires a record schema",
                    ));
                };
                let Type::Row(fields, None) = &self.session.types.nodes[*row] else {
                    return Err(Failure::source(
                        self.site,
                        "getter generator requires a closed row",
                    ));
                };
                let output = *fields.get(&field).ok_or_else(|| {
                    Failure::source(self.site, format!("schema has no field `{field}`"))
                })?;
                let parameter = self.session.terms.intern(Node::Local(0), schema);
                let body = self
                    .session
                    .terms
                    .intern(Node::Field(parameter, field), output);
                let ty = self.session.types.intern(Type::Function(schema, output));
                let code = self
                    .session
                    .terms
                    .intern(Node::Function { parameter: 0, body }, ty);
                Value::Code(code)
            }
            Primitive::Fresh => {
                if !matches!(self.session.values.nodes[arg], Value::Unit) {
                    return Err(Failure::invariant(self.site, "fresh requires Unit"));
                }
                let atom = self.session.next_nominal;
                self.session.next_nominal =
                    self.session.next_nominal.checked_add(1).ok_or_else(|| {
                        Failure::limit(self.site, "nominal identity space exhausted")
                    })?;
                self.work.fresh_identities += 1;
                Value::Type(self.session.types.intern(Type::Nominal(atom)))
            }
            Primitive::Iterate => {
                let Value::Tuple(parts) = self.session.values.nodes[arg].clone() else {
                    return Err(Failure::invariant(self.site, "iterate arity"));
                };
                if parts.len() != 3 {
                    return Err(Failure::invariant(self.site, "iterate arity"));
                }
                let Value::Int(count) = self.session.values.nodes[parts[0]] else {
                    return Err(Failure::invariant(self.site, "iterate count type"));
                };
                if count < 0 {
                    return Err(Failure::source(
                        self.site,
                        "iterate count must be nonnegative",
                    ));
                }
                let mut value = parts[2];
                for _ in 0..count {
                    self.budget.tick(self.site)?;
                    value = self.call(parts[1], value, depth + 1)?;
                }
                return Ok(value);
            }
            Primitive::Arrow => {
                args.push(arg);
                if args.len() == 1 {
                    return Ok(self.session.values.intern(Value::Primitive(p, args)));
                }
                let (Value::Type(a), Value::Type(b)) = (
                    &self.session.values.nodes[args[0]],
                    &self.session.values.nodes[args[1]],
                ) else {
                    return Err(Failure::source(self.site, "arrow requires Type values"));
                };
                Value::Type(self.session.types.intern(Type::Function(*a, *b)))
            }
        };
        Ok(self.session.values.intern(value))
    }
}
