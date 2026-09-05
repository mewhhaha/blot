from pathlib import Path

p = Path("compiler/src/typecheck.rs")
s = p.read_text()
old = '''                    let is_resolve_op = static_member(&target_value, name)
                        .as_ref()
                        .is_some_and(|val| is_operator_member_closure(&self.context, val));
'''
new = '''                    let is_resolve_op = static_member(&target_value, name)
                        .as_ref()
                        .is_some_and(|val| is_resolve_member_closure(&self.context, val));
'''
count = s.count(old)
if count < 2:
    raise SystemExit(f"expected at least two selected-member classifier sites, found {count}")
s = s.replace(old, new, 2)
p.write_text(s)
