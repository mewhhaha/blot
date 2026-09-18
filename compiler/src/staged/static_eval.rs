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
            Node::Function { parameter, body } => {
                let mut free = self
                    .session
                    .terms
                    .free_locals(body, self.budget, self.site)?;
                free.remove(&parameter);
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
        self.work.static_calls += 1;
        let result = match self.session.values.nodes[function].clone() {
            Value::Closure { function, captures } => {
                let Node::Function { parameter, body } = self.session.terms.nodes[function].node
                else {
                    return Err(Failure::invariant(
                        self.site,
                        "closure does not reference a function",
                    ));
                };
                let mut locals = captures;
                locals.insert(parameter, argument);
                self.eval(body, &mut locals, depth + 1)?
            }
            Value::Primitive(p, args) => self.primitive(p, args, argument, depth)?,
            _ => {
                return Err(Failure::invariant(
                    self.site,
                    "checked static application has no callable value",
                ));
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
    fn primitive(
        &mut self,
        p: Primitive,
        mut args: Vec<ValueId>,
        arg: ValueId,
        depth: usize,
    ) -> Result<ValueId, Failure> {
        let value = match p {
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
