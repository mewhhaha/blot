#include "tree_sitter/parser.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  LAYOUT_NEWLINE,
  LAYOUT_INDENT,
  LAYOUT_DEDENT,
};

typedef struct {
  uint16_t indents[64];
  uint8_t count;
} Scanner;

static void skip(TSLexer *lexer) {
  lexer->advance(lexer, true);
}

// A block and an ordinary continued value can both follow a physical newline.
// The compiler resolves that boundary from the preceding suite introducer;
// Tree-sitter exposes only the tokens valid after the newline. Looking for a
// statement, handler step, or case-arm arrow keeps multiline tuple values as
// whitespace without hiding a real layout boundary.
static bool starts_layout_entry(TSLexer *lexer) {
  if (lexer->lookahead == '<') return true;

  bool parenthesized_lambda = false;
  if (lexer->lookahead == '(') {
    lexer->advance(lexer, false);
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      lexer->advance(lexer, false);
    }
    if (lexer->lookahead == 'f') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == 'n') {
        lexer->advance(lexer, false);
        parenthesized_lambda = lexer->lookahead == ' ' ||
          lexer->lookahead == '\t';
      }
    }
  }

  char word[16] = {0};
  unsigned length = 0;
  while (
    (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
    (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
    (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
    lexer->lookahead == '_'
  ) {
    if (length + 1 < sizeof(word)) word[length++] = lexer->lookahead;
    lexer->advance(lexer, false);
  }

  const bool statement_keyword = strcmp(word, "let") == 0 ||
    strcmp(word, "const") == 0 || strcmp(word, "sig") == 0 ||
    strcmp(word, "return") == 0 || strcmp(word, "for") == 0 ||
    strcmp(word, "break") == 0 || strcmp(word, "open") == 0 ||
    strcmp(word, "if") == 0;
  if (statement_keyword) return true;

  const bool lambda = parenthesized_lambda || strcmp(word, "fn") == 0;
  bool quoted = false;
  bool escaped = false;
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    const int32_t current = lexer->lookahead;
    lexer->advance(lexer, false);
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (current == '\\') {
        escaped = true;
      } else if (current == '"') {
        quoted = false;
      }
      continue;
    }
    if (current == '"') {
      quoted = true;
      continue;
    }
    if (
      (current == '<' && lexer->lookahead == '-') ||
      (current == ':' && lexer->lookahead == '=') ||
      (!lambda && current == '=' && lexer->lookahead == '>')
    ) {
      return true;
    }
  }
  return false;
}

void *tree_sitter_blot_external_scanner_create(void) {
  Scanner *scanner = calloc(1, sizeof(Scanner));
  scanner->count = 1;
  return scanner;
}

void tree_sitter_blot_external_scanner_destroy(void *payload) {
  free(payload);
}

unsigned tree_sitter_blot_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  Scanner *scanner = payload;
  const unsigned size = 1 + scanner->count * sizeof(uint16_t);
  if (size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) return 0;
  buffer[0] = (char)scanner->count;
  memcpy(buffer + 1, scanner->indents, scanner->count * sizeof(uint16_t));
  return size;
}

void tree_sitter_blot_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  scanner->count = 1;
  scanner->indents[0] = 0;
  if (length < 1) return;
  const uint8_t count = (uint8_t)buffer[0];
  if (count == 0 || count > 64 || length != 1 + count * sizeof(uint16_t)) {
    return;
  }
  scanner->count = count;
  memcpy(scanner->indents, buffer + 1, count * sizeof(uint16_t));
}

bool tree_sitter_blot_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  Scanner *scanner = payload;
  lexer->mark_end(lexer);

  bool found_newline = false;
  uint16_t indent = 0;
  for (;;) {
    if (lexer->lookahead == '\n') {
      found_newline = true;
      indent = 0;
      skip(lexer);
      continue;
    }
    if (lexer->lookahead == '\r' || lexer->lookahead == '\f') {
      skip(lexer);
      continue;
    }
    if (lexer->lookahead == ' ') {
      indent += 1;
      skip(lexer);
      continue;
    }
    if (lexer->lookahead == '\t') {
      indent += 8;
      skip(lexer);
      continue;
    }
    if (found_newline && lexer->lookahead == '/') {
      skip(lexer);
      if (lexer->lookahead != '/') return false;
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') skip(lexer);
      indent = 0;
      continue;
    }
    break;
  }

  if (!found_newline && !lexer->eof(lexer)) return false;
  const uint16_t current = scanner->indents[scanner->count - 1];
  if (
    indent > current &&
    (lexer->lookahead == '.' || lexer->lookahead == '}')
  ) {
    return false;
  }
  const bool closes_delimiter = lexer->lookahead == '}' ||
    lexer->lookahead == ']' || lexer->lookahead == ')' ||
    (lexer->lookahead == '<' && indent < current);
  if (
    valid_symbols[LAYOUT_DEDENT] && scanner->count > 1 && closes_delimiter
  ) {
    scanner->count -= 1;
    lexer->result_symbol = LAYOUT_DEDENT;
    return true;
  }
  const unsigned valid_layout_tokens = valid_symbols[LAYOUT_NEWLINE] +
    valid_symbols[LAYOUT_INDENT] + valid_symbols[LAYOUT_DEDENT];
  if (valid_layout_tokens != 1) return false;
  if (
    valid_symbols[LAYOUT_NEWLINE] && indent > current &&
    !starts_layout_entry(lexer)
  ) {
    return false;
  }
  if (valid_symbols[LAYOUT_INDENT] && indent > current) {
    if (scanner->count == 64) return false;
    scanner->indents[scanner->count++] = indent;
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_INDENT;
    return true;
  }
  if (
    valid_symbols[LAYOUT_DEDENT] &&
    indent < current
  ) {
    scanner->count -= 1;
    lexer->result_symbol = LAYOUT_DEDENT;
    return true;
  }
  if (valid_symbols[LAYOUT_NEWLINE]) {
    lexer->result_symbol = LAYOUT_NEWLINE;
    return true;
  }
  return false;
}
