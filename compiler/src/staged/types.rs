//! Mutable inference cells never escape into published, interned type graphs.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::{Budget, Failure, Site};

pub(super) type TypeId = usize;
pub(super) type InferId = usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Kind {
    Value,
    Row,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Type {
    Int,
    Bool,
    Unit,
    Text,
    Universe,
    Code,
    Nominal(u64),
    Bound(u32, Kind),
    Function(TypeId, TypeId),
    Tuple(Vec<TypeId>),
    Record(TypeId),
    Row(BTreeMap<String, TypeId>, Option<TypeId>),
}

pub(super) const INT: TypeId = 0;
pub(super) const BOOL: TypeId = 1;
pub(super) const UNIT: TypeId = 2;
pub(super) const TEXT: TypeId = 3;
pub(super) const UNIVERSE: TypeId = 4;
pub(super) const CODE: TypeId = 5;

pub(super) struct Types {
    pub nodes: Vec<Type>,
    index: HashMap<Type, TypeId>,
    closed: Vec<bool>,
    pub storage_bytes: usize,
}

impl Default for Types {
    fn default() -> Self {
        let mut result = Self {
            nodes: Vec::new(),
            index: HashMap::new(),
            closed: Vec::new(),
            storage_bytes: 0,
        };
        for ty in [
            Type::Int,
            Type::Bool,
            Type::Unit,
            Type::Text,
            Type::Universe,
            Type::Code,
        ] {
            result.intern(ty);
        }
        result
    }
}

impl Types {
    pub fn intern(&mut self, ty: Type) -> TypeId {
        if let Some(id) = self.index.get(&ty) {
            return *id;
        }
        let closed = match &ty {
            Type::Bound(..) => false,
            Type::Function(a, b) => self.closed[*a] && self.closed[*b],
            Type::Record(row) => self.closed[*row],
            Type::Tuple(items) => items.iter().all(|t| self.closed[*t]),
            Type::Row(fields, tail) => {
                fields.values().all(|t| self.closed[*t]) && tail.is_none_or(|t| self.closed[t])
            }
            _ => true,
        };
        self.storage_bytes += 2
            * (std::mem::size_of::<Type>()
                + match &ty {
                    Type::Row(fields, _) => fields.keys().map(|name| name.len() + 32).sum(),
                    Type::Tuple(xs) => xs.len() * std::mem::size_of::<TypeId>(),
                    _ => 0,
                });
        let id = self.nodes.len();
        self.closed.push(closed);
        self.nodes.push(ty.clone());
        self.index.insert(ty, id);
        id
    }

    pub fn closed(&self, root: TypeId) -> bool {
        self.closed[root]
    }

    pub fn display(&self, root: TypeId) -> String {
        fn go(store: &Types, id: TypeId, fuel: &mut usize) -> String {
            if *fuel == 0 {
                return "…".into();
            }
            *fuel -= 1;
            match &store.nodes[id] {
                Type::Int => "Int64".into(),
                Type::Bool => "Bool".into(),
                Type::Unit => "Unit".into(),
                Type::Text => "Text".into(),
                Type::Universe => "Type".into(),
                Type::Code => "Code".into(),
                Type::Nominal(n) => format!("Nominal#{n}"),
                Type::Bound(n, Kind::Value) => format!("a{n}"),
                Type::Bound(n, Kind::Row) => format!("r{n}"),
                Type::Function(a, b) => {
                    format!("({} -> {})", go(store, *a, fuel), go(store, *b, fuel))
                }
                Type::Tuple(xs) => format!(
                    "({})",
                    xs.iter()
                        .map(|x| go(store, *x, fuel))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                Type::Record(r) => format!("{{{}}}", go(store, *r, fuel)),
                Type::Row(fs, tail) => {
                    let mut out = fs
                        .iter()
                        .map(|(n, t)| format!("{n}: {}", go(store, *t, fuel)))
                        .collect::<Vec<_>>();
                    if let Some(t) = tail {
                        out.push(format!("..{}", go(store, *t, fuel)));
                    }
                    out.join(", ")
                }
            }
        }
        go(self, root, &mut 128)
    }
}

#[derive(Clone, Debug)]
enum Cell {
    Var(Kind, Option<InferId>),
    Atom(TypeId),
    Function(InferId, InferId),
    Tuple(Vec<InferId>),
    Record(InferId),
    Row(BTreeMap<String, InferId>, Option<InferId>),
}

pub(super) struct Inference {
    cells: Vec<Cell>,
    budget: Budget,
    pub steps: usize,
}

impl Inference {
    pub fn new(budget: Budget) -> Self {
        Self {
            cells: Vec::new(),
            budget,
            steps: 0,
        }
    }
    fn add(&mut self, cell: Cell) -> InferId {
        let id = self.cells.len();
        self.cells.push(cell);
        id
    }
    pub fn fresh(&mut self, kind: Kind) -> InferId {
        self.add(Cell::Var(kind, None))
    }
    pub fn atom(&mut self, id: TypeId) -> InferId {
        self.add(Cell::Atom(id))
    }
    pub fn function(&mut self, a: InferId, b: InferId) -> InferId {
        self.add(Cell::Function(a, b))
    }
    pub fn tuple(&mut self, xs: Vec<InferId>) -> InferId {
        self.add(Cell::Tuple(xs))
    }
    pub fn record(&mut self, fields: BTreeMap<String, InferId>, open: bool) -> InferId {
        let tail = if open {
            Some(self.fresh(Kind::Row))
        } else {
            None
        };
        let row = self.add(Cell::Row(fields, tail));
        self.add(Cell::Record(row))
    }
    fn root(&mut self, mut id: InferId) -> InferId {
        let start = id;
        while let Cell::Var(_, Some(next)) = self.cells[id] {
            id = next;
        }
        if let Cell::Var(kind, Some(_)) = self.cells[start] {
            self.cells[start] = Cell::Var(kind, Some(id));
        }
        id
    }
    fn kind(&self, id: InferId) -> Kind {
        match self.cells[id] {
            Cell::Var(k, _) => k,
            Cell::Row(..) => Kind::Row,
            _ => Kind::Value,
        }
    }
    fn children(&self, id: InferId) -> Vec<InferId> {
        match &self.cells[id] {
            Cell::Var(_, Some(t)) | Cell::Record(t) => vec![*t],
            Cell::Function(a, b) => vec![*a, *b],
            Cell::Tuple(xs) => xs.clone(),
            Cell::Row(fs, tail) => fs.values().copied().chain(tail.iter().copied()).collect(),
            _ => Vec::new(),
        }
    }
    pub fn free(&self, id: InferId, site: Site) -> Result<BTreeSet<InferId>, Failure> {
        let mut pending = vec![id];
        let mut seen = HashSet::new();
        let mut out = BTreeSet::new();
        while let Some(x) = pending.pop() {
            self.budget.tick(site)?;
            if !seen.insert(x) {
                continue;
            }
            if matches!(self.cells[x], Cell::Var(_, None)) {
                out.insert(x);
            }
            pending.extend(self.children(x));
        }
        Ok(out)
    }
    fn bind(&mut self, var: InferId, to: InferId, site: Site) -> Result<(), Failure> {
        if self.kind(var) != self.kind(to) {
            return Err(Failure::source(site, "kind mismatch"));
        }
        if self.free(to, site)?.contains(&var) {
            return Err(Failure::source(site, "infinite type (occurs check)"));
        }
        let kind = self.kind(var);
        self.cells[var] = Cell::Var(kind, Some(to));
        Ok(())
    }
    fn row(
        &mut self,
        id: InferId,
        site: Site,
    ) -> Result<(BTreeMap<String, InferId>, Option<InferId>), Failure> {
        let mut current = self.root(id);
        let mut fields = BTreeMap::new();
        loop {
            self.budget.tick(site)?;
            match self.cells[current].clone() {
                Cell::Row(fs, tail) => {
                    for (name, ty) in fs {
                        if fields.insert(name, ty).is_some() {
                            return Err(Failure::source(site, "duplicate row label"));
                        }
                    }
                    if let Some(t) = tail {
                        current = self.root(t);
                    } else {
                        return Ok((fields, None));
                    }
                }
                Cell::Var(Kind::Row, None) => return Ok((fields, Some(current))),
                _ => return Err(Failure::invariant(site, "non-row in row tail")),
            }
        }
    }
    pub fn unify(&mut self, left: InferId, right: InferId, site: Site) -> Result<(), Failure> {
        let mut pending = vec![(left, right)];
        let mut seen = HashSet::new();
        while let Some((a, b)) = pending.pop() {
            self.budget.tick(site)?;
            self.steps += 1;
            let a = self.root(a);
            let b = self.root(b);
            if a == b || !seen.insert((a, b)) {
                continue;
            }
            match (self.cells[a].clone(), self.cells[b].clone()) {
                (Cell::Var(_, None), _) => self.bind(a, b, site)?,
                (_, Cell::Var(_, None)) => self.bind(b, a, site)?,
                (Cell::Atom(a), Cell::Atom(b)) if a == b => {}
                (Cell::Function(a, b), Cell::Function(c, d)) => pending.extend([(a, c), (b, d)]),
                (Cell::Record(a), Cell::Record(b)) => pending.push((a, b)),
                (Cell::Tuple(a), Cell::Tuple(b)) if a.len() == b.len() => {
                    pending.extend(a.into_iter().zip(b))
                }
                (Cell::Row(..), Cell::Row(..)) => {
                    let (mut af, at) = self.row(a, site)?;
                    let (mut bf, bt) = self.row(b, site)?;
                    for name in af
                        .keys()
                        .filter(|n| bf.contains_key(*n))
                        .cloned()
                        .collect::<Vec<_>>()
                    {
                        pending.push((af.remove(&name).unwrap(), bf.remove(&name).unwrap()));
                    }
                    if af.is_empty() && bf.is_empty() {
                        match (at, bt) {
                            (Some(x), Some(y)) => pending.push((x, y)),
                            (Some(x), None) | (None, Some(x)) => {
                                let empty = self.add(Cell::Row(BTreeMap::new(), None));
                                pending.push((x, empty));
                            }
                            _ => {}
                        }
                    } else if af.is_empty() {
                        let x = at.ok_or_else(|| {
                            Failure::source(site, "record is missing required fields")
                        })?;
                        let row = self.add(Cell::Row(bf, bt));
                        pending.push((x, row));
                    } else if bf.is_empty() {
                        let x = bt.ok_or_else(|| {
                            Failure::source(site, "record is missing required fields")
                        })?;
                        let row = self.add(Cell::Row(af, at));
                        pending.push((x, row));
                    } else {
                        let x = at.ok_or_else(|| Failure::source(site, "record fields differ"))?;
                        let y = bt.ok_or_else(|| Failure::source(site, "record fields differ"))?;
                        if x == y {
                            return Err(Failure::source(site, "incompatible recursive row"));
                        }
                        let tail = self.fresh(Kind::Row);
                        let ar = self.add(Cell::Row(bf, Some(tail)));
                        let br = self.add(Cell::Row(af, Some(tail)));
                        pending.extend([(x, ar), (y, br)]);
                    }
                }
                _ => return Err(Failure::source(site, "incompatible types")),
            }
        }
        Ok(())
    }
    pub fn instantiate(
        &mut self,
        root: InferId,
        quantified: &BTreeSet<InferId>,
        site: Site,
    ) -> Result<InferId, Failure> {
        fn go(
            this: &mut Inference,
            id: InferId,
            qs: &BTreeSet<InferId>,
            memo: &mut HashMap<InferId, InferId>,
            site: Site,
            depth: usize,
        ) -> Result<InferId, Failure> {
            this.budget.depth(site, depth)?;
            this.budget.tick(site)?;
            let id = this.root(id);
            if let Some(x) = memo.get(&id) {
                return Ok(*x);
            }
            let result = match this.cells[id].clone() {
                Cell::Var(kind, None) if qs.contains(&id) => this.fresh(kind),
                Cell::Var(..) | Cell::Atom(_) => id,
                Cell::Function(a, b) => {
                    let a = go(this, a, qs, memo, site, depth + 1)?;
                    let b = go(this, b, qs, memo, site, depth + 1)?;
                    this.function(a, b)
                }
                Cell::Record(r) => {
                    let r = go(this, r, qs, memo, site, depth + 1)?;
                    this.add(Cell::Record(r))
                }
                Cell::Tuple(xs) => {
                    let xs = xs
                        .into_iter()
                        .map(|x| go(this, x, qs, memo, site, depth + 1))
                        .collect::<Result<_, _>>()?;
                    this.tuple(xs)
                }
                Cell::Row(fs, tail) => {
                    let fs = fs
                        .into_iter()
                        .map(|(n, t)| Ok((n, go(this, t, qs, memo, site, depth + 1)?)))
                        .collect::<Result<_, Failure>>()?;
                    let tail = tail
                        .map(|t| go(this, t, qs, memo, site, depth + 1))
                        .transpose()?;
                    this.add(Cell::Row(fs, tail))
                }
            };
            memo.insert(id, result);
            Ok(result)
        }
        go(self, root, quantified, &mut HashMap::new(), site, 0)
    }
    pub fn import(&mut self, store: &Types, root: TypeId, site: Site) -> Result<InferId, Failure> {
        fn go(
            this: &mut Inference,
            store: &Types,
            id: TypeId,
            memo: &mut HashMap<TypeId, InferId>,
            site: Site,
            depth: usize,
        ) -> Result<InferId, Failure> {
            this.budget.depth(site, depth)?;
            this.budget.tick(site)?;
            if let Some(x) = memo.get(&id) {
                return Ok(*x);
            }
            let result = match &store.nodes[id] {
                Type::Bound(_, kind) => this.fresh(*kind),
                Type::Function(a, b) => {
                    let a = go(this, store, *a, memo, site, depth + 1)?;
                    let b = go(this, store, *b, memo, site, depth + 1)?;
                    this.function(a, b)
                }
                Type::Record(r) => {
                    let r = go(this, store, *r, memo, site, depth + 1)?;
                    this.add(Cell::Record(r))
                }
                Type::Tuple(xs) => {
                    let xs = xs
                        .iter()
                        .map(|x| go(this, store, *x, memo, site, depth + 1))
                        .collect::<Result<_, _>>()?;
                    this.tuple(xs)
                }
                Type::Row(fs, tail) => {
                    let fs = fs
                        .iter()
                        .map(|(n, t)| Ok((n.clone(), go(this, store, *t, memo, site, depth + 1)?)))
                        .collect::<Result<_, Failure>>()?;
                    let tail = tail
                        .map(|t| go(this, store, t, memo, site, depth + 1))
                        .transpose()?;
                    this.add(Cell::Row(fs, tail))
                }
                _ => this.atom(id),
            };
            memo.insert(id, result);
            Ok(result)
        }
        go(self, store, root, &mut HashMap::new(), site, 0)
    }
    pub fn freeze(
        &mut self,
        store: &mut Types,
        root: InferId,
        bindings: &mut HashMap<InferId, TypeId>,
        memo: &mut HashMap<InferId, TypeId>,
        site: Site,
    ) -> Result<TypeId, Failure> {
        fn go(
            this: &mut Inference,
            store: &mut Types,
            id: InferId,
            bs: &mut HashMap<InferId, TypeId>,
            memo: &mut HashMap<InferId, TypeId>,
            site: Site,
            depth: usize,
        ) -> Result<TypeId, Failure> {
            this.budget.depth(site, depth)?;
            this.budget.tick(site)?;
            let id = this.root(id);
            if let Some(t) = memo.get(&id) {
                return Ok(*t);
            }
            let ty = match this.cells[id].clone() {
                Cell::Var(k, None) => {
                    if let Some(t) = bs.get(&id) {
                        return Ok(*t);
                    }
                    let t = store.intern(Type::Bound(bs.len() as u32, k));
                    bs.insert(id, t);
                    return Ok(t);
                }
                Cell::Atom(t) => return Ok(t),
                Cell::Function(a, b) => Type::Function(
                    go(this, store, a, bs, memo, site, depth + 1)?,
                    go(this, store, b, bs, memo, site, depth + 1)?,
                ),
                Cell::Tuple(xs) => Type::Tuple(
                    xs.into_iter()
                        .map(|x| go(this, store, x, bs, memo, site, depth + 1))
                        .collect::<Result<_, _>>()?,
                ),
                Cell::Record(r) => Type::Record(go(this, store, r, bs, memo, site, depth + 1)?),
                Cell::Row(..) => {
                    let (fs, tail) = this.row(id, site)?;
                    Type::Row(
                        fs.into_iter()
                            .map(|(n, t)| Ok((n, go(this, store, t, bs, memo, site, depth + 1)?)))
                            .collect::<Result<_, Failure>>()?,
                        tail.map(|t| go(this, store, t, bs, memo, site, depth + 1))
                            .transpose()?,
                    )
                }
                Cell::Var(_, Some(_)) => unreachable!(),
            };
            let t = store.intern(ty);
            memo.insert(id, t);
            Ok(t)
        }
        go(self, store, root, bindings, memo, site, 0)
    }
}
