use super::*;

/// A source-only binding plan. An open namespace deliberately stops static resolution.
pub(super) struct Layout {
    loads: HashMap<ExpressionId, Option<usize>>,
    slots: usize,
}

struct Scope {
    parent: Option<Rc<Scope>>,
    names: HashMap<String, usize>,
    dynamic: bool,
}

impl Drop for Scope {
    fn drop(&mut self) {
        let mut parent = self.parent.take();
        while let Some(scope) = parent {
            let Ok(mut scope) = Rc::try_unwrap(scope) else {
                break;
            };
            parent = scope.parent.take();
        }
    }
}

impl Scope {
    fn bind(parent: Option<Rc<Self>>, names: Vec<String>, slots: &mut usize) -> Rc<Self> {
        let names = names
            .into_iter()
            .map(|name| {
                let slot = *slots;
                *slots += 1;
                (name, slot)
            })
            .collect();
        Rc::new(Self {
            parent,
            names,
            dynamic: false,
        })
    }
}

impl Layout {
    pub(super) fn compile(module: &Module, parameter: PatternId, body: ExpressionId) -> Self {
        let mut layout = Self {
            loads: HashMap::new(),
            slots: 0,
        };
        let scope = Scope::bind(None, pattern_names(module, parameter), &mut layout.slots);
        let mut captures = HashMap::new();
        let mut pending = vec![(body, scope)];
        while let Some((expression, scope)) = pending.pop() {
            match &module.arena.expressions[expression.0 as usize] {
                Expression::Var { name, .. } => {
                    let mut current = Some(scope.clone());
                    let slot = loop {
                        let Some(frame) = current else {
                            break Some(*captures.entry(name.clone()).or_insert_with(|| {
                                let slot = layout.slots;
                                layout.slots += 1;
                                slot
                            }));
                        };
                        if let Some(slot) = frame.names.get(name) {
                            break Some(*slot);
                        }
                        if frame.dynamic {
                            break None;
                        }
                        current = frame.parent.clone();
                    };
                    layout
                        .loads
                        .entry(expression)
                        .and_modify(|prior| {
                            // Portable ASTs can share an expression across lexical scopes.
                            if *prior != slot {
                                *prior = None;
                            }
                        })
                        .or_insert(slot);
                }
                Expression::Apply {
                    function, argument, ..
                } => {
                    pending.push((*function, scope.clone()));
                    pending.push((*argument, scope));
                }
                Expression::Field { target, .. } | Expression::Rec { lambda: target, .. } => {
                    pending.push((*target, scope))
                }
                Expression::Array { elements, .. } => pending.extend(
                    elements
                        .iter()
                        .map(|element| (element.value, scope.clone())),
                ),
                Expression::Tuple { elements, .. } => pending.extend(
                    elements
                        .iter()
                        .map(|expression| (*expression, scope.clone())),
                ),
                Expression::Shape { members, .. } => {
                    for member in members {
                        match member {
                            ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => {
                                pending.push((*value, scope.clone()))
                            }
                            ShapeMember::Computed { name, value } => {
                                pending.push((*name, scope.clone()));
                                pending.push((*value, scope.clone()));
                            }
                        }
                    }
                }
                Expression::If {
                    branches, fallback, ..
                } => {
                    for branch in branches {
                        pending.push((branch.condition, scope.clone()));
                        pending.push((branch.consequence, scope.clone()));
                    }
                    if let Some(fallback) = fallback {
                        pending.push((*fallback, scope));
                    }
                }
                Expression::Case { target, arms, .. } => {
                    pending.push((*target, scope.clone()));
                    for arm in arms {
                        let arm_scope = Scope::bind(
                            Some(scope.clone()),
                            pattern_names(module, arm.pattern),
                            &mut layout.slots,
                        );
                        pending.push((arm.body, arm_scope));
                    }
                }
                Expression::Block {
                    declarations,
                    result,
                    ..
                } => {
                    let mut scope = scope;
                    for declaration in declarations {
                        match &module.arena.declarations[declaration.0 as usize] {
                            Declaration::Signature { value, .. } => {
                                pending.push((*value, scope.clone()))
                            }
                            Declaration::Binding {
                                pattern,
                                value,
                                tags,
                                ..
                            } => {
                                pending.push((*value, scope.clone()));
                                pending
                                    .extend(tags.iter().map(|tag| (tag.descriptor, scope.clone())));
                                scope = Scope::bind(
                                    Some(scope),
                                    pattern_names(module, *pattern),
                                    &mut layout.slots,
                                );
                            }
                            Declaration::Shadow { name, value, .. } => {
                                pending.push((*value, scope.clone()));
                                scope =
                                    Scope::bind(Some(scope), vec![name.clone()], &mut layout.slots);
                            }
                            Declaration::Open { value, .. } => {
                                pending.push((*value, scope.clone()));
                                scope = Rc::new(Scope {
                                    parent: Some(scope),
                                    names: HashMap::new(),
                                    dynamic: true,
                                });
                            }
                        }
                    }
                    pending.push((*result, scope));
                }
                // A nested function has a separate activation and binding plan.
                Expression::Lambda { .. }
                | Expression::Unit { .. }
                | Expression::Int { .. }
                | Expression::Float { .. }
                | Expression::Text { .. }
                | Expression::Tag { .. }
                | Expression::Intrinsic { .. } => {}
            }
        }
        layout
    }
}

