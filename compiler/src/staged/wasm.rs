//! Experimental uniform-word backend. Not the production Runtime HIR or ABI.
//! Cached fragments contain symbolic relocations; session-local arena IDs never
//! masquerade as final Wasm function/global indices.
use super::core::{Global, Local, Node, Primitive, Symbol, TermId, Value, ValueId};
use super::types::{self, Type};
use super::{Budget, Failure, PrototypeSession, Site, Work};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, ElementSection, Elements, ExportKind,
    ExportSection, Function, FunctionSection, GlobalSection, GlobalType, Instruction, MemArg,
    MemorySection, MemoryType, Module, RefType, StartSection, TableSection, TableType, TypeSection,
    ValType,
};

const HEAP: u32 = 0;
const ALLOC: u32 = 0;
const FIELD: u32 = 1;
const CLOSURE_TYPE: u32 = 0;

#[derive(Clone)]
enum Op {
    Plain(Instruction<'static>),
    FunctionSlot(TermId),
    Global(Symbol),
    Label(String),
}
#[derive(Clone)]
pub(super) struct Fragment {
    locals: Vec<ValType>,
    ops: Vec<Op>,
    captures: Vec<Local>,
}
impl Fragment {
    pub(super) fn storage_bytes(&self) -> usize {
        self.locals.len() * std::mem::size_of::<ValType>()
            + self.captures.len() * std::mem::size_of::<Local>()
            + self
                .ops
                .iter()
                .map(|op| {
                    std::mem::size_of::<Op>()
                        + match op {
                            Op::Label(n) => n.len(),
                            _ => 0,
                        }
                })
                .sum::<usize>()
    }
}
struct Builder<'a> {
    session: &'a PrototypeSession,
    captures: &'a HashMap<TermId, Vec<Local>>,
    budget: &'a Budget,
    site: Site,
    params: u32,
    locals: Vec<ValType>,
    slots: HashMap<Local, u32>,
    ops: Vec<Op>,
}
fn mem(offset: u64) -> MemArg {
    MemArg {
        offset,
        align: 2,
        memory_index: 0,
    }
}
fn ins(f: &mut Function, op: Instruction<'_>) {
    f.instruction(&op);
}

