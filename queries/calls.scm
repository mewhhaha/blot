; A juxtaposition with at least one argument is a function call. Capture the
; called binding, or the final projected member of a qualified callee.

(postfix_expression
  value: (primary_expression
    (IDENT) @function.call)
  .
  [
    (WHITESPACE)
    (COMMENT)
  ]*
  .
  arguments: (application_argument))

(postfix_expression
  value: (primary_expression
    (TYPE_IDENT) @function.call)
  .
  [
    (WHITESPACE)
    (COMMENT)
  ]*
  .
  arguments: (application_argument))

(postfix_expression
  suffixes: (field_suffix
    field: (field_name) @function.call)
  .
  [
    (WHITESPACE)
    (COMMENT)
  ]*
  .
  arguments: (application_argument))
