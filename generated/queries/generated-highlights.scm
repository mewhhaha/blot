(IDENT) @variable
(TYPE_IDENT) @variable
(INTEGER) @number
(FLOAT) @number
(TEXT) @string
(INTRINSIC) @function.builtin
(OPERATOR) @operator
(ANGLE_LEFT) @operator
(ANGLE_RIGHT) @operator
(QUESTION) @operator
(COMMENT) @comment
(ELSE_IF) @keyword
(module_header "module" @keyword)
(module_header "with" @keyword)
(fixity_declaration "infix" @keyword)
(fixity_declaration "infixl" @keyword)
(fixity_declaration "infixr" @keyword)
(fixity_declaration "prefix" @keyword)
(binding "const" @keyword)
(binding "let" @keyword)
(binding "rec" @keyword)
(signature "const" @keyword)
(signature "let" @keyword)
(signature "rec" @keyword)
(lambda_parameter "fn" @keyword)
(result "return" @keyword)
(sequencing "use" @keyword)
(opening "open" @keyword)
(iteration "for" @keyword)
(iteration "case" @keyword)
(iteration_source "in" @keyword)
(breaking "break" @keyword)
(continuing "continue" @keyword)
(import_expression "import" @keyword)
(import_expression "with" @keyword)
(conditional_statement "if" @keyword)
(conditional_statement_guard "let" @keyword)
(conditional_statement_guard "else" @keyword)
(conditional_statement_else_clause "else" @keyword)
(case_expression "case" @keyword)
(case_expression "of" @keyword)
(case_guard "if" @keyword)
(do_block "do" @keyword)
(field_name) @variable.other.member
(binding pattern: (binding_pattern value: (pattern_core [(IDENT) (TYPE_IDENT)] @function)) value: (value (lambda)))
"#" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"." @punctuation.delimiter
".." @operator
"..." @operator
":" @punctuation.delimiter
"::" @operator
":=" @operator
";" @punctuation.delimiter
"<-" @operator
"=" @operator
"=>" @operator
"@" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"}" @punctuation.bracket
