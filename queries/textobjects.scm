; Text objects.
;
; blot has one binding form and one function form, so the mapping is short:
; a "function" is a lambda, an "entry" is a shape member, and a "class" is a
; declaration — the nearest thing to a named unit the language has.

(lambda
  body: (_) @function.inside) @function.around

; One `lambda` holds the whole `fn a => fn b =>` chain, so a parameter object is
; a `lambda_parameter` rather than a field of the lambda.
(lambda_parameter
  pattern: (_) @parameter.inside) @parameter.around

(tuple_pattern
  (binding_pattern) @parameter.inside)

(parenthesized_or_tuple
  (value) @parameter.inside)

(COMMENT) @comment.inside

(COMMENT)+ @comment.around

(shape_field
  value: (_) @entry.inside) @entry.around

(shape_pattern_field) @entry.around

(binding
  value: (_) @class.inside) @class.around

(block
  statements: (_) @block.inside) @block.around
