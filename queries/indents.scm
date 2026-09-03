; Indentation.
;
; Layout suites and delimited collections define every indentation region.

[
  (block)
  (statement_suite)
  (case_expression)
  (shape)
  (shape_pattern)
  (array)
  (array_pattern)
  (parenthesized_or_tuple)
  (tuple_pattern)
] @indent

[
  "}"
  "]"
  ")"
] @outdent
