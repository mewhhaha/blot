; Keyword highlighting, appended to baba's generated highlights.
;
; baba's metadata emits captures as named-node patterns — `(let) @keyword` — but
; every blot keyword is an anonymous literal node, so those patterns would not
; compile. Anonymous nodes have to be matched by their spelling.
;
; Each capture is scoped to the rule the keyword belongs to rather than matched
; bare. blot lets field names be keywords (`.const`, `.return`, `.of`), and a
; bare `"const" @keyword` would colour those too — the token inside a
; `field_name` is more deeply nested than the `(field_name)` capture, so it wins.
; Scoping is what keeps `.const` a member and `const` a keyword.

(module_header
  "module" @keyword.control.import)

(operator_section
  "operators" @keyword)

(fixity_declaration
  associativity: _ @keyword.storage.modifier)

(binding
  kind: _ @keyword.storage.type)

(result
  "return" @keyword.control.return)

(opening
  "open" @keyword.control.import)

(iteration
  "for" @keyword.control.repeat
  "do" @keyword.control
  "end" @keyword.control)

(iteration_source
  "in" @keyword.control)

(breaking
  "break" @keyword.control.return)

(block
  "do" @keyword.control
  "in" @keyword.control
  "end" @keyword.control)

(conditional
  "if" @keyword.control.conditional
  "then" @keyword.control.conditional
  "end" @keyword.control.conditional)

(else_if_clause
  (ELSE_IF) @keyword.control.conditional
  "then" @keyword.control.conditional)

(else_clause
  "else" @keyword.control.conditional)

(conditional_statement
  "if" @keyword.control.conditional
  "end" @keyword.control.conditional)

(conditional_statement_guard
  "let" @keyword.storage.type
  "else" @keyword.control.conditional
  "do" @keyword.control)

(conditional_statement_branches
  "then" @keyword.control.conditional
  "do" @keyword.control)

(conditional_statement_else_if_clause
  (ELSE_IF) @keyword.control.conditional
  "then" @keyword.control.conditional
  "do" @keyword.control)

(conditional_statement_else_clause
  "else" @keyword.control.conditional
  "do" @keyword.control)

(case_expression
  "case" @keyword.control.exception
  "of" @keyword.control.exception
  "end" @keyword.control.exception)

(handler_composition
  "try" @keyword.control.exception
  "then" @keyword.control.exception
  "do" @keyword.control
  "end" @keyword.control)

(prefix_operator
  [
    "rec"
    "comptime"
  ] @keyword.storage.modifier)

; A constructor is a TYPE_IDENT behind `#`. Types are values in blot, so the
; generated `(TYPE_IDENT) @type` is right for the bare form; this narrows the
; tagged one.
(constructor_expression
  "#" @constructor
  constructor: (TYPE_IDENT) @constructor)

(constructor_pattern
  "#" @constructor
  constructor: (TYPE_IDENT) @constructor)
