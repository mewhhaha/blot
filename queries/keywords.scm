; Keyword highlighting, appended to baba's generated highlights.
;
; Baba supplies basic keyword captures. These scoped captures add the more
; precise control, declaration, and import categories used by Helix themes.
;
; Each capture is scoped to the rule the keyword belongs to rather than matched
; bare. blot lets field names be keywords (`.const`, `.return`, `.of`), and a
; bare `"const" @keyword` would colour those too — the token inside a
; `field_name` is more deeply nested than the `(field_name)` capture, so it wins.
; Scoping is what keeps `.const` a member and `const` a keyword.

(module_header
  "module" @keyword.control.import
  "with" @keyword.control.import)

(fixity_declaration
  associativity: _ @keyword.storage.modifier)

(binding
  kind: _ @keyword.storage.type
  recursive: _? @keyword.storage.modifier)

(signature
  kind: _ @keyword.storage.type
  recursive: _? @keyword.storage.modifier)

(sequencing
  "use" @keyword.control)

(result
  "return" @keyword.control.return)

(opening
  "open" @keyword.control.import)

(import_expression
  "import" @keyword.control.import
  "with"? @keyword.control.import)

(iteration
  "for" @keyword.control.repeat
  "case"? @keyword.control.conditional)

(iteration_source
  "in" @keyword.control)

(breaking
  "break" @keyword.control.return)

(continuing
  "continue" @keyword.control.repeat)

(conditional_statement
  "if" @keyword.control.conditional)

(conditional_statement_guard
  "let" @keyword.storage.type
  "else" @keyword.control.conditional)

(conditional_statement_else_if_clause
  (ELSE_IF) @keyword.control.conditional)

(conditional_statement_else_clause
  "else" @keyword.control.conditional)

(case_expression
  "case" @keyword.control.conditional
  "of" @keyword.control.conditional)

(case_guard
  "if" @keyword.control.conditional)

(do_block
  "do" @keyword.control)

(lambda_parameter
  "fn" @keyword.function)

; A constructor is a TYPE_IDENT behind `#`. Types are values in blot, so the
; bare form remains a variable. Only the explicitly tagged form is a constructor.
(constructor_expression
  "#" @constructor
  constructor: (TYPE_IDENT) @constructor)

(constructor_pattern
  "#" @constructor
  constructor: (TYPE_IDENT) @constructor)
