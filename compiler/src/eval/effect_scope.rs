use super::ClosureApplication;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

/// Persistent call provenance. Appending shares the caller's history and hashing
/// does not revisit nested closure-creation histories on every application.
#[derive(Clone, Default)]
pub struct EffectScope {
    tail: Option<Rc<Frame>>,
    len: usize,
    fingerprint: u64,
}

struct Frame {
    parent: EffectScope,
    application: ClosureApplication,
}

impl EffectScope {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn last(&self) -> Option<&ClosureApplication> {
        self.tail.as_ref().map(|frame| &frame.application)
    }

    pub(crate) fn push(&mut self, application: ClosureApplication) {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut hasher);
        application.hash(&mut hasher);
        let fingerprint = hasher.finish();
        let len = self.len + 1;
        let parent = std::mem::take(self);
        *self = Self {
            tail: Some(Rc::new(Frame {
                parent,
                application,
            })),
            len,
            fingerprint,
        };
    }

    pub(crate) fn iter(
        &self,
    ) -> impl DoubleEndedIterator<Item = &ClosureApplication> + ExactSizeIterator {
        let mut frames = Vec::with_capacity(self.len);
        let mut current = self.tail.as_deref();
        while let Some(frame) = current {
            frames.push(&frame.application);
            current = frame.parent.tail.as_deref();
        }
        frames.into_iter().rev()
    }
}

impl PartialEq for EffectScope {
    fn eq(&self, other: &Self) -> bool {
        if self.len != other.len || self.fingerprint != other.fingerprint {
            return false;
        }
        let mut left = self.tail.as_ref();
        let mut right = other.tail.as_ref();
        while let (Some(a), Some(b)) = (left, right) {
            if Rc::ptr_eq(a, b) {
                return true;
            }
            if a.application != b.application {
                return false;
            }
            left = a.parent.tail.as_ref();
            right = b.parent.tail.as_ref();
        }
        true
    }
}

impl Eq for EffectScope {}

impl Hash for EffectScope {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.len.hash(state);
        self.fingerprint.hash(state);
    }
}

impl From<Vec<ClosureApplication>> for EffectScope {
    fn from(frames: Vec<ClosureApplication>) -> Self {
        let mut scope = Self::default();
        for frame in frames {
            scope.push(frame);
        }
        scope
    }
}

impl Drop for EffectScope {
    fn drop(&mut self) {
        let mut tail = self.tail.take();
        while let Some(frame) = tail {
            let Ok(mut frame) = Rc::try_unwrap(frame) else {
                break;
            };
            tail = frame.parent.tail.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::ExpressionId;
    use crate::eval::{ApplicationSite, ModuleRevision};

    #[test]
    fn provenance_shares_prefixes_and_checks_structure_after_hashes() {
        let revision = ModuleRevision::new("provenance.blot");
        let application = |id| ClosureApplication {
            application: ApplicationSite::expression(revision.clone(), ExpressionId(id)),
            creation_scope: Rc::new(EffectScope::default()),
        };
        let mut prefix = EffectScope::default();
        prefix.push(application(1));
        let mut left = prefix.clone();
        let mut right = prefix.clone();
        left.push(application(2));
        right.push(application(2));
        assert!(left == right);
        assert_eq!(prefix.len(), 1);
        assert_eq!(left.iter().count(), 2);
        let mut different = prefix.clone();
        different.push(application(3));
        different.fingerprint = left.fingerprint;
        assert!(
            left != different,
            "hash equality does not grant effect identity"
        );
        drop(left);
        assert_eq!(right.len(), 2);
    }

    #[test]
    fn a_deep_call_history_drops_on_a_small_stack() {
        std::thread::Builder::new()
            .stack_size(64 * 1024)
            .spawn(|| {
                let revision = ModuleRevision::new("deep.blot");
                let creation_scope = Rc::new(EffectScope::default());
                let mut scope = EffectScope::default();
                for id in 0..20_000 {
                    scope.push(ClosureApplication {
                        application: ApplicationSite::expression(
                            revision.clone(),
                            ExpressionId(id),
                        ),
                        creation_scope: creation_scope.clone(),
                    });
                }
                assert_eq!(scope.len(), 20_000);
                drop(scope);
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
