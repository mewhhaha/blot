; Indentation.
;
; Every variable-width region in blot carries an explicit terminator, because
; the GPU profile requires a locatable boundary. That makes indentation
; unusually mechanical: indent inside each region, outdent on its terminator.

[
  (block)
  (conditional)
  (conditional_statement)
  (case_expression)
  (iteration)
  (shape)
  (shape_pattern)
  (array)
  (array_pattern)
  (parenthesized_or_tuple)
  (tuple_pattern)
  (operator_section)
] @indent

[
  "end"
  "}"
  "]"
  ")"
] @outdent
