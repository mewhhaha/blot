from pathlib import Path

path = Path("compiler/src/ownership.rs")
text = path.read_text()

old = """            while index < declarations.len()
                && recursive_declaration(analysis.module, declarations[index])
            {
                index += 1;
            }
"""
new = """            while index < declarations.len() {
                if recursive_declaration(analysis.module, declarations[index]) {
                    index += 1;
                    continue;
                }
                if signature_declaration(analysis.module, declarations[index])
                    && index + 1 < declarations.len()
                    && recursive_declaration(analysis.module, declarations[index + 1])
                {
                    index += 1;
                    continue;
                }
                break;
            }
"""
if text.count(old) != 1:
    raise SystemExit(
        f"recursive ownership group loop anchor count={text.count(old)}"
    )
text = text.replace(old, new, 1)

anchor = """fn recursive_declaration(module: &Module, declaration: DeclarationId) -> bool {
"""
helper = """fn signature_declaration(module: &Module, declaration: DeclarationId) -> bool {
    matches!(
        module.arena.declarations[declaration.0 as usize],
        Declaration::Binding {
            kind: DeclarationKind::Sig,
            ..
        }
    )
}

"""
if text.count(anchor) != 1:
    raise SystemExit(f"recursive declaration anchor count={text.count(anchor)}")
path.write_text(text.replace(anchor, helper + anchor, 1))

print("made sig declarations transparent inside recursive ownership groups")
