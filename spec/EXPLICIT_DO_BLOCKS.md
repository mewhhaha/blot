# Explicit statement blocks

## Rule

A function body and a `case` arm are values. A single expression is therefore
written directly:

```blot
let increment = fn value => value + 1

let unwrap = fn option => case option of
  #Some value => value
  #None => 0
```

A statement sequence is a value only when introduced by `do:`:

```blot
let classify = fn value => do:
  if value < 0:
    return #Negative

  return #Nonnegative

let unwrap_or_zero = fn option => case option of
  #Some value => value
  #None => do:
    let fallback = 0
    return fallback
```

The same rule applies in every value position. Layout alone does not construct a
statement block. `do:` is the explicit lexical and `return` boundary.

The declaration consuming the block determines its phase:

```blot
const reflected_fields = do:
  let reflected = reflect T
  return field_names reflected

let runtime_fields = do:
  use names <- read_names ()
  return names
```

The `const` initializer must resolve at compile time; the `let` initializer is
an ordinary run-time value. Both use one statement-block grammar and one AST
form.

## Frontend contract

The grammar has no anonymous layout-only block expression. `statement_suite`
remains the internal suite owned by statement forms such as `if` and `for`, but
it is not independently a value. The only source value containing declarations,
rebinding, sequencing, statement conditionals, loops, `break`, or `return` is a
`do:` block.

Removing the anonymous block rule is an intentional syntax break. The migration
is mechanical: insert `do:` after the expression introducer and retain the
existing indentation. The executable corpus and embedded source fixtures must be
migrated in the same change so no compatibility parser remains hidden behind
formatting or lowering.