pub(in crate::eval) struct Locals {
    module: Rc<String>,
    layout: Rc<Layout>,
    base: Environment,
    values: Vec<OnceCell<Value>>,
}

impl Locals {
    pub(in crate::eval) fn new(
        context: &Context,
        module: &Rc<String>,
        parameter: PatternId,
        body: ExpressionId,
        environment: &Environment,
    ) -> Rc<Self> {
        let modules = context.modules.borrow();
        let loaded = modules
            .get(module.as_str())
            .expect("a closure retains its source module");
        let program = loaded
            .bytecode
            .get_or_init(|| Rc::new(Program::new(loaded.module.clone())));
        let layout = program
            .bindings
            .borrow_mut()
            .entry((parameter, body))
            .or_insert_with(|| Rc::new(Layout::compile(&program.source, parameter, body)))
            .clone();
        Rc::new(Self {
            module: module.clone(),
            base: environment
                .parent
                .borrow()
                .clone()
                .expect("a closure call inherits its captures"),
            values: (0..layout.slots).map(|_| OnceCell::new()).collect(),
            layout,
        })
    }

    pub(in crate::eval) fn capture(
        &self,
        context: &Context,
        module: &Rc<String>,
        parameter: PatternId,
        body: ExpressionId,
        environment: &Environment,
    ) -> Environment {
        if self.module != *module {
            capture_env(environment);
            return environment.clone();
        }
        let modules = context.modules.borrow();
        let loaded = modules
            .get(module.as_str())
            .expect("a closure retains its source");
        let program = loaded
            .bytecode
            .get()
            .expect("an activation has compiled bindings");
        let captures = program
            .captures
            .borrow_mut()
            .entry((parameter, body))
            .or_insert_with(|| {
                let mut free = HashSet::new();
                let bound = pattern_names(&program.source, parameter)
                    .into_iter()
                    .collect();
                collect_free(&program.source, body, &mut vec![bound], &mut free);
                free.extend(pattern_pins(&program.source, parameter));
                let mut names = free.into_iter().collect::<Vec<_>>();
                names.sort();
                names.into()
            })
            .clone();
        crate::value::capture_before(environment, &self.base, &captures)
    }

    pub(in crate::eval) fn load(
        &self,
        module: &str,
        expression: ExpressionId,
        environment: &Environment,
        name: &str,
    ) -> Option<Value> {
        if self.module.as_str() != module {
            return lookup(environment, name);
        }
        let Some(Some(slot)) = self.layout.loads.get(&expression) else {
            return lookup(environment, name);
        };
        if let Some(value) = self.values[*slot].get() {
            return Some(value.clone());
        }
        // Resolve on first demand, so unopened imports and unused captures stay unobserved.
        let value = lookup(environment, name)?;
        let _ = self.values[*slot].set(value.clone());
        Some(value)
    }
}
