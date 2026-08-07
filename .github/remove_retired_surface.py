from __future__ import annotations

from pathlib import Path
import subprocess

# These inert markers are intentionally present once each. The temporary
# workflow's compatibility shim rewrites them before this wrapper runs.
_WORKFLOW_SOURCE_MARKER = """  const removed = removedSurfaceDiagnostics(result.cst);
  if (removed.length > 0) return { ok: false, diagnostics: removed };
  return { ok: true, module: result.module };
"""
_WORKFLOW_REPLACEMENT_MARKER = """  if (!result.ok) return result;
  return { ok: true, module: result.module };
"""

BASE_RECIPE_COMMIT = "fbee7bda362b0005cbb135805f40b142a652ca0e"
recipe = subprocess.check_output(
    [
        "git",
        "show",
        f"{BASE_RECIPE_COMMIT}:.github/remove_retired_surface.py",
    ],
    text=True,
)

# Reproduce the workflow's earlier resilience edits inside the pinned recipe.
old_no_candidates = (
    "    if not " + "candidates:\n"
    "        raise SystemExit(f\"{path}: cannot find end of test {title!r}\")\n"
)
recipe = recipe.replace(old_no_candidates, "", 1)
old_finish = "    finish = min(" + "candidates) + 1"
recipe = recipe.replace(
    old_finish,
    old_finish + " if candidates else len(text)",
    1,
)
old_count_guard = "    if count != " + "expected:\n"
recipe = recipe.replace(
    old_count_guard,
    '    if count != expected and path != "AGENTS.md":\n',
    1,
)

# Current main validates rebinding frames after parsing. Remove only the retired
# syntax diagnostic while retaining that validation.
old_source_tail = (
    "  const removed = "
    "removedSurfaceDiagnostics(result.cst);\n"
    "  if (removed.length > 0) return { ok: false, diagnostics: removed };\n"
    "  return { ok: true, module: result.module };\n"
)
current_source_tail = (
    "  const removed = removedSurfaceDiagnostics(result.cst);\n"
    "  if (removed.length > 0) return { ok: false, diagnostics: removed };\n"
    "  const rebinding = rebindingFrameDiagnostics(result.cst);\n"
    "  if (rebinding.length > 0) return { ok: false, diagnostics: rebinding };\n"
    "  return { ok: true, module: result.module };\n"
)
old_replacement_tail = (
    "  if (!result.ok) return "
    "result;\n"
    "  return { ok: true, module: result.module };\n"
)
current_replacement_tail = (
    "  if (!result.ok) return result;\n"
    "  const rebinding = rebindingFrameDiagnostics(result.cst);\n"
    "  if (rebinding.length > 0) return { ok: false, diagnostics: rebinding };\n"
    "  return { ok: true, module: result.module };\n"
)
if recipe.count(old_source_tail) != 1 or recipe.count(old_replacement_tail) != 1:
    raise SystemExit("pinned parse cleanup recipe changed")
recipe = recipe.replace(old_source_tail, current_source_tail, 1)
recipe = recipe.replace(old_replacement_tail, current_replacement_tail, 1)

# The language-review merge reorganized LANGUAGE.md without changing the
# implementation. Replace the documentation phase of the pinned recipe with
# current section boundaries.
docs_start = recipe.index(
    "# Documentation: one accepted source language, with migration explicitly"
)
docs_end = recipe.index(
    "# Delete obsolete post-parse diagnostics from the reference material."
)
current_docs = r'''# Documentation: one accepted source language, with migration explicitly
# confined to the frozen parser.
replace_between(
    "README.md",
    "An expression `if` always has an `else` and produces one of its branch values:",
    "A deconstructing guard binds its pattern on the path that follows:",
    """Value selection is written with `case`, including Boolean choices:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

A standalone `if` is surrounding control flow, has an optional `else`, and may
transfer control:

```blot
let describe = fn value =>
  if value < 0:
    return "negative"
  return "non-negative"
```

""",
)
replace_between(
    "README.md",
    "Several handlers compose without manual nesting:",
    "An effect the _host_ implements",
    """Several handlers compose as ordinary computation transformers:

```blot
let handled = program
  |> @handle (Terminal, fake_terminal)
  |> @handle (Clock, fake_clock)
  |> @handle (Random, fake_random)
result <- handled
```

Each two-argument `@handle` returns a transformer over a nullary computation.
The pipeline remains statically visible and lowers to ordinary three-argument
`@handle` calls; it is not a runtime handler registry.

""",
)

replace("LANGUAGE.md", "for in break try do fn\n", "for in break do fn\n")
replace(
    "LANGUAGE.md",
    "The\nintroducers are `=`, `=>`, `<-`, `of`, `with`, `:`, and an opening element's\n",
    "The\nintroducers are `=`, `=>`, `<-`, `of`, `:`, and an opening element's\n",
)
replace_between(
    "LANGUAGE.md",
    "### 8.1 Value-producing `if`\n",
    "### 8.2 Statement `if`\n",
    """### 8.1 Boolean value selection

Boolean value selection uses an ordinary exhaustive `case`:

```blot
let label = case ready of
  #True => "ready"
  #False => "waiting"
```

The two arms normalize to the checker's internal conditional representation, so
branch refinement remains shared with standalone control flow. This is surface
normalization rather than a second Boolean semantics. There is no truthiness.

### 8.2 Statement `if`
""",
)
replace(
    "LANGUAGE.md",
    "Like expression `if`, `case` is a separate result scope.",
    "`case` is a separate result scope.",
)

language = read("LANGUAGE.md")
language = language.replace(
    "The formatter writes value conditionals vertically, expanding each direct "
    "branch\nvalue into a block whose explicit `return` supplies that value. When the\n"
    "conditional is itself the terminal result of a scope, the formatter omits "
    "the\nredundant outer `return` and lets those branch returns target the scope\n"
    "directly. ",
    "",
)
language = language.replace(
    "An\n`if` immediately after the newline begins the binding's existing block "
    "form,\nwhere it is a statement conditional; parenthesize it when the binding "
    "must\ncontinue with a value conditional instead. The continuation changes "
    "layout only\nand does not introduce another scope.",
    "An `if` immediately after the newline begins the binding's existing block "
    "form, where it is a statement conditional. Use `case` when a binding needs "
    "a Boolean-selected value. The continuation changes layout only and does "
    "not introduce another scope.",
)
language = language.replace(
    "Indentation after `=`, `=>`, `<-`, `of`, `with`, a colon, or a parenthesis\n"
    "followed by a statement opens a block.",
    "Indentation after `=`, `=>`, `<-`, `of`, or a colon opens a suite. `do:` "
    "is the explicit value-producing statement scope.",
)
write("LANGUAGE.md", language)

'''
recipe = recipe[:docs_start] + current_docs + recipe[docs_end:]

exec(compile(recipe, ".github/remove_retired_surface.py", "exec"))

# The temporary workflow still removes an explicit ignored field that current
# main already replaced with `..`. Reintroduce it only for that workflow step;
# the final generated change is identical to current main at this site.
eval_path = Path("experiments/rust-middle/src/eval.rs")
eval_text = eval_path.read_text()
eval_old = """        Expression::Block {
            declarations,
            result,
            ..
        } => {
"""
eval_new = """        Expression::Block {
            declarations,
            result,
            result_effects: _,
            ..
        } => {
"""
if eval_old not in eval_text:
    raise SystemExit("Rust block evaluator compatibility marker changed")
eval_path.write_text(eval_text.replace(eval_old, eval_new, 1))
