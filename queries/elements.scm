; Element highlighting is scoped to element rules because `<` and `>` remain
; ordinary operators everywhere else in the language.

(element_expression
  (ANGLE_LEFT) @punctuation.bracket
  name: (element_name
    [
      (IDENT)
      (TYPE_IDENT)
    ] @tag))

(element_body
  (ANGLE_RIGHT) @punctuation.bracket)

(element_body
  (ANGLE_CLOSE) @punctuation.bracket)

(element_body
  closing: (element_name
    [
      (IDENT)
      (TYPE_IDENT)
    ] @tag))

(element_self_close
  (ANGLE_SELF_CLOSE) @punctuation.bracket)

(element_property
  "." @punctuation.delimiter
  name: (field_name
    [
      (IDENT)
      (TYPE_IDENT)
      (INTEGER)
    ] @attribute)
  "=" @punctuation.delimiter)

(shape_field
  optional: (QUESTION) @punctuation.special)

; baba classifies the property wrapper as a member. These leaf captures keep a
; literal payload's own class when it occupies exactly the wrapper's span.
(element_property_value
  (TEXT) @string)

(element_property_value
  (INTEGER) @number)

(element_property_value
  (FLOAT) @number)
