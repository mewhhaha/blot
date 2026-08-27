# Language cleanup experiment

This directory records the source comparison used while simplifying the Blot
surface. The implementation now:

1. uses one `do:` statement block whose `const` or `let` consumer determines
   compile-time or run-time phase;
2. keeps function-local `const` as the same compile-time must-resolve
   obligation;
3. lets signatures relate open effect rows with a tail such as `..e`; and
4. removes element syntax in favor of ordinary functions, records, arrays, and
   explicit nullary child computations.

`element-free.blot` is the direct component spelling used to evaluate the fourth
change. Its recorded result is:

```text
"<div>Count: <button>Save</button><button disabled data-order=2>Delete</button><icon></icon></div>"
```

The historical `examples/elements.blot` corpus entry now uses the same ordinary
spelling and keeps its existing golden output. No replacement component syntax
is introduced here; future sugar can be evaluated against this baseline.

## Declaration-directed `do:`

`do:` is the value-producing statement scope. A surrounding `const` requires the
complete block to resolve during compilation:

```blot
const fields = do:
  let reflected = reflect T
  return field_names reflected
```

A surrounding `let` uses the same block at run time. Keeping phase on the
declaration removes a keyword and an AST case without introducing a second
control structure.

The common one-expression case remains just
`const fields = field_names
(reflect T)`. A function-local `const` may be
deferred by generic checking until a specialization supplies concrete values,
but it never becomes a runtime `let`.

## Writable effect-row tails

A signature may bind the rest of an effect row with one final `..name` tail:

```blot
let logged ::
  (a -> b ~ { ..e }) ->
  a -> b ~ { Console, ..e }
let logged = fn transform => fn value => transform value
```

The tail is local to that signature, must occur at least twice, and carries only
row identity. It grants no authority to construct or handle the effects it
represents and does not add record row polymorphism.
