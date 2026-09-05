from pathlib import Path
import subprocess

# Applied only on the draft branch by operator-development.yml, then removed.
patch = r'''--- a/compiler/src/typecheck.rs
+++ b/compiler/src/typecheck.rs
@@ -5001,7 +5001,10 @@
                     } else {
                         Typing::Scheme {
                             level: self.level.get(),
-                            body: substitute_inference_variables(body, &scheme_replacements),
+                            body: substitute_inference_variables(
+                                self.qualify_type(body),
+                                &scheme_replacements,
+                            ),
                         }
                     };
                     Rc::make_mut(&mut types.names).insert(name.clone(), typing);
@@ -7051,6 +7054,7 @@
             .borrow()
             .get(module.as_str(), body)
             .cloned()
+            .map(|type_| self.qualify_type(type_))
             .or_else(|| {
                 self.context
                     .closure_signature(module.as_str(), *body)
@@ -7876,7 +7880,6 @@
         match typing {
             Typing::Mono(type_) => self.activate_qualified_type(type_),
             Typing::Scheme { level, body } => {
-                let body = self.qualify_type(body);
                 let body = self.freshen(body, level, &mut HashMap::new());
                 self.activate_qualified_type(body)
             }
@@ -7902,10 +7905,7 @@
             .any(|candidate| types.same(*candidate, bound_id))
     }
 
-    fn project_scheme_constraints(&self, type_: &Type, level: u32) -> HashMap<VariableId, Type> {
-        if let Some(replacements) = self.copy_qualified_scheme_constraints(type_, level) {
-            return replacements;
-        }
+    fn syntactic_type_variables(type_: &Type) -> BTreeSet<VariableId> {
         let mut roots = BTreeSet::new();
         let mut pending = vec![type_];
         while let Some(type_) = pending.pop() {
@@ -7949,6 +7949,37 @@
                 | Type::Opaque(_)
                 | Type::Top
                 | Type::Bottom => {}
+            }
+        }
+        roots
+    }
+
+    fn project_scheme_constraints(&self, type_: &Type, level: u32) -> HashMap<VariableId, Type> {
+        let qualified = self.qualify_type(type_.clone());
+        let type_ = &qualified;
+        let mut roots = Self::syntactic_type_variables(type_);
+        let mut pending_roots = if matches!(qualified, Type::Qualified { .. }) {
+            roots.clone()
+        } else {
+            BTreeSet::new()
+        };
+        while let Some(owner) = pending_roots.pop_first() {
+            let variable = self.variables.borrow()[owner as usize].clone();
+            if variable.level <= level {
+                continue;
+            }
+            for (bounds, direction) in [
+                (variable.lower, BoundDirection::Lower),
+                (variable.upper, BoundDirection::Upper),
+            ] {
+                for bound in self.project_scheme_bounds(owner, bounds, direction, &roots, level) {
+                    let type_ = self.expand_constraint(bound);
+                    for variable in Self::syntactic_type_variables(&type_) {
+                        if roots.insert(variable) {
+                            pending_roots.insert(variable);
+                        }
+                    }
+                }
             }
         }
         let snapshots = {
@@ -7997,6 +8028,9 @@
             variables[replacement as usize].lower = lower;
             variables[replacement as usize].upper = upper;
         }
+        // Requirements and their type graph use the same replacement map.
+        // Keep the immutable qualified scheme independent of later uses of the
+        // source inference graph.
         replacements
     }
 
@@ -16293,3 +16327,7 @@
         ));
     }
 }
+
+#[cfg(test)]
+#[path = "member_constraint_tests.rs"]
+mod member_constraint_tests;
--- a/compiler/src/member_constraints.rs
+++ b/compiler/src/member_constraints.rs
@@ -182,13 +182,28 @@
     }
 
     pub(super) fn qualify_type(&self, type_: Type) -> Type {
-        let requirements = self.reachable_member_requirements(&type_);
+        let (mut requirements, body) = match type_ {
+            Type::Qualified { requirements, body } => (
+                requirements.into_iter().collect::<Vec<_>>(),
+                Rc::unwrap_or_clone(body),
+            ),
+            other => (Vec::new(), other),
+        };
+        for requirement in self.reachable_member_requirements(&body) {
+            if !requirements.iter().any(|existing| {
+                existing.name == requirement.name
+                    && same_type(&existing.subject, &requirement.subject)
+                    && same_type(&existing.member, &requirement.member)
+            }) {
+                requirements.push(requirement);
+            }
+        }
         if requirements.is_empty() {
-            return type_;
+            return body;
         }
         Type::Qualified {
             requirements: requirements.into(),
-            body: Rc::new(type_),
+            body: Rc::new(body),
         }
     }
 
@@ -206,26 +221,6 @@
             }
             other => map_type_children(other, |child| self.activate_qualified_type(child)),
         }
-    }
-
-    /// Keep the entire connected qualified graph when generalizing. The usual
-    /// root-only projection is not sufficient for an associated member's hidden
-    /// parameter, result, and effect variables.
-    pub(super) fn copy_qualified_scheme_constraints(
-        &self,
-        type_: &Type,
-        level: u32,
-    ) -> Option<HashMap<VariableId, Type>> {
-        let qualified = self.qualify_type(type_.clone());
-        if !matches!(qualified, Type::Qualified { .. }) {
-            return None;
-        }
-        let previous = self.level.replace(level + 1);
-        let mut replacements = HashMap::new();
-        let qualified = self.freshen(qualified, level, &mut replacements);
-        self.level.set(previous);
-        self.activate_qualified_type(qualified);
-        Some(replacements)
     }
 
     pub(super) fn has_member_requirements(&self, type_: &Type) -> bool {
'''
subprocess.run(['git', 'apply', '--whitespace=error'], input=patch, text=True, check=True)

