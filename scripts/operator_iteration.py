"""Temporary iteration driver; not part of the final draft."""
from pathlib import Path
import subprocess

BASE = "ce38ba30457379f1d704da7a5aff8fcd61c1cb29"

def once(text, before, after):
    assert text.count(before) == 1, (before[:150], text.count(before))
    return text.replace(before, after, 1)

p = Path("compiler/src/typecheck/operators.rs")
t = subprocess.check_output(["git", "show", f"{BASE}:{p}"], text=True)
t = once(t, "if closed_checked_type(&upper, &mut HashSet::new())", "if !matches!(upper, Type::Top | Type::Bottom)\n                    && closed_checked_type(&upper, &mut HashSet::new())")
t = once(t, "if contains_bottom(&settled)\n                ||", "if matches!(settled, Type::Top | Type::Bottom | Type::Variable(_) | Type::Rigid(_))\n                || contains_bottom(&settled)\n                ||")
t = once(t, "        let mut parameter = *parameter;", "        let root_body = *body;\n        let mut parameter = *parameter;")
t = t.replace("*body_ref(value)", "root_body")
t = t[:t.index("\nfn body_ref(value:")] + "\n"
p.write_text(t)

p = Path("compiler/src/typecheck.rs")
t = p.read_text()
start = t.index("fn is_operator_member_closure(")
end = t.index("\nfn ", start + 1)
t = t[:start] + t[end:]
p.write_text(t)

p = Path("compiler/src/session.rs")
t = p.read_text()
t = once(t, "            for (label, text, expected) in cases {", "            let mut failures = Vec::new();\n            for (label, text, expected) in cases {")
t = once(t, '                assert_eq!(checked["ok"], expected, "{label}: {checked}");', '                if checked["ok"] != expected {\n                    failures.push(format!("{label}: {checked}"));\n                    continue;\n                }')
t = once(t, '                    assert_eq!(prepared["ok"], true, "{label}: {prepared}");', '                    if prepared["ok"] != true { failures.push(format!("{label}: {prepared}")); }')
anchor = '            }\n        });\n    }\n\n    fn source(value:'
t = once(t, anchor, '            }\n            assert!(failures.is_empty(), "{}", failures.join("\\n"));\n        });\n    }\n\n    fn source(value:')
p.write_text(t)
