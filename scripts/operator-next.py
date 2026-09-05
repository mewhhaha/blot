from pathlib import Path

p = Path('compiler/src/typecheck.rs')
s = p.read_text()
a = '''            if name == "@type.resolve_member" && *arity == 3 {
                if let [Value::Text(operation)] = applied.as_slice() {'''
b = '''            if name == "@type.resolve_member" && *arity == 3
                && let [Value::Text(operation)] = applied.as_slice()
            {'''
assert s.count(a) == 1
s = s.replace(a, b, 1)
a = '''                    return Some(curried(vec![operand.clone(), operand], result));
                }
            }
            let mut type_ = primitive_type(self, name)?;'''
b = '''                    return Some(curried(vec![operand.clone(), operand], result));
            }
            let mut type_ = primitive_type(self, name)?;'''
assert s.count(a) == 1
p.write_text(s.replace(a, b, 1))

# Print only public repository source information needed for the next patch.
# This temporary helper is removed by the branch-scoped workflow.
for path in Path('compiler/src').glob('*.rs'):
    text = path.read_text()
    for number, line in enumerate(text.splitlines(), 1):
        if 'RecordUpdate' in line or (path.name == 'typecheck.rs' and any(
            ('fn ' + name) in line for name in [
                'meet_types', 'reify_type', 'show', 'closed_checked_type',
                'closed_type_key', 'flatten_interface_type', 'inflate',
                'collect', 'type_key', 'freeze', 'seal',
            ]
        )):
            print(f'BOUNDARY {path}:{number}: {line.strip()}')
