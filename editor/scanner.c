#include "tree_sitter/parser.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  LAYOUT_NEWLINE,
  LAYOUT_INDENT,
  LAYOUT_DEDENT,
  RECORD_OPEN,
  RECORD_CLOSE,
  RECORD_SEPARATOR,
};

typedef struct {
  uint16_t indents[64];
  uint16_t record_indents[64];
  uint8_t count;
  uint8_t record_count;
} Scanner;

static void skip(TSLexer *lexer) {
  lexer->advance(lexer, true);
}

// Peek after an opening brace without extending its token. Only a first field
// on its own line establishes an indentation for implicit field separators.
static uint16_t record_indent(TSLexer *lexer) {
  bool found_newline = false;
  uint16_t indent = 0;
  for (;;) {
    if (lexer->lookahead == '\n') {
      found_newline = true;
      indent = 0;
    } else if (lexer->lookahead == ' ') {
      indent += 1;
    } else if (lexer->lookahead == '\t') {
      indent += 8 - indent % 8;
    } else if (lexer->lookahead == '/') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '/') return UINT16_MAX;
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
        lexer->advance(lexer, false);
      }
      continue;
    } else if (lexer->lookahead != '\r') {
      if (found_newline && lexer->lookahead == '.') return indent;
      return UINT16_MAX;
    }
    lexer->advance(lexer, false);
  }
}

// A block and an ordinary continued value can both follow a physical newline.
// The compiler resolves that boundary from the preceding suite introducer;
// Tree-sitter exposes only the tokens valid after the newline. Looking for a
// statement, handler step, or case-arm arrow keeps multiline tuple values as
// whitespace without hiding a real layout boundary.
static bool starts_layout_entry(TSLexer *lexer) {
  if (lexer->lookahead == '<') return true;
  if (lexer->lookahead == '@') {
    lexer->advance(lexer, false);
    return lexer->lookahead == '[';
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
    strcmp(word, "const") == 0 ||
    strcmp(word, "return") == 0 || strcmp(word, "use") == 0 ||
    strcmp(word, "for") == 0 ||
    strcmp(word, "break") == 0 || strcmp(word, "continue") == 0 ||
    strcmp(word, "open") == 0 ||
    strcmp(word, "if") == 0;
  if (statement_keyword) return true;

  const bool lambda = strcmp(word, "fn") == 0;
  unsigned delimiters = 0;
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
    if (current == '(' || current == '[' || current == '{') {
      delimiters += 1;
      continue;
    }
    if (current == ')' || current == ']' || current == '}') {
      if (delimiters == 0) return false;
      delimiters -= 1;
      continue;
    }
    if (delimiters > 0) continue;
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
  const unsigned indent_size = scanner->count * sizeof(uint16_t);
  const unsigned record_size = scanner->record_count * sizeof(uint16_t);
  const unsigned size = 2 + indent_size + record_size;
  if (size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) return 0;
  buffer[0] = (char)scanner->count;
  buffer[1] = (char)scanner->record_count;
  memcpy(buffer + 2, scanner->indents, indent_size);
  memcpy(buffer + 2 + indent_size, scanner->record_indents, record_size);
  return size;
}

void tree_sitter_blot_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  memset(scanner, 0, sizeof(Scanner));
  scanner->count = 1;
  if (length < 2) return;
  const uint8_t count = (uint8_t)buffer[0];
  const uint8_t record_count = (uint8_t)buffer[1];
  const unsigned indent_size = count * sizeof(uint16_t);
  const unsigned record_size = record_count * sizeof(uint16_t);
  if (
    count == 0 || count > 64 || record_count > 64 ||
    length != 2 + indent_size + record_size
  ) {
    return;
  }
  scanner->count = count;
  scanner->record_count = record_count;
  memcpy(scanner->indents, buffer + 2, indent_size);
  memcpy(scanner->record_indents, buffer + 2 + indent_size, record_size);
}

bool tree_sitter_blot_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  Scanner *scanner = payload;
  // Tree-sitter enables every external token during error recovery.
  if (
    valid_symbols[LAYOUT_NEWLINE] && valid_symbols[LAYOUT_INDENT] &&
    valid_symbols[LAYOUT_DEDENT]
  ) return false;
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
      indent += 8 - indent % 8;
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

  if (valid_symbols[RECORD_OPEN] && lexer->lookahead == '{') {
    if (scanner->record_count == 64) return false;
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    scanner->record_indents[scanner->record_count++] = record_indent(lexer);
    lexer->result_symbol = RECORD_OPEN;
    return true;
  }
  if (valid_symbols[RECORD_SEPARATOR] && lexer->lookahead == ';') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = RECORD_SEPARATOR;
    return true;
  }
  const uint16_t current = scanner->indents[scanner->count - 1];
  const bool closes_delimiter = lexer->lookahead == '}' ||
    lexer->lookahead == ']' || lexer->lookahead == ')' ||
    (lexer->lookahead == '<' && indent < current);
  if (
    found_newline && valid_symbols[LAYOUT_DEDENT] && scanner->count > 1 &&
    closes_delimiter && indent <= current
  ) {
    scanner->count -= 1;
    lexer->result_symbol = LAYOUT_DEDENT;
    return true;
  }
  if (
    found_newline && valid_symbols[RECORD_SEPARATOR] &&
    scanner->record_count > 0 &&
    (lexer->lookahead == '}' ||
      (lexer->lookahead == '.' &&
        indent == scanner->record_indents[scanner->record_count - 1]))
  ) {
    lexer->result_symbol = RECORD_SEPARATOR;
    return true;
  }
  if (valid_symbols[RECORD_CLOSE] && lexer->lookahead == '}') {
    if (scanner->record_count == 0) return false;
    scanner->record_count -= 1;
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = RECORD_CLOSE;
    return true;
  }
  if (!found_newline && !lexer->eof(lexer)) return false;
  if (
    indent > current &&
    (lexer->lookahead == '.' || lexer->lookahead == '}')
  ) return false;
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
