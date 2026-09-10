use super::{recursive_declaration, signature_declaration};
use crate::ast::{
    Declaration, DeclarationId, Expression, ExpressionId, Module, Pattern, PatternId, ShapeMember,
};
use crate::eval::{Context, live_declarations_for};
use std::collections::{HashMap, HashSet};

type LiveBindings = HashSet<PatternId>;

pub(super) struct BorrowLiveness {
    calls: HashMap<ExpressionId, LiveBindings>,
}

impl BorrowLiveness {
    pub(super) fn new(context: &Context, path: &str, module: &Module) -> Self {
        let mut resolver = Resolver {
            context,
            path,
            module,
            scopes: vec![HashMap::new()],
            reads: HashMap::new(),
            declarations: HashMap::new(),
            definitions: HashMap::new(),
            pins: HashMap::new(),
            dependencies: HashMap::new(),
        };
        if let Some(parameter) = module.parameter {
            resolver.bind_pattern(parameter);
        }
        resolver.block(None, &module.declarations, module.result);
        let mut planner = Planner {
            module,
            resolver,
            calls: HashMap::new(),
        };
        planner.block(
            None,
            module.result,
            LiveBindings::new(),
            &LiveBindings::new(),
        );
        for live in planner.calls.values_mut() {
            let mut pending = live.iter().copied().collect::<Vec<_>>();
            while let Some(binding) = pending.pop() {
                if let Some(captures) = planner.resolver.dependencies.get(&binding) {
                    for capture in captures {
                        if live.insert(*capture) {
                            pending.push(*capture);
                        }
                    }
                }
            }
        }
        Self {
            calls: planner.calls,
        }
    }

    pub(super) fn at_call(&self, expression: ExpressionId) -> &LiveBindings {
        self.calls
            .get(&expression)
            .expect("demanded call has borrow liveness")
    }
}

pub(super) fn declaration_groups<'a>(
    declarations: &'a [DeclarationId],
    module: &Module,
) -> Vec<&'a [DeclarationId]> {
    let mut groups = Vec::new();
    let mut index = 0;
    while index < declarations.len() {
        let start = index;
        index += 1;
        if recursive_declaration(module, declarations[start]) {
            while index < declarations.len() {
                if recursive_declaration(module, declarations[index])
                    || (signature_declaration(module, declarations[index])
                        && index + 1 < declarations.len()
                        && recursive_declaration(module, declarations[index + 1]))
                {
                    index += 1;
                } else {
                    break;
                }
            }
        }
        groups.push(&declarations[start..index]);
    }
    groups
}

struct Resolver<'a> {
    context: &'a Context,
    path: &'a str,
    module: &'a Module,
    scopes: Vec<HashMap<String, PatternId>>,
    reads: HashMap<ExpressionId, LiveBindings>,
    declarations: HashMap<Option<ExpressionId>, Vec<DeclarationId>>,
    definitions: HashMap<DeclarationId, LiveBindings>,
    pins: HashMap<PatternId, LiveBindings>,
    dependencies: HashMap<PatternId, LiveBindings>,
}

