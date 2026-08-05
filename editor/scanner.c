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
    lexer->lookahead == ']' || lexer->lookahead == ')';
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
  if (valid_symbols[LAYOUT_INDENT] && indent > current) {
    if (scanner->count == 64) return false;
    scanner->indents[scanner->count++] = indent;
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
