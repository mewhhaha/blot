from pathlib import Path

p = Path("compiler/src/typecheck.rs")
s = p.read_text()
anchor = '''                if member_arguments.len() == 2
                    && let Ok(Value::Primitive { name, .. }) =
                        self.evaluate(path, member_callee, values, Phase::Comptime)
                    && name == "@i32x4.lane"
'''
insert = '''                if member_arguments.len() == 2
                    && let Expression::Field { target, name, .. } =
                        &module.arena.expressions[member_callee.0 as usize]
                    && let Ok(target_value) =
                        self.evaluate(path, *target, values, Phase::Comptime)
                    && static_member(&target_value, name)
                        .as_ref()
                        .is_some_and(|value| is_resolve_member_closure(&self.context, value))
                    && matches!(
                        name.as_str(),
                        "eq" | "ne"
                            | "lt"
                            | "le"
                            | "gt"
                            | "ge"
                            | "add"
                            | "sub"
                            | "mul"
                            | "div"
                            | "rem"
                    )
                {
                    return self.infer_resolve_member(
                        path,
                        module,
                        expression_id,
                        name.clone(),
                        member_arguments[0],
                        member_arguments[1],
                        environment,
                        values,
                        dependencies,
                        span,
                    );
                }
''' + anchor
if s.count(anchor) != 1:
    raise SystemExit(f"expected one SIMD anchor, found {s.count(anchor)}")
p.write_text(s.replace(anchor, insert, 1))