impl Resolver<'_> {
    fn lookup(&self, name: &str) -> Option<PatternId> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).copied())
    }

    fn bind_pattern(&mut self, pattern: PatternId) -> LiveBindings {
        let mut definitions = LiveBindings::new();
        let mut pins = LiveBindings::new();
        match &self.module.arena.patterns[pattern.0 as usize] {
            Pattern::Name { name, .. } => {
                self.scopes
                    .last_mut()
                    .expect("lexical scope exists")
                    .insert(name.clone(), pattern);
                definitions.insert(pattern);
            }
            Pattern::Pin { name, .. } => {
                pins.extend(self.lookup(name));
            }
            Pattern::Tuple { elements, .. } | Pattern::Array { elements, .. } => {
                for child in elements {
                    definitions.extend(self.bind_pattern(*child));
                    pins.extend(&self.pins[child]);
                }
            }
            Pattern::Constructor {
                payload: Some(child),
                ..
            } => {
                definitions.extend(self.bind_pattern(*child));
                pins.extend(&self.pins[child]);
            }
            Pattern::Shape { fields, .. } => {
                for field in fields {
                    definitions.extend(self.bind_pattern(field.pattern));
                    pins.extend(&self.pins[&field.pattern]);
                }
            }
            _ => {}
        }
        self.pins.entry(pattern).or_default().extend(pins);
        definitions
    }

    fn expression(&mut self, expression: ExpressionId) -> LiveBindings {
        let mut reads = LiveBindings::new();
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { name, .. } => reads.extend(self.lookup(name)),
            Expression::Lambda {
                parameter, body, ..
            } => {
                self.scopes.push(HashMap::new());
                let definitions = self.bind_pattern(*parameter);
                reads.extend(self.expression(*body));
                reads.retain(|binding| !definitions.contains(binding));
                reads.extend(&self.pins[parameter]);
                self.scopes.pop();
            }
            Expression::Block {
                declarations,
                result,
                ..
            } => {
                self.scopes.push(HashMap::new());
                reads.extend(self.block(Some(expression), declarations, *result));
                self.scopes.pop();
            }
            Expression::Case { target, arms, .. } => {
                reads.extend(self.expression(*target));
                let target_roots = self.carrier_roots(*target);
                for arm in arms {
                    self.scopes.push(HashMap::new());
                    let definitions = self.bind_pattern(arm.pattern);
                    for definition in &definitions {
                        self.dependencies
                            .entry(*definition)
                            .or_default()
                            .extend(&target_roots);
                    }
                    let mut arm_reads = self.expression(arm.body);
                    arm_reads.retain(|binding| !definitions.contains(binding));
                    reads.extend(arm_reads);
                    reads.extend(&self.pins[&arm.pattern]);
                    self.scopes.pop();
                }
            }
            Expression::If {
                branches, fallback, ..
            } => {
                for branch in branches {
                    reads.extend(self.expression(branch.condition));
                    reads.extend(self.expression(branch.consequence));
                }
                if let Some(fallback) = fallback {
                    reads.extend(self.expression(*fallback));
                }
            }
            _ => {
                for child in
                    expression_operands(&self.module.arena.expressions[expression.0 as usize])
                {
                    reads.extend(self.expression(child));
                }
            }
        }
        self.reads.entry(expression).or_default().extend(&reads);
        reads
    }

    fn block(
        &mut self,
        block: Option<ExpressionId>,
        declarations: &[DeclarationId],
        result: ExpressionId,
    ) -> LiveBindings {
        let declarations = live_declarations_for(
            self.context,
            self.path,
            self.module,
            block,
            declarations,
            result,
        )
        .iter()
        .map(|declaration| declaration.declaration)
        .collect::<Vec<_>>();
        let mut reads = LiveBindings::new();
        let mut locals = LiveBindings::new();
        for group in declaration_groups(&declarations, self.module) {
            let recursive = recursive_declaration(self.module, group[0]);
            if recursive {
                for declaration in group {
                    if let Declaration::Binding { pattern, .. } =
                        self.module.arena.declarations[declaration.0 as usize]
                    {
                        let definitions = self.bind_pattern(pattern);
                        locals.extend(&definitions);
                        self.definitions.insert(*declaration, definitions);
                    }
                }
            }
            for declaration in group {
                match &self.module.arena.declarations[declaration.0 as usize] {
                    Declaration::Signature { .. } => {}
                    Declaration::Binding { pattern, value, .. } => {
                        let value_reads = self.expression(*value);
                        reads.extend(&value_reads);
                        if !recursive {
                            let definitions = self.bind_pattern(*pattern);
                            locals.extend(&definitions);
                            self.definitions.insert(*declaration, definitions);
                        }
                        reads.extend(&self.pins[pattern]);
                        let roots = self.carrier_roots(*value);
                        for definition in &self.definitions[declaration] {
                            self.dependencies
                                .entry(*definition)
                                .or_default()
                                .extend(&roots);
                        }
                    }
                    Declaration::Shadow { name, value, .. } => {
                        self.definitions
                            .insert(*declaration, self.lookup(name).into_iter().collect());
                        reads.extend(self.expression(*value));
                        let roots = self.carrier_roots(*value);
                        for definition in &self.definitions[declaration] {
                            self.dependencies
                                .entry(*definition)
                                .or_default()
                                .extend(&roots);
                        }
                    }
                    Declaration::Open { value, .. } => reads.extend(self.expression(*value)),
                }
            }
        }
        reads.extend(self.expression(result));
        reads.retain(|binding| !locals.contains(binding));
        self.declarations.insert(block, declarations);
        reads
    }

    fn carrier_roots(&self, expression: ExpressionId) -> LiveBindings {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Var { .. }
            | Expression::Field { .. }
            | Expression::Lambda { .. }
            | Expression::Rec { .. } => self.reads[&expression].clone(),
            Expression::Apply {
                function, argument, ..
            } if matches!(
                &self.module.arena.expressions[function.0 as usize],
                Expression::Intrinsic { name, .. } if name == "@linear.borrow"
            ) =>
            {
                self.reads[argument].clone()
            }
            Expression::Block { result, .. } => self.carrier_roots(*result),
            Expression::If {
                branches, fallback, ..
            } => branches
                .iter()
                .map(|branch| branch.consequence)
                .chain(*fallback)
                .flat_map(|branch| self.carrier_roots(branch))
                .collect(),
            Expression::Case { arms, .. } => arms
                .iter()
                .flat_map(|arm| self.carrier_roots(arm.body))
                .collect(),
            Expression::Tuple { .. } | Expression::Array { .. } | Expression::Shape { .. } => {
                expression_operands(&self.module.arena.expressions[expression.0 as usize])
                    .into_iter()
                    .flat_map(|operand| self.carrier_roots(operand))
                    .collect()
            }
            _ => LiveBindings::new(),
        }
    }
}

