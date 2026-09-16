// src/tooling/format/trivia.ts
//
// Token-tape trivia ownership for the printer.
//
// Baba owns lexing: the snapshot input tape already separates the main
// channel from the trivia channel, and trivia tokens carry their kind
// ("WHITESPACE" or "COMMENT" per generated/wasm/syntax.ts). This module
// attaches each comment to a main-channel token by source position only.
// It never scans source text for comment markers and never inspects
// comment or literal interiors; identity comes from the tape alone.
//
// Attachment rule: a comment on the same source line as the preceding main
// token trails it; otherwise it leads the following main token. Comments
// after the last main token on later lines dangle at the end of the file.

import type { Token } from "../../../generated/wasm/mod.ts";
import type { Span } from "../../syntax/ast.ts";
import { lineAtOffset } from "../../text/document.ts";
import { FormatterInvariantError } from "./errors.ts";

/** A comment token owned by the trivia attachment. */
export interface TapeComment {
  readonly text: string;
  readonly span: Span;
  readonly line: number;
}

/** A main-channel token in tape order. */
export interface TapeMainToken {
  readonly kind: string;
  readonly text: string;
  readonly span: Span;
  readonly line: number;
}

export interface TokenTrivia {
  readonly leading: readonly TapeComment[];
  readonly trailing: readonly TapeComment[];
}

export interface TriviaAttachment {
  /** Main-channel tokens in tape order. */
  readonly mains: readonly TapeMainToken[];
  /** Parallel to `mains`: the trivia each main token owns. */
  readonly trivia: readonly TokenTrivia[];
  /** Every comment on the tape, in order, for accounting tests. */
  readonly comments: readonly TapeComment[];
  /**
   * Own-line comments after the last main token. They trail no token and
   * lead none, so the printer emits them after the final token.
   */
  readonly dangling: readonly TapeComment[];
  /** Tape tokens consumed, excluding the zero-width end sentinel. */
  readonly consumed: number;
  /** End-sentinel count, excluded from ownership by construction. */
  readonly skippedSentinels: number;
}

/**
 * Assigns every comment on the tape to a main token. Whitespace trivia is
 * dropped: the printer computes all gaps from structure. Throws a typed
 * invariant failure on error-channel tokens, which a snapshot's successful
 * parse rules out.
 */
export function attachTrivia(
  lineStarts: readonly number[],
  tokens: readonly Token[],
): TriviaAttachment {
  const mains: TapeMainToken[] = [];
  const trivia: TokenTrivia[] = [];
  const comments: TapeComment[] = [];
  const dangling: TapeComment[] = [];
  const pendingLeading: TapeComment[] = [];
  let consumed = 0;
  let skippedSentinels = 0;

  const pushMain = (token: TapeMainToken): void => {
    mains.push(token);
    trivia.push({ leading: [...pendingLeading], trailing: [] });
    pendingLeading.length = 0;
  };

  for (const token of tokens) {
    if (token.type === "eof") {
      skippedSentinels += 1;
      continue;
    }
    if (token.type === "error") {
      throw new FormatterInvariantError(
        `input tape carries an error token at ${token.span.start}`,
      );
    }
    consumed += 1;
    if (token.channel === "trivia") {
      if (token.kind !== "COMMENT") continue;
      const comment: TapeComment = {
        text: token.text,
        span: { start: token.span.start, end: token.span.end },
        line: lineAtOffset(lineStarts, token.span.start),
      };
      comments.push(comment);
      const previous = mains[mains.length - 1];
      if (previous !== undefined && previous.line === comment.line) {
        const owned = trivia[trivia.length - 1];
        if (owned === undefined) {
          throw new FormatterInvariantError("trivia owner is missing");
        }
        trivia[trivia.length - 1] = {
          leading: owned.leading,
          trailing: [...owned.trailing, comment],
        };
      } else {
        pendingLeading.push(comment);
      }
      continue;
    }
    pushMain(mainOf(token, lineStarts));
  }
  for (const comment of pendingLeading) dangling.push(comment);
  pendingLeading.length = 0;
  return {
    mains,
    trivia,
    comments,
    dangling,
    consumed,
    skippedSentinels,
  };
}

function mainOf(
  token: Extract<Token, { readonly channel: "main" }>,
  lineStarts: readonly number[],
): TapeMainToken {
  let kind = "";
  if (token.type === "named") kind = token.kind;
  if (token.type === "literal") kind = token.literal;
  return {
    kind,
    text: token.text,
    span: { start: token.span.start, end: token.span.end },
    line: lineAtOffset(lineStarts, token.span.start),
  };
}
