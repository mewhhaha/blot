; Symbol tags, for Helix's symbol picker.
;
; A binding whose value is a lambda is a function; every other binding is a
; variable. blot draws no other distinction — `const Point = struct {...}` is a
; variable that happens to hold a type, because types are values.

(binding
  pattern: (binding_pattern
    value: (pattern_core (IDENT) @name))
  value: (value (lambda))) @definition.function

(binding
  pattern: (binding_pattern
    value: (pattern_core (TYPE_IDENT) @name))
  value: (value (lambda))) @definition.function

(binding
  pattern: (binding_pattern
    value: (pattern_core (IDENT) @name))) @definition.var

(binding
  pattern: (binding_pattern
    value: (pattern_core (TYPE_IDENT) @name))) @definition.var

(shape_field
  name: (field_name) @name) @definition.field

(fixity_declaration
  operator: (OPERATOR) @name) @definition.function
