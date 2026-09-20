//! Persistent effect provenance. Appending retains the previous prefix; hashing,
//! equality and revision searches visit graph nodes, not expanded creation paths.
//! Hash summaries only select buckets: exact equality remains authoritative.
use super::ClosureApplication;
use std::cell::OnceCell;
use std::collections::{HashSet, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

#[cfg(test)]
thread_local! {
    static HASH_NODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone, Default)]
pub struct EffectScope {
    tail: Option<Rc<Node>>,
}

struct Node {
    prefix: Option<Rc<Node>>,
    frame: ClosureApplication,
    length: usize,
    digest: OnceCell<u64>,
}

type Frames<'a> = std::iter::Rev<std::vec::IntoIter<&'a ClosureApplication>>;

impl From<Vec<ClosureApplication>> for EffectScope {
    fn from(frames: Vec<ClosureApplication>) -> Self {
        frames.into_iter().collect()
    }
}

impl FromIterator<ClosureApplication> for EffectScope {
    fn from_iter<T: IntoIterator<Item = ClosureApplication>>(iter: T) -> Self {
        let mut scope = Self::default();
        for frame in iter {
            scope.push(frame);
        }
        scope
    }
}

impl<'a> IntoIterator for &'a EffectScope {
    type Item = &'a ClosureApplication;
    type IntoIter = Frames<'a>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl EffectScope {
    pub fn len(&self) -> usize {
        self.tail.as_ref().map_or(0, |node| node.length)
    }
    pub fn is_empty(&self) -> bool {
        self.tail.is_none()
    }

    pub fn push(&mut self, frame: ClosureApplication) {
        let length = self
            .len()
            .checked_add(1)
            .expect("effect provenance length overflow");
        self.tail = Some(Rc::new(Node {
            prefix: self.tail.take(),
            frame,
            length,
            digest: OnceCell::new(),
        }));
    }

    pub fn last(&self) -> Option<&ClosureApplication> {
        self.tail.as_ref().map(|node| &node.frame)
    }

    pub fn iter(&self) -> Frames<'_> {
        // Flatten only for consumers which require source order (capsule/wire
        // encoding). Hot identity operations traverse the persistent nodes.
        let mut frames = Vec::with_capacity(self.len());
        let mut node = self.tail.as_deref();
        while let Some(current) = node {
            frames.push(&current.frame);
            node = current.prefix.as_deref();
        }
        frames.into_iter().rev()
    }

    fn structural_hash(&self) -> u64 {
        let Some(root) = self.tail.as_deref() else {
            return 0;
        };
        if let Some(digest) = root.digest.get() {
            return *digest;
        }
        // Postorder handles both prefix and creation-scope edges. Nodes are
        // immutable and owning; construction cannot create a cycle. A missing
        // child is never initialized through recursive calls to Hash.
        let mut pending = vec![(root, false)];
        while let Some((node, finish)) = pending.pop() {
            if node.digest.get().is_some() {
                continue;
            }
            if !finish {
                pending.push((node, true));
                for child in [
                    node.prefix.as_deref(),
                    node.frame.creation_scope.tail.as_deref(),
                ]
                .into_iter()
                .flatten()
                {
                    if child.digest.get().is_none() {
                        pending.push((child, false));
                    }
                }
                continue;
            }
            #[cfg(test)]
            HASH_NODES.with(|count| count.set(count.get() + 1));
            let digest = |node: Option<&Node>| {
                node.map_or(0, |node| {
                    *node.digest.get().expect("completed provenance child")
                })
            };
            let mut state = DefaultHasher::new();
            node.length.hash(&mut state);
            digest(node.prefix.as_deref()).hash(&mut state);
            node.frame.application.hash(&mut state);
            digest(node.frame.creation_scope.tail.as_deref()).hash(&mut state);
            node.digest
                .set(state.finish())
                .expect("uninitialized provenance summary");
        }
        *root.digest.get().expect("completed provenance root")
    }

    pub(super) fn references_module(&self, module: &str) -> bool {
        let Some(root) = self.tail.as_deref() else {
            return false;
        };
        let mut pending = vec![root];
        let mut visited = HashSet::new();
        while let Some(node) = pending.pop() {
            if !visited.insert(node as *const Node) {
                continue;
            }
            if node.frame.application.references_module(module) {
                return true;
            }
            pending.extend(
                [
                    node.prefix.as_deref(),
                    node.frame.creation_scope.tail.as_deref(),
                ]
                .into_iter()
                .flatten(),
            );
        }
        false
    }
}

impl Hash for EffectScope {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.len().hash(state);
        self.structural_hash().hash(state);
    }
}

impl PartialEq for EffectScope {
    fn eq(&self, other: &Self) -> bool {
        if self.len() != other.len() {
            return false;
        }
        let (Some(left), Some(right)) = (&self.tail, &other.tail) else {
            return true;
        };
        if Rc::ptr_eq(left, right) {
            return true;
        }
        let mut pending = vec![(left.as_ref(), right.as_ref())];
        let mut visited = HashSet::new();
        while let Some((left, right)) = pending.pop() {
            if std::ptr::eq(left, right)
                || !visited.insert((left as *const Node, right as *const Node))
            {
                continue;
            }
            if left.length != right.length || left.frame.application != right.frame.application {
                return false;
            }
            for pair in [
                (left.prefix.as_deref(), right.prefix.as_deref()),
                (
                    left.frame.creation_scope.tail.as_deref(),
                    right.frame.creation_scope.tail.as_deref(),
                ),
            ] {
                match pair {
                    (Some(left), Some(right)) => pending.push((left, right)),
                    (None, None) => {}
                    _ => return false,
                }
            }
        }
        true
    }
}
impl Eq for EffectScope {}