impl Builder<'_> {
    fn i(&mut self, op: Instruction<'static>) {
        self.ops.push(Op::Plain(op));
    }
    fn temp(&mut self, ty: ValType) -> u32 {
        let id = self.params + self.locals.len() as u32;
        self.locals.push(ty);
        id
    }
    fn alloc(&mut self, bytes: usize) -> Result<u32, Failure> {
        if bytes > 16 * 1024 * 1024 {
            return Err(Failure::limit(
                self.site,
                "prototype allocation exceeds linear-memory cap",
            ));
        }
        let p = self.temp(ValType::I32);
        self.i(Instruction::I32Const(bytes as i32));
        self.i(Instruction::Call(ALLOC));
        self.i(Instruction::LocalSet(p));
        Ok(p)
    }
    fn capture(&mut self, id: TermId) -> Result<(), Failure> {
        let free = self
            .captures
            .get(&id)
            .ok_or_else(|| {
                Failure::invariant(self.site, "function was not planned before emission")
            })?
            .clone();
        let p = self.alloc(8 + free.len() * 8)?;
        self.i(Instruction::LocalGet(p));
        self.ops.push(Op::FunctionSlot(id));
        self.i(Instruction::I32Store(mem(0)));
        for (i, slot) in free.iter().enumerate() {
            let local = *self.slots.get(slot).ok_or_else(|| {
                Failure::invariant(self.site, "closure capture slot is not in lexical scope")
            })?;
            self.i(Instruction::LocalGet(p));
            self.i(Instruction::LocalGet(local));
            self.i(Instruction::I64Store(mem((8 + i * 8) as u64)));
        }
        self.i(Instruction::LocalGet(p));
        self.i(Instruction::I64ExtendI32U);
        Ok(())
    }
    fn constant(&mut self, value: ValueId, depth: usize) -> Result<(), Failure> {
        self.constant_graph(value, depth, &mut HashMap::new())
    }
    fn constant_graph(
        &mut self,
        value: ValueId,
        depth: usize,
        memo: &mut HashMap<ValueId, u32>,
    ) -> Result<(), Failure> {
        self.budget.depth(self.site, depth)?;
        self.budget.tick(self.site)?;
        if let Some(slot) = memo.get(&value) {
            self.i(Instruction::LocalGet(*slot));
            return Ok(());
        }
        let aggregate = matches!(
            self.session.values.nodes[value],
            Value::Tuple(_) | Value::Record(_)
        );
        match self.session.values.nodes[value].clone() {
            Value::Int(n) => self.i(Instruction::I64Const(n)),
            Value::Bool(b) => self.i(Instruction::I64Const(i64::from(b))),
            Value::Unit => self.i(Instruction::I64Const(0)),
            Value::Tuple(xs) => {
                let p = self.alloc(8 + xs.len() * 8)?;
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I32Const(xs.len() as i32));
                self.i(Instruction::I32Store(mem(0)));
                for (i, x) in xs.into_iter().enumerate() {
                    self.i(Instruction::LocalGet(p));
                    self.constant_graph(x, depth + 1, memo)?;
                    self.i(Instruction::I64Store(mem((8 + i * 8) as u64)));
                }
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I64ExtendI32U);
            }
            Value::Record(fs) => {
                let p = self.alloc(8 + fs.len() * 16)?;
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I32Const(fs.len() as i32));
                self.i(Instruction::I32Store(mem(0)));
                for (i, (n, x)) in fs.into_iter().enumerate() {
                    self.i(Instruction::LocalGet(p));
                    self.ops.push(Op::Label(n));
                    self.i(Instruction::I32Store(mem((8 + i * 16) as u64)));
                    self.i(Instruction::LocalGet(p));
                    self.constant_graph(x, depth + 1, memo)?;
                    self.i(Instruction::I64Store(mem((16 + i * 16) as u64)));
                }
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I64ExtendI32U);
            }
            _ => {
                return Err(Failure::unsupported(
                    self.site,
                    "compile-time Type/Code/Text/closure value escaped into runtime code; splice Code explicitly",
                ));
            }
        }
        if aggregate {
            let slot = self.temp(ValType::I64);
            self.i(Instruction::LocalTee(slot));
            memo.insert(value, slot);
        }
        Ok(())
    }
    fn expr(&mut self, id: TermId, depth: usize) -> Result<(), Failure> {
        self.budget.depth(self.site, depth)?;
        self.budget.tick(self.site)?;
        match self.session.terms.nodes[id].node.clone() {
            Node::Constant(v) => self.constant(v, depth + 1)?,
            Node::Local(n) => {
                let slot = *self.slots.get(&n).ok_or_else(|| {
                    Failure::invariant(self.site, "unbound local in checked runtime core")
                })?;
                self.i(Instruction::LocalGet(slot));
            }
            Node::Global(s) => self.ops.push(Op::Global(s)),
            Node::Instance(id) => self.expr(id, depth + 1)?,
            Node::Function { .. } | Node::Primitive(_) => self.capture(id)?,
            Node::Call(f, a) => {
                let closure = self.temp(ValType::I64);
                let arg = self.temp(ValType::I64);
                self.expr(f, depth + 1)?;
                self.i(Instruction::LocalSet(closure));
                self.expr(a, depth + 1)?;
                self.i(Instruction::LocalSet(arg));
                self.i(Instruction::LocalGet(closure));
                self.i(Instruction::I32WrapI64);
                self.i(Instruction::LocalGet(arg));
                self.i(Instruction::LocalGet(closure));
                self.i(Instruction::I32WrapI64);
                self.i(Instruction::I32Load(mem(0)));
                self.i(Instruction::CallIndirect {
                    type_index: CLOSURE_TYPE,
                    table_index: 0,
                });
            }
            Node::Tuple(xs) => {
                let p = self.alloc(8 + xs.len() * 8)?;
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I32Const(xs.len() as i32));
                self.i(Instruction::I32Store(mem(0)));
                for (i, x) in xs.into_iter().enumerate() {
                    self.i(Instruction::LocalGet(p));
                    self.expr(x, depth + 1)?;
                    self.i(Instruction::I64Store(mem((8 + i * 8) as u64)));
                }
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I64ExtendI32U);
            }
            Node::Record(fs) => {
                let p = self.alloc(8 + fs.len() * 16)?;
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I32Const(fs.len() as i32));
                self.i(Instruction::I32Store(mem(0)));
                for (i, (name, x)) in fs.into_iter().enumerate() {
                    self.i(Instruction::LocalGet(p));
                    self.ops.push(Op::Label(name));
                    self.i(Instruction::I32Store(mem((8 + i * 16) as u64)));
                    self.i(Instruction::LocalGet(p));
                    self.expr(x, depth + 1)?;
                    self.i(Instruction::I64Store(mem((16 + i * 16) as u64)));
                }
                self.i(Instruction::LocalGet(p));
                self.i(Instruction::I64ExtendI32U);
            }
            Node::Project(x, index) => {
                self.expr(x, depth + 1)?;
                self.i(Instruction::I32WrapI64);
                self.i(Instruction::I64Load(mem((8 + index * 8) as u64)));
            }
            Node::Field(x, n) => {
                self.expr(x, depth + 1)?;
                self.ops.push(Op::Label(n));
                self.i(Instruction::Call(FIELD));
            }
            Node::Let { local, value, body } => {
                let slot = self.temp(ValType::I64);
                self.expr(value, depth + 1)?;
                self.i(Instruction::LocalSet(slot));
                let saved = self.slots.insert(local, slot);
                self.expr(body, depth + 1)?;
                if let Some(saved) = saved {
                    self.slots.insert(local, saved);
                } else {
                    self.slots.remove(&local);
                }
            }
            Node::If(c, a, b) => {
                self.expr(c, depth + 1)?;
                self.i(Instruction::I64Eqz);
                self.i(Instruction::I32Eqz);
                self.i(Instruction::If(BlockType::Result(ValType::I64)));
                self.expr(a, depth + 1)?;
                self.i(Instruction::Else);
                self.expr(b, depth + 1)?;
                self.i(Instruction::End);
            }
            Node::Quote(_) => {
                return Err(Failure::unsupported(
                    self.site,
                    "unspliced quotation reached runtime emission",
                ));
            }
        }
        Ok(())
    }
    fn primitive_body(&mut self, p: Primitive) -> Result<(), Failure> {
        if !matches!(
            p,
            Primitive::Add | Primitive::Sub | Primitive::Mul | Primitive::Equal | Primitive::Less
        ) {
            return Err(Failure::unsupported(
                self.site,
                "static primitive reached the runtime boundary",
            ));
        }
        self.i(Instruction::LocalGet(1));
        self.i(Instruction::I32WrapI64);
        self.i(Instruction::I64Load(mem(8)));
        self.i(Instruction::LocalGet(1));
        self.i(Instruction::I32WrapI64);
        self.i(Instruction::I64Load(mem(16)));
        match p {
            Primitive::Add => self.i(Instruction::I64Add),
            Primitive::Sub => self.i(Instruction::I64Sub),
            Primitive::Mul => self.i(Instruction::I64Mul),
            Primitive::Equal => {
                self.i(Instruction::I64Eq);
                self.i(Instruction::I64ExtendI32U);
            }
            Primitive::Less => {
                self.i(Instruction::I64LtS);
                self.i(Instruction::I64ExtendI32U);
            }
            _ => unreachable!(),
        }
        Ok(())
    }
}
fn finish(
    fragment: &Fragment,
    functions: &HashMap<TermId, u32>,
    globals: &BTreeMap<Symbol, u32>,
    labels: &mut BTreeMap<String, u32>,
) -> Function {
    let mut f = Function::new(fragment.locals.iter().map(|t| (1, *t)));
    for op in &fragment.ops {
        match op {
            Op::Plain(i) => {
                f.instruction(i);
            }
            Op::FunctionSlot(id) => ins(&mut f, Instruction::I32Const(functions[id] as i32)),
            Op::Global(s) => ins(&mut f, Instruction::GlobalGet(globals[s])),
            Op::Label(n) => {
                let next = labels.len() as u32;
                let id = *labels.entry(n.clone()).or_insert(next);
                ins(&mut f, Instruction::I32Const(id as i32));
            }
        }
    }
    ins(&mut f, Instruction::End);
    f
}
fn allocator() -> Function {
    let mut f = Function::new([(2, ValType::I32)]);
    for i in [
        Instruction::GlobalGet(HEAP),
        Instruction::LocalTee(1),
        Instruction::LocalGet(0),
        Instruction::I32Add,
        Instruction::LocalTee(2),
        Instruction::LocalGet(1),
        Instruction::I32LtU,
        Instruction::If(BlockType::Empty),
        Instruction::Unreachable,
        Instruction::End,
        Instruction::LocalGet(2),
        Instruction::I32Const(16 * 1024 * 1024),
        Instruction::I32GtU,
        Instruction::If(BlockType::Empty),
        Instruction::Unreachable,
        Instruction::End,
        Instruction::LocalGet(2),
        Instruction::MemorySize(0),
        Instruction::I32Const(16),
        Instruction::I32Shl,
        Instruction::I32GtU,
        Instruction::If(BlockType::Empty),
        Instruction::LocalGet(2),
        Instruction::I32Const(65535),
        Instruction::I32Add,
        Instruction::I32Const(16),
        Instruction::I32ShrU,
        Instruction::MemorySize(0),
        Instruction::I32Sub,
        Instruction::MemoryGrow(0),
        Instruction::I32Const(-1),
        Instruction::I32Eq,
        Instruction::If(BlockType::Empty),
        Instruction::Unreachable,
        Instruction::End,
        Instruction::End,
        Instruction::LocalGet(2),
        Instruction::GlobalSet(HEAP),
        Instruction::LocalGet(1),
        Instruction::End,
    ] {
        ins(&mut f, i);
    }
    f
}
fn field_getter() -> Function {
    let mut f = Function::new([(3, ValType::I32)]);
    for i in [
        Instruction::LocalGet(0),
        Instruction::I32WrapI64,
        Instruction::I32Load(mem(0)),
        Instruction::LocalSet(4),
        Instruction::Block(BlockType::Empty),
        Instruction::Loop(BlockType::Empty),
        Instruction::LocalGet(3),
        Instruction::LocalGet(4),
        Instruction::I32GeU,
        Instruction::BrIf(1),
        Instruction::LocalGet(0),
        Instruction::I32WrapI64,
        Instruction::I32Const(8),
        Instruction::I32Add,
        Instruction::LocalGet(3),
        Instruction::I32Const(16),
        Instruction::I32Mul,
        Instruction::I32Add,
        Instruction::LocalTee(2),
        Instruction::I32Load(mem(0)),
        Instruction::LocalGet(1),
        Instruction::I32Eq,
        Instruction::If(BlockType::Empty),
        Instruction::LocalGet(2),
        Instruction::I64Load(mem(8)),
        Instruction::Return,
        Instruction::End,
        Instruction::LocalGet(3),
        Instruction::I32Const(1),
        Instruction::I32Add,
        Instruction::LocalSet(3),
        Instruction::Br(0),
        Instruction::End,
        Instruction::End,
        Instruction::Unreachable,
        Instruction::End,
    ] {
        ins(&mut f, i);
    }
    f
}

