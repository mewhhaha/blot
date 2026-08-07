from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))

# HIR capture traversal: type values recurse into their element description;
# evaluator Regions recurse over the live Store contents so runtime captures
# inside an array element remain visible to closure conversion.
path = "experiments/rust-middle/src/hir.rs"
replace_once(
    path,
    '''        Value::Array(elements) | Value::IndexedStep { elements } | Value::Union(elements) => {
            for element in elements {
                collect_value(context, element, visited, captured)?;
            }
        }
''',
    '''        Value::Array(elements) | Value::IndexedStep { elements } | Value::Union(elements) => {
            for element in elements {
                collect_value(context, element, visited, captured)?;
            }
        }
        Value::RegionType(element) => {
            collect_value(context, element, visited, captured)?;
        }
        Value::Region { store, start, end } => {
            let cells = store.borrow();
            for element in &cells[*start..*end] {
                collect_value(context, element, visited, captured)?;
            }
        }
''',
)
replace_once(
    path,
    '''        Value::Array(elements) | Value::IndexedStep { elements } | Value::Union(elements) => {
            for element in elements {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
''',
    '''        Value::Array(elements) | Value::IndexedStep { elements } | Value::Union(elements) => {
            for element in elements {
                *element = replace_value(context, element, replacements, replaced)?;
            }
        }
        Value::RegionType(element) => {
            **element = replace_value(context, element, replacements, replaced)?;
        }
        Value::Region { store, start, end } => {
            let cells = store.borrow();
            let mut replaced_cells = cells.clone();
            drop(cells);
            for element in &mut replaced_cells[*start..*end] {
                *element = replace_value(context, element, replacements, replaced)?;
            }
            *store = Rc::new(std::cell::RefCell::new(replaced_cells));
        }
''',
)
# Public runtime constant/export lowering must not accidentally expose the
# compiler-private capability representation. Internal residual lowering gets a
# separate Region representation in the next patch.
replace_once(
    path,
    '''            Type::Array(element) => {
''',
    '''            Type::Region(_) => Err(hir_error(
                "A live Region is compiler-private and cannot cross the runtime export boundary.",
            )),
            Type::Array(element) => {
''',
)

# Residual signatures can contain Region internally and must traverse its
# element variables. Flattened public module interfaces deliberately cannot.
path = "experiments/rust-middle/src/typecheck.rs"
replace_once(
    path,
    '''                Type::Array(element) => pending.push((element, bound)),
''',
    '''                Type::Array(element) | Type::Region(element) => pending.push((element, bound)),
''',
)
replace_once(
    path,
    '''        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, nodes)?),
''',
    '''        Type::Array(element) => FlatTypeNode::Array(flatten_interface_type(element, bound, nodes)?),
        // Region authority is intentionally absent from portable/public module
        // interfaces. It must be consumed/frozen before crossing that boundary.
        Type::Region(_) => return None,
''',
)
# A second residual-type walker around this area recursively visits structural
# types to find representation variables.
replace_once(
    path,
    '''                Type::Array(element) => pending.push(element),
''',
    '''                Type::Array(element) | Type::Region(element) => pending.push(element),
''',
)

# Session/debug JSON can describe the private type but never serializes the
# mutable Store contents as a stable/public value.
path = "experiments/rust-middle/src/session.rs"
replace_once(
    path,
    '''        Value::Array(elements) => serde_json::json!({
            "tag": "array",
            "elements": elements.iter().map(json_value).collect::<Vec<_>>(),
        }),
''',
    '''        Value::Array(elements) => serde_json::json!({
            "tag": "array",
            "elements": elements.iter().map(json_value).collect::<Vec<_>>(),
        }),
        Value::RegionType(element) => serde_json::json!({
            "tag": "region-type",
            "element": json_value(element),
        }),
        Value::Region { start, end, .. } => serde_json::json!({
            "tag": "opaque",
            "display": format!("<region {start}..{end}>"),
        }),
''',
)

print("finished Rust Region compile policy cases")