impl Drop for EffectScope {
    fn drop(&mut self) {
        // Prefix sharing must not introduce recursive teardown of a uniquely
        // owned call history. Also release uniquely owned creation scopes here,
        // rather than recursing through their Rc destructors.
        let mut current = self.tail.take();
        let mut pending = Vec::new();
        while let Some(node) = current {
            current = None;
            if let Ok(node) = Rc::try_unwrap(node) {
                current = node.prefix;
                if let Ok(mut creation) = Rc::try_unwrap(node.frame.creation_scope) {
                    if current.is_none() {
                        current = creation.tail.take();
                    } else if let Some(tail) = creation.tail.take() {
                        pending.push(tail);
                    }
                }
            }
            if current.is_none() {
                current = pending.pop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::ExpressionId;
    use crate::eval::{ApplicationSite, ModuleRevision};

    fn frame(
        revision: &ModuleRevision,
        expression: u32,
        creation_scope: Rc<EffectScope>,
    ) -> ClosureApplication {
        ClosureApplication {
            application: ApplicationSite::expression(revision.clone(), ExpressionId(expression)),
            creation_scope,
        }
    }
    fn diamond(revision: &ModuleRevision, depth: usize) -> Rc<EffectScope> {
        let mut scope = Rc::new(EffectScope::default());
        for index in 0..depth {
            let application = frame(revision, index as u32, scope);
            scope = Rc::new(vec![application.clone(), application].into());
        }
        scope
    }

    #[test]
    fn provenance_hashes_and_equality_preserve_shared_diamonds() {
        let revision = ModuleRevision::new("effect-graph.blot");
        let left = diamond(&revision, 24);
        let right = diamond(&revision, 24);
        assert!(left == right);
        HASH_NODES.with(|count| count.set(0));
        let hash = left.structural_hash();
        HASH_NODES.with(|count| assert_eq!(count.get(), 48));
        assert_eq!(hash, left.structural_hash());
        HASH_NODES.with(|count| assert_eq!(count.get(), 48));
        assert_eq!(hash, right.structural_hash());
        assert!(!left.references_module("absent.blot"));
        assert!(left.references_module("effect-graph.blot"));
    }

    #[test]
    fn provenance_sharing_does_not_define_equality_or_wire_order() {
        let revision = ModuleRevision::new("layout.blot");
        let shared = diamond(&revision, 6);
        let make = |id, scope| frame(&revision, id, scope);
        let left: EffectScope = vec![make(10, shared.clone()), make(11, shared)].into();
        let right: EffectScope = vec![
            make(10, diamond(&revision, 6)),
            make(11, diamond(&revision, 6)),
        ]
        .into();
        assert!(left == right);
        assert_eq!(left.structural_hash(), right.structural_hash());
        let source_order = left.iter().cloned().collect::<Vec<_>>();
        assert!(EffectScope::from(source_order.clone()) == left);
        assert!(EffectScope::from(source_order.into_iter().rev().collect::<Vec<_>>()) != left);
    }

    #[test]
    fn provenance_append_retains_prefix_and_hashes_only_one_new_node() {
        let revision = ModuleRevision::new("append.blot");
        let original = diamond(&revision, 8);
        let before = original.structural_hash();
        let mut changed = original.clone();
        Rc::make_mut(&mut changed).push(frame(&revision, 99, Rc::new(EffectScope::default())));
        assert!(Rc::ptr_eq(
            changed.tail.as_ref().unwrap().prefix.as_ref().unwrap(),
            original.tail.as_ref().unwrap()
        ));
        HASH_NODES.with(|count| count.set(0));
        assert_ne!(changed.structural_hash(), before);
        HASH_NODES.with(|count| assert_eq!(count.get(), 1));
        assert_eq!(original.structural_hash(), before);
        assert!(changed != original);
    }

    #[test]
    fn provenance_hash_collisions_do_not_authorize_equality() {
        let first = diamond(&ModuleRevision::new("same-path.blot"), 1);
        let second = diamond(&ModuleRevision::new("same-path.blot"), 1);
        first.tail.as_ref().unwrap().digest.set(7).unwrap();
        second.tail.as_ref().unwrap().digest.set(7).unwrap();
        assert_eq!(first.structural_hash(), second.structural_hash());
        assert!(first != second);
    }

    #[test]
    fn provenance_traversal_and_teardown_use_bounded_stack() {
        std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| {
                let revision = ModuleRevision::new("deep.blot");
                let mut left = EffectScope::default();
                let mut right = EffectScope::default();
                for index in 0..4096 {
                    left.push(frame(&revision, index, Rc::new(EffectScope::default())));
                    right.push(frame(&revision, index, Rc::new(EffectScope::default())));
                }
                assert!(left == right);
                assert_eq!(left.structural_hash(), right.structural_hash());
                assert!(!left.references_module("absent.blot"));
                drop(left);
                drop(right);
                let mut scope = Rc::new(EffectScope::default());
                for index in 0..4096 {
                    scope = Rc::new(vec![frame(&revision, index, scope)].into());
                }
                scope.structural_hash();
                drop(scope);
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