struct Planner<'a> {
    module: &'a Module,
    resolver: Resolver<'a>,
    calls: HashMap<ExpressionId, LiveBindings>,
}

impl Planner<'_> {
    fn expression(
        &mut self,
        expression: ExpressionId,
        mut after: LiveBindings,
        held: &LiveBindings,
    ) -> LiveBindings {
        match &self.module.arena.expressions[expression.0 as usize] {
            Expression::Lambda { body, .. } => {
                self.expression(*body, LiveBindings::new(), &LiveBindings::new());
                after.extend(&self.resolver.reads[&expression]);
                after
            }
            Expression::Block { result, .. } => self.block(Some(expression), *result, after, held),
            Expression::If {
                branches, fallback, ..
            } => {
                let mut next = after.clone();
                if let Some(fallback) = fallback {
                    next = self.expression(*fallback, after.clone(), held);
                }
                for branch in branches.iter().rev() {
                    next.extend(self.expression(branch.consequence, after.clone(), held));
                    next = self.expression(branch.condition, next, held);
                }
                next
            }
            Expression::Case { target, arms, .. } => {
                let mut arm_held = held.clone();
                arm_held.extend(&self.resolver.reads[target]);
                let mut before = after.clone();
                for arm in arms {
                    let mut arm_reads = self.expression(arm.body, after.clone(), &arm_held);
                    arm_reads.retain(|binding| {
                        !super::pattern_contains(self.module, arm.pattern, *binding)
                    });
                    arm_reads.extend(&self.resolver.pins[&arm.pattern]);
                    before.extend(arm_reads);
                }
                self.expression(*target, before, held)
            }
            Expression::Apply {
                function, argument, ..
            } => {
                let mut live = after.clone();
                live.extend(held);
                // Until an operand is consumed, its borrowed result may remain
                // on the evaluation stack. Keep its source roots conservatively.
                live.extend(&self.resolver.reads[function]);
                live.extend(&self.resolver.reads[argument]);
                self.calls.entry(expression).or_default().extend(live);
                self.sequence(&[*function, *argument], after, held)
            }
            _ => {
                let operands =
                    expression_operands(&self.module.arena.expressions[expression.0 as usize]);
                if operands.is_empty() {
                    after.extend(&self.resolver.reads[&expression]);
                    after
                } else {
                    self.sequence(&operands, after, held)
                }
            }
        }
    }

    fn sequence(
        &mut self,
        operands: &[ExpressionId],
        mut after: LiveBindings,
        held: &LiveBindings,
    ) -> LiveBindings {
        let mut prefix = held.clone();
        let mut prefixes = Vec::with_capacity(operands.len());
        for operand in operands {
            prefixes.push(prefix.clone());
            prefix.extend(&self.resolver.reads[operand]);
        }
        for (operand, prefix) in operands.iter().zip(prefixes).rev() {
            after = self.expression(*operand, after, &prefix);
        }
        after
    }

    fn block(
        &mut self,
        block: Option<ExpressionId>,
        result: ExpressionId,
        after: LiveBindings,
        held: &LiveBindings,
    ) -> LiveBindings {
        let mut live = self.expression(result, after, held);
        let declarations = self.resolver.declarations[&block].clone();
        for group in declaration_groups(&declarations, self.module)
            .into_iter()
            .rev()
        {
            for declaration in group {
                if let Some(definitions) = self.resolver.definitions.get(declaration) {
                    live.retain(|binding| !definitions.contains(binding));
                }
            }
            for declaration in group.iter().rev() {
                let value = match &self.module.arena.declarations[declaration.0 as usize] {
                    Declaration::Signature { .. } => continue,
                    Declaration::Binding { pattern, value, .. } => {
                        live.extend(&self.resolver.pins[pattern]);
                        *value
                    }
                    Declaration::Shadow { value, .. } | Declaration::Open { value, .. } => *value,
                };
                live = self.expression(value, live, held);
            }
            if recursive_declaration(self.module, group[0]) {
                for declaration in group {
                    if let Some(definitions) = self.resolver.definitions.get(declaration) {
                        live.retain(|binding| !definitions.contains(binding));
                    }
                }
            }
        }
        live
    }
}

fn expression_operands(expression: &Expression) -> Vec<ExpressionId> {
    match expression {
        Expression::Apply {
            function, argument, ..
        } => vec![*function, *argument],
        Expression::Field { target, .. } => vec![*target],
        Expression::Rec { lambda, .. } => vec![*lambda],
        Expression::Tuple { elements, .. } => elements.clone(),
        Expression::Array { elements, .. } => {
            elements.iter().map(|element| element.value).collect()
        }
        Expression::Shape { members, .. } => members
            .iter()
            .flat_map(|member| match member {
                ShapeMember::Field { value, .. } | ShapeMember::Spread { value } => vec![*value],
                ShapeMember::Computed { name, value } => vec![*name, *value],
            })
            .collect(),
        _ => Vec::new(),
    }
}
