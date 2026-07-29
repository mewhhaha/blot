(IDENT) @variable
(TYPE_IDENT) @type
(INTEGER) @number
(TEXT) @string
(INTRINSIC) @function.builtin
(OPERATOR) @operator
"#" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"." @punctuation.delimiter
"..." @operator
":=" @operator
";" @punctuation.delimiter
"<-" @operator
"=" @operator
"=>" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"}" @punctuation.bracket
(shape_pattern_field) @variable.other.member
(field_suffix) @variable.other.member
(field_name) @variable.other.member
(shape_member) @variable.other.member
(shape_field) @variable.other.member
(COMMENT) @comment
(field_suffix field: (field_name) @variable.other.member)
(fixity_declaration target: (qualified_name) @variable)
(shape_field name: (field_name) @variable.other.member)
(shape_pattern_field name: (field_name) @variable.other.member)
