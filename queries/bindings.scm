; Classify functions by their syntax, rather than by capitalization: types are
; ordinary values, and a capitalized binding need not denote a type.
(binding
  pattern: (binding_pattern
    value: (pattern_core [(IDENT) (TYPE_IDENT)] @function))
  value: (indented_value (lambda)))

(lambda_parameter
  pattern: (binding_pattern
    value: (pattern_core [(IDENT) (TYPE_IDENT)] @variable.parameter)))

(lambda_parameter
  pattern: (binding_pattern
    value: (pattern_core
      (tuple_pattern
        (annotated_pattern
          pattern: (binding_pattern
            value: (pattern_core [(IDENT) (TYPE_IDENT)] @variable.parameter)))))))

; Shorthand names are both members and bindings. Keep their member coloring;
; an explicit alias is a parameter name.
(lambda_parameter
  pattern: (binding_pattern
    value: (pattern_core
      (shape_pattern
        (shape_pattern_field
          value: (binding_pattern
            value: (pattern_core [(IDENT) (TYPE_IDENT)] @variable.parameter)))))))

(binding_pattern qualifier: (operator_token) @keyword.storage.modifier)