Path('compiler/src/member_constraint_tests.rs').write_text(r'''use super::*;

fn signature(checker: &Checker, discard: bool) -> Type {
    checker.level.set(1);
    let receiver = checker.fresh();
    let argument = checker.fresh();
    let result = checker.fresh();
    checker.register_member_requirement(MemberRequirement {
        name: "add".to_owned(),
        subject: receiver.clone(),
        member: curried(vec![receiver.clone(), argument.clone()], result.clone()),
    });
    checker.level.set(0);
    checker.qualify_type(curried(vec![receiver, argument], if discard { Type::Unit } else { result }))
}

fn application(checker: &Checker, function: Type, left: Type, right: Type) -> Result<Type, Diagnostic> {
    let result = checker.fresh();
    checker.constrain(function, curried(vec![left, right], result.clone()), Span { start: 1, end: 4 })?;
    Ok(checker.settle(result, true))
}

#[test]
fn qualified_scheme_instantiates_independently_without_source_specialization() {
    let checker = Checker::new(Rc::new(Context::default()));
    let body = signature(&checker, false);
    let principal = checker.residual_signature(body.clone());
    assert_eq!(checker.show_settled(&principal), "forall 'q0 'q1 'q2. ('q0.add :: 'q0 -> 'q1 -> 'q2) => 'q0 -> 'q1 -> 'q2");
    assert!(closed_checked_type(&principal, &mut HashSet::new()));
    assert!(matches!(principal, Type::Forall { ref body, .. } if matches!(body.as_ref(), Type::Qualified { .. })));
    for operand in [int_type(), float_type(), float32_type()] {
        let instance = checker.instantiate(Typing::Scheme { level: 0, body: body.clone() });
        let result = application(&checker, instance, operand.clone(), operand.clone())
            .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(same_type(&result, &operand), "{}", checker.show_settled(&result));
    }
}

#[test]
fn qualified_requirement_rejects_missing_or_mixed_members() {
    for (left, right, code) in [(Type::Unit, Type::Unit, "BLOT_NO_TYPE_MEMBER"), (int_type(), float_type(), "BLOT_TYPE_ERROR")] {
        let checker = Checker::new(Rc::new(Context::default()));
        let body = signature(&checker, true);
        let instance = checker.instantiate(Typing::Scheme { level: 0, body });
        let error = application(&checker, instance, left, right).err().expect("discarding the result must not discard requirements");
        assert_eq!(error.code, code, "{}", error.message);
    }
}

#[test]
fn qualified_interface_round_trip_keeps_requirements() {
    let producer = Checker::new(Rc::new(Context::default()));
    let signature = signature(&producer, false);
    let principal = producer.residual_signature(signature);
    let mut builder = FlatTypeBuilder::default();
    let root = flatten_interface_type(&principal, &mut HashSet::new(), &mut builder).expect("closed qualified type flattens");
    let encoded = serde_json::to_vec(&builder.nodes).unwrap();
    let arena = FlatTypeArena { nodes: serde_json::from_slice(&encoded).unwrap() };
    let consumer = Checker::new(Rc::new(Context::default()));
    let hydrated = consumer.inflate_interface_type(&arena, root, &mut HashMap::new());
    assert!(same_type(&principal, &hydrated));
    for operand in [int_type(), float_type(), float32_type()] {
        let Type::Forall { variables, body } = hydrated.clone() else { panic!("quantifiers were lost") };
        let instance = consumer.instantiate_forall(variables, Rc::unwrap_or_clone(body));
        let result = application(&consumer, instance, operand.clone(), operand.clone()).unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(same_type(&result, &operand), "{}", consumer.show_settled(&result));
    }
}

#[test]
fn failed_qualified_speculation_restores_pending_requirements() {
    let checker = Checker::new(Rc::new(Context::default()));
    let body = signature(&checker, false);
    let instance = checker.instantiate(Typing::Scheme { level: 0, body });
    let result = checker.fresh();
    let rejected = curried(vec![int_type(), float_type()], result.clone());
    assert!(!checker.can_constrain(instance.clone(), rejected, Span { start: 1, end: 4 }));
    let result = application(&checker, instance, float_type(), float_type()).unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
    assert!(same_type(&result, &float_type()), "{}", checker.show_settled(&result));
}

#[test]
fn projected_scheme_keeps_intermediate_member_application_constraints() {
    let checker = Checker::new(Rc::new(Context::default()));
    checker.level.set(1);
    let receiver = checker.fresh();
    let argument = checker.fresh();
    let member = checker.fresh();
    let partial = checker.fresh();
    let result = checker.fresh();
    let span = Span { start: 1, end: 4 };
    checker.register_member_requirement(MemberRequirement { name: "add".to_owned(), subject: receiver.clone(), member: member.clone() });
    checker.constrain(member, curried(vec![receiver.clone()], partial.clone()), span).unwrap();
    checker.constrain(partial, curried(vec![argument.clone()], result.clone()), span).unwrap();
    let body = curried(vec![receiver, argument], result);
    checker.level.set(0);
    let replacements = checker.project_scheme_constraints(&body, 0);
    let body = substitute_inference_variables(checker.qualify_type(body), &replacements);
    for operand in [int_type(), float_type(), float32_type()] {
        let instance = checker.instantiate(Typing::Scheme { level: 0, body: body.clone() });
        let result = application(&checker, instance, operand.clone(), operand.clone()).unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        assert!(same_type(&result, &operand), "{}", checker.show_settled(&result));
    }
}
''')
p = Path('compiler/src/operator_dispatch_tests.rs')
p.write_text(p.read_text() + r'''
#[test]
fn generic_dispatch_keeps_call_site_domains_without_prelude() {
    with_stack(|| {
        let mut compiler = session(&format!(
            "{DISPATCH}const sum = fn left => fn right => left + right\nreturn (sum 2 3, sum (@float.of_int 2) (@float.of_int 3), sum (@f32.of_int 2) (@f32.of_int 3))\n"
        ));
        assert_result(&mut compiler, "{ .0 = Int; .1 = F64; .2 = F32 }", "(5, 5, 5f32)");
        let prepared = compiler.prepare_runtime_hir("main.blot");
        assert_eq!(prepared["ok"], true, "{prepared}");
    });
}

#[test]
fn generic_dispatch_rejects_unsupported_operands_even_with_unused_result() {
    with_stack(|| {
        for call in ["sum () ()", "sum integer (@float.of_int 3)"] {
            let compiler = session(&format!(
                "{DISPATCH}const sum = fn left => fn right => left + right\nlet integer :: @type.int\nlet integer = 2\nlet unused = {call}\nreturn ()\n"
            ));
            let checked = compiler.check_module("main.blot");
            assert_eq!(checked["ok"], false, "{call}: {checked}");
        }
    });
}
''')
p = Path('spec/TYPECHECKING.md')
p.write_text(p.read_text().rstrip() + '''\n\nQualified schemes freeze their requirements at generalization. Freshening a use\nnever rediscovers requirements from an already-used source graph. Projection\nretains intermediate argument, result, and effect variables reachable through\nstructural member bounds, while collapsing non-root alias chains as for ordinary\nschemes. Unqualified schemes retain the ordinary projection contract.\n''')