pub(super) fn emit(
    session: &mut PrototypeSession,
    globals: &BTreeMap<Symbol, Global>,
    exports: &BTreeMap<String, Global>,
    budget: &Budget,
    work: &mut Work,
    site: Site,
) -> Result<Vec<u8>, Failure> {
    let mut pending = exports.values().map(|g| g.term).collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut live = BTreeSet::new();
    let mut function_ids = Vec::new();
    while let Some(id) = pending.pop() {
        budget.tick(site)?;
        if !seen.insert(id) {
            continue;
        }
        match &session.terms.nodes[id].node {
            Node::Global(s) => {
                live.insert(*s);
                pending.push(
                    globals
                        .get(s)
                        .ok_or_else(|| Failure::invariant(site, "resolved runtime global missing"))?
                        .term,
                );
            }
            Node::Function { .. } | Node::Primitive(_) => function_ids.push(id),
            Node::Quote(_) => {
                return Err(Failure::unsupported(
                    site,
                    "quotation requires explicit splicing",
                ));
            }
            _ => {}
        }
        pending.extend(session.terms.children(id));
    }
    function_ids.sort_unstable();
    let function_slots = function_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i as u32))
        .collect::<HashMap<_, _>>();
    let global_indices = live
        .iter()
        .enumerate()
        .map(|(i, s)| (*s, i as u32 + 1))
        .collect::<BTreeMap<_, _>>();
    let mut captures = HashMap::new();
    for id in &function_ids {
        if let Some(fragment) = session.fragments.get(id) {
            captures.insert(*id, fragment.captures.clone());
            continue;
        }
        let free = if let Node::Function { parameter, body } = session.terms.nodes[*id].node {
            let mut free = session.terms.free_locals(body, budget, site)?;
            free.remove(&parameter);
            free.into_iter().collect()
        } else {
            vec![]
        };
        captures.insert(*id, free);
    }
    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I64], [ValType::I64]);
    types.ty().function([ValType::I32], [ValType::I32]);
    types
        .ty()
        .function([ValType::I64, ValType::I32], [ValType::I64]);
    types.ty().function([], []);
    let mut functions = FunctionSection::new();
    functions.function(1);
    functions.function(2);
    let mut code = CodeSection::new();
    code.function(&allocator());
    code.function(&field_getter());
    for id in &function_ids {
        functions.function(CLOSURE_TYPE);
        if !session.fragments.contains_key(id) {
            let free = captures[id].clone();
            let mut builder = Builder {
                session,
                captures: &captures,
                budget,
                site,
                params: 2,
                locals: vec![],
                slots: HashMap::new(),
                ops: vec![],
            };
            for (i, slot) in free.iter().enumerate() {
                let local = builder.temp(ValType::I64);
                builder.i(Instruction::LocalGet(0));
                builder.i(Instruction::I64Load(mem((8 + i * 8) as u64)));
                builder.i(Instruction::LocalSet(local));
                builder.slots.insert(*slot, local);
            }
            match session.terms.nodes[*id].node {
                Node::Function { parameter, body } => {
                    builder.slots.insert(parameter, 1);
                    builder.expr(body, 0)?;
                }
                Node::Primitive(p) => builder.primitive_body(p)?,
                _ => return Err(Failure::invariant(site, "invalid function plan")),
            }
            let fragment = Fragment {
                locals: builder.locals,
                ops: builder.ops,
                captures: free,
            };
            session.fragments.insert(*id, fragment);
            work.emitted_functions += 1;
        } else {
            work.reused_functions += 1;
        }
        code.function(&finish(
            &session.fragments[id],
            &function_slots,
            &global_indices,
            &mut session.labels,
        ));
    }
    let start = 2 + function_ids.len() as u32;
    functions.function(3);
    let mut init = Builder {
        session,
        captures: &captures,
        budget,
        site,
        params: 0,
        locals: vec![],
        slots: HashMap::new(),
        ops: vec![],
    };
    // Symbol numbers are stable session IDs, not declaration order. Topologically
    // order the actual runtime dependencies, including after insertion/deletion.
    let mut order = Vec::new();
    let mut done = HashSet::new();
    let mut visiting = HashSet::new();
    let mut stack = live.iter().map(|s| (*s, false)).collect::<Vec<_>>();
    while let Some((s, exit)) = stack.pop() {
        budget.tick(site)?;
        if done.contains(&s) {
            continue;
        }
        if exit {
            visiting.remove(&s);
            done.insert(s);
            order.push(s);
            continue;
        }
        if !visiting.insert(s) {
            return Err(Failure::invariant(
                site,
                "recursive top-level dependency escaped prototype checking",
            ));
        }
        stack.push((s, true));
        for child in session.terms.globals(globals[&s].term, budget, site)? {
            if !done.contains(&child) {
                stack.push((child, false));
            }
        }
    }
    for s in order {
        init.expr(globals[&s].term, 0)?;
        init.i(Instruction::GlobalSet(global_indices[&s]));
    }
    let init = Fragment {
        locals: init.locals,
        ops: init.ops,
        captures: vec![],
    };
    code.function(&finish(
        &init,
        &function_slots,
        &global_indices,
        &mut session.labels,
    ));
    let mut export_section = ExportSection::new();
    for (index, (name, global)) in exports.iter().enumerate() {
        let Type::Function(input, output) = session.types.nodes[global.ty] else {
            return Err(Failure::unsupported(
                site,
                format!("export `{name}` must be a function"),
            ));
        };
        let scalar = |ty| match ty {
            types::INT => Some(Some(ValType::I64)),
            types::BOOL => Some(Some(ValType::I32)),
            types::UNIT => Some(None),
            _ => None,
        };
        let Some(input_wasm) = scalar(input) else {
            return Err(Failure::unsupported(
                site,
                format!("export `{name}` requires a closed Int64, Bool or Unit input"),
            ));
        };
        let Some(output_wasm) = scalar(output) else {
            return Err(Failure::unsupported(
                site,
                format!("export `{name}` requires a closed scalar result"),
            ));
        };
        let type_index = 4 + index as u32;
        types.ty().function(input_wasm, output_wasm);
        functions.function(type_index);
        let mut wrapper = Builder {
            session,
            captures: &captures,
            budget,
            site,
            params: u32::from(input_wasm.is_some()),
            locals: vec![],
            slots: HashMap::new(),
            ops: vec![],
        };
        let saved = wrapper.temp(ValType::I32);
        let closure = wrapper.temp(ValType::I64);
        let result = wrapper.temp(ValType::I64);
        if input == types::BOOL {
            wrapper.i(Instruction::LocalGet(0));
            wrapper.i(Instruction::I32Const(1));
            wrapper.i(Instruction::I32GtU);
            wrapper.i(Instruction::If(BlockType::Empty));
            wrapper.i(Instruction::Unreachable);
            wrapper.i(Instruction::End);
        }
        wrapper.i(Instruction::GlobalGet(HEAP));
        wrapper.i(Instruction::LocalSet(saved));
        wrapper.expr(global.term, 0)?;
        wrapper.i(Instruction::LocalSet(closure));
        wrapper.i(Instruction::LocalGet(closure));
        wrapper.i(Instruction::I32WrapI64);
        match input {
            types::UNIT => wrapper.i(Instruction::I64Const(0)),
            types::BOOL => {
                wrapper.i(Instruction::LocalGet(0));
                wrapper.i(Instruction::I64ExtendI32U);
            }
            _ => wrapper.i(Instruction::LocalGet(0)),
        }
        wrapper.i(Instruction::LocalGet(closure));
        wrapper.i(Instruction::I32WrapI64);
        wrapper.i(Instruction::I32Load(mem(0)));
        wrapper.i(Instruction::CallIndirect {
            type_index: CLOSURE_TYPE,
            table_index: 0,
        });
        wrapper.i(Instruction::LocalSet(result));
        wrapper.i(Instruction::LocalGet(saved));
        wrapper.i(Instruction::GlobalSet(HEAP));
        if output != types::UNIT {
            wrapper.i(Instruction::LocalGet(result));
            if output == types::BOOL {
                wrapper.i(Instruction::I32WrapI64);
            }
        }
        let wrapper = Fragment {
            locals: wrapper.locals,
            ops: wrapper.ops,
            captures: vec![],
        };
        code.function(&finish(
            &wrapper,
            &function_slots,
            &global_indices,
            &mut session.labels,
        ));
        export_section.export(name, ExportKind::Func, start + 1 + index as u32);
    }
    let mut globals_section = GlobalSection::new();
    globals_section.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(8),
    );
    for _ in &live {
        globals_section.global(
            GlobalType {
                val_type: ValType::I64,
                mutable: true,
                shared: false,
            },
            &ConstExpr::i64_const(0),
        );
    }
    let mut tables = TableSection::new();
    tables.table(TableType {
        element_type: RefType::FUNCREF,
        table64: false,
        minimum: function_ids.len() as u64,
        maximum: Some(function_ids.len() as u64),
        shared: false,
    });
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: Some(256),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut elements = ElementSection::new();
    let indices = (2..start).collect::<Vec<_>>();
    elements.active(
        Some(0),
        &ConstExpr::i32_const(0),
        Elements::Functions(Cow::Borrowed(&indices)),
    );
    let mut module = Module::new();
    module.section(&types);
    module.section(&functions);
    module.section(&tables);
    module.section(&memories);
    module.section(&globals_section);
    module.section(&export_section);
    module.section(&StartSection {
        function_index: start,
    });
    module.section(&elements);
    module.section(&code);
    module.section(&CustomSection {
        name: Cow::Borrowed("blot.staged.experimental"),
        data: Cow::Borrowed(b"v1; pure; scalar ABI; not a Blot production artifact"),
    });
    let bytes = module.finish();
    wasmparser::Validator::new()
        .validate_all(&bytes)
        .map_err(|error| {
            Failure::invariant(site, format!("experimental Wasm validation: {error}"))
        })?;
    Ok(bytes)
}
