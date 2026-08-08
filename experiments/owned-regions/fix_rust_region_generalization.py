from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


path = "experiments/rust-middle/src/typecheck.rs"

# Region is parametric in exactly the same inference variable as Array, but it
# is invariant at the constraint boundary. Every generic-type traversal must
# still descend through its element or a generalized Region can retain a live
# inference variable after its sibling Array occurrence has been rigidified.
replace_once(
    path,
    '''            Type::Array(element) => Type::Array(Box::new(self.freshen(*element, level, fresh))),
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => Type::Array(Box::new(self.freshen(*element, level, fresh))),
            Type::Region(element) => {
                Type::Region(Box::new(self.freshen(*element, level, fresh)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => self.level_of(element),
            Type::Union(members) => members
''',
    '''            Type::Array(element) | Type::Region(element) => self.level_of(element),
            Type::Union(members) => members
''',
)

replace_once(
    path,
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.extrude(*element, polarity, level, copies)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => Type::Array(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => Type::Array(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Region(element) => Type::Region(Box::new(
                self.residual_signature_type(*element, seen, resolved, unresolved, recursive),
            )),
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
    '''            Type::Array(element) => {
                Type::Array(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Region(element) => {
                Type::Region(Box::new(self.settle_seen(*element, positive, seen)))
            }
            Type::Variant { cases, open } => Type::Variant {
''',
)

replace_once(
    path,
    '''        Type::Array(element) => Type::Array(Box::new(substitute_rigid(*element, replacements))),
        Type::Variant { cases, open } => Type::Variant {
''',
    '''        Type::Array(element) => Type::Array(Box::new(substitute_rigid(*element, replacements))),
        Type::Region(element) => {
            Type::Region(Box::new(substitute_rigid(*element, replacements)))
        }
        Type::Variant { cases, open } => Type::Variant {
''',
)

print("fixed Rust Region generic traversals")
