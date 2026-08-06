import { createParserAsync, type Token } from "../../generated/wasm/mod.ts";
import type { Diagnostic } from "../diagnostic.ts";

const layoutNewline = "\u{e000}";
const layoutIndent = "\u{e001}";
const layoutDedent = "\u{e002}";
const layoutMarkers = new Set([layoutNewline, layoutIndent, layoutDedent]);

const parserWasmUrl = new URL(
  "../../generated/wasm/parser.wasm",
  import.meta.url,
);
const parserPlanUrl = new URL(
  "../../generated/wasm/parser.plan",
  import.meta.url,
);

let sharedLexer: ReturnType<typeof createParserAsync> | null = null;

export interface LayoutSource {
  readonly source: string;
  originalOffset(offset: number): number;
}

export type LayoutResult =
  | { readonly ok: true; readonly layout: LayoutSource }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

interface SourceInsertion {
  readonly offset: number;
  readonly text: string;
}

interface Delimiters {
  brackets: number;
  readonly elementHeads: ("open" | "close")[];
}

interface LayoutFrame {
  readonly indent: number;
  readonly closeIndent: number;
  readonly brackets: number;
  readonly elementHeads: number;
}

export async function elaborateLayout(source: string): Promise<LayoutResult> {
  for (const marker of layoutMarkers) {
    const offset = source.indexOf(marker);
    if (offset >= 0) {
      return {
        ok: false,
        diagnostics: [{
          code: "BLOT_RESERVED_LAYOUT_CHARACTER",
          message:
            "Source contains a character reserved for layout elaboration.",
          span: { start: offset, end: offset + marker.length },
        }],
      };
    }
  }

  const lexer = await layoutLexer();
  const lexed = lexer.lex(source, { preserveTrivia: true });
  if (lexed.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: lexed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        span: diagnostic.span,
      })),
    };
  }

  const tokens: Token[] = [];
  for (let index = 0; index < lexed.tokenTape.length; index += 1) {
    const token = lexed.tokenTape.token(index);
    if (token === undefined) {
      throw new Error(`Baba omitted layout token ${index}.`);
    }
    if (token.channel === "main" && token.type !== "eof") tokens.push(token);
  }
  if (tokens.length === 0) return { ok: true, layout: identityLayout(source) };

  const insertions: SourceInsertion[] = [];
  const frames: LayoutFrame[] = [{
    indent: 0,
    closeIndent: 0,
    brackets: 0,
    elementHeads: 0,
  }];
  const delimiters: Delimiters = { brackets: 0, elementHeads: [] };
  const elementSuiteIntroducers = new Set<number>();
  let previous = tokens[0];
  updateDelimiters(
    delimiters,
    previous,
    undefined,
    elementSuiteIntroducers,
  );

  for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token === undefined) {
      throw new Error(`Layout token ${tokenIndex} vanished.`);
    }
    const gap = source.slice(previous.span.end, token.span.start);
    const newline = lastNewlineEnd(gap);
    const suiteIntroducer = opensSuite(previous, elementSuiteIntroducers) ||
      opensParenthesizedSuite(previous, token, tokens[tokenIndex + 1]);
    const frame = frames[frames.length - 1];
    const insideActiveSuite = frames.length > 1 &&
      delimiters.brackets === frame.brackets &&
      delimiters.elementHeads.length === frame.elementHeads;
    const layoutActive = insideActiveSuite ||
      (delimiters.brackets === 0 && delimiters.elementHeads.length === 0) ||
      suiteIntroducer;
    if (newline >= 0 && layoutActive) {
      const lineStart = previous.span.end + newline;
      const indentText = source.slice(lineStart, token.span.start);
      const indent = indentationWidth(indentText);
      const current = frame.indent;
      const closesDelimiter = token.type === "literal" &&
          (token.literal === ")" || token.literal === "]" ||
            token.literal === "}") ||
        token.type === "named" && token.kind === "ANGLE_CLOSE";
      let markers = layoutNewline;
      if (indent > current) {
        if (!suiteIntroducer) {
          updateDelimiters(
            delimiters,
            token,
            previous,
            elementSuiteIntroducers,
          );
          previous = token;
          continue;
        }
        frames.push({
          indent,
          closeIndent: sourceIndentWidth(source, previous.span.start),
          brackets: delimiters.brackets,
          elementHeads: delimiters.elementHeads.length,
        });
        markers += layoutIndent;
      } else if (indent < current) {
        let structuralIndent: number | null = null;
        let closedSuites = 0;
        while (indent < frames[frames.length - 1].indent && frames.length > 1) {
          const closed = frames.pop();
          if (closed === undefined) throw new Error("A layout frame vanished.");
          structuralIndent = closed.closeIndent;
          if (closedSuites > 0) markers += layoutNewline;
          markers += layoutDedent;
          closedSuites += 1;
        }
        if (
          indent !== frames[frames.length - 1].indent &&
          indent !== structuralIndent && !closesDelimiter
        ) {
          return {
            ok: false,
            diagnostics: [{
              code: "BLOT_INCONSISTENT_INDENT",
              message:
                `Indentation width ${indent} does not match active suite widths ${
                  frames.map((active) => active.indent).join(", ")
                } or structural width ${String(structuralIndent)}.`,
              span: { start: lineStart, end: token.span.start },
            }],
          };
        }
        if (!closesLayoutExpression(token)) {
          markers += layoutNewline;
        }
      }
      insertions.push({ offset: token.span.start, text: markers });
    }
    updateDelimiters(
      delimiters,
      token,
      previous,
      elementSuiteIntroducers,
    );
    previous = token;
  }

  let closing = layoutNewline;
  while (frames.length > 1) {
    frames.pop();
    closing += layoutDedent + layoutNewline;
  }
  insertions.push({ offset: previous.span.end, text: closing });
  return { ok: true, layout: applyInsertions(source, insertions) };
}

function closesLayoutExpression(token: Token): boolean {
  if (token.type === "literal") {
    return token.literal === ";" || token.literal === ")" ||
      token.literal === "]" || token.literal === "}" ||
      token.literal === "," || token.literal === "else";
  }
  if (token.type !== "named") return false;
  return token.kind === "ELSE_IF" || token.kind === "ANGLE_CLOSE";
}

export function isLayoutMarker(text: string): boolean {
  return layoutMarkers.has(text);
}

async function layoutLexer() {
  if (sharedLexer === null) {
    sharedLexer = createParserAsync({
      url: parserWasmUrl,
      planUrl: parserPlanUrl,
    });
  }
  return await sharedLexer;
}

function identityLayout(source: string): LayoutSource {
  return { source, originalOffset: (offset) => offset };
}

function applyInsertions(
  source: string,
  insertions: readonly SourceInsertion[],
): LayoutSource {
  const chunks: string[] = [];
  const originalOffsets: number[] = [0];
  let cursor = 0;
  for (const insertion of insertions) {
    if (insertion.offset < cursor) {
      throw new Error(
        `Layout insertions are not ordered at ${insertion.offset}.`,
      );
    }
    appendOriginal(
      source.slice(cursor, insertion.offset),
      cursor,
      chunks,
      originalOffsets,
    );
    chunks.push(insertion.text);
    for (let index = 0; index < insertion.text.length; index += 1) {
      originalOffsets.push(insertion.offset);
    }
    cursor = insertion.offset;
  }
  appendOriginal(source.slice(cursor), cursor, chunks, originalOffsets);
  const elaborated = chunks.join("");
  if (originalOffsets.length !== elaborated.length + 1) {
    throw new Error(
      `Layout source has ${elaborated.length} units but ${originalOffsets.length} mapped offsets.`,
    );
  }
  return {
    source: elaborated,
    originalOffset(offset: number): number {
      const mapped = originalOffsets[offset];
      if (mapped === undefined) {
        throw new Error(
          `Layout offset ${offset} is outside the elaborated source.`,
        );
      }
      return mapped;
    },
  };
}

function appendOriginal(
  text: string,
  originalStart: number,
  chunks: string[],
  offsets: number[],
): void {
  chunks.push(text);
  for (let index = 0; index < text.length; index += 1) {
    offsets.push(originalStart + index + 1);
  }
}

function lastNewlineEnd(text: string): number {
  const newline = text.lastIndexOf("\n");
  if (newline >= 0) return newline + 1;
  const carriageReturn = text.lastIndexOf("\r");
  if (carriageReturn >= 0) return carriageReturn + 1;
  return -1;
}

function indentationWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (character === " ") {
      width += 1;
      continue;
    }
    if (character === "\t") {
      width += 8 - (width % 8);
      continue;
    }
    if (character === "\r" || character === "\n") continue;
    throw new Error(`Baba left non-trivia text in indentation: ${text}.`);
  }
  return width;
}

function sourceIndentWidth(source: string, offset: number): number {
  const newline = Math.max(
    source.lastIndexOf("\n", offset - 1),
    source.lastIndexOf("\r", offset - 1),
  );
  const beforeToken = source.slice(newline + 1, offset);
  const indentation = beforeToken.match(/^[ \t]*/)?.[0];
  if (indentation === undefined) throw new Error("A source line has no start.");
  return indentationWidth(indentation);
}

function opensSuite(
  token: Token,
  elementSuiteIntroducers: ReadonlySet<number>,
): boolean {
  if (token.type === "literal") {
    return token.literal === "=" || token.literal === "=>" ||
      token.literal === "<-" ||
      token.literal === "of" || token.literal === "with" ||
      token.literal === ":";
  }
  if (token.type !== "named") return false;
  if (
    token.kind === "ANGLE_RIGHT" &&
    elementSuiteIntroducers.has(token.span.start)
  ) return true;
  return token.kind === "OPERATOR" && token.text === ":";
}

function opensParenthesizedSuite(
  previous: Token,
  first: Token,
  second: Token | undefined,
): boolean {
  if (previous.type !== "literal" || previous.literal !== "(") return false;
  if (first.type === "literal") {
    return first.literal === "let" || first.literal === "const" ||
      first.literal === "sig" || first.literal === "return" ||
      first.literal === "for" || first.literal === "break" ||
      first.literal === "open";
  }
  if (first.type !== "named" || second?.type !== "literal") return false;
  if (first.kind !== "IDENT" && first.kind !== "TYPE_IDENT") return false;
  return second.literal === "<-" || second.literal === ":=";
}

function updateDelimiters(
  delimiters: Delimiters,
  token: Token,
  previous: Token | undefined,
  elementSuiteIntroducers: Set<number>,
): void {
  if (token.type === "literal") {
    if (
      token.literal === "(" || token.literal === "[" || token.literal === "{"
    ) {
      delimiters.brackets += 1;
      return;
    }
    if (
      token.literal === ")" || token.literal === "]" || token.literal === "}"
    ) {
      delimiters.brackets -= 1;
      if (delimiters.brackets < 0) delimiters.brackets = 0;
    }
    return;
  }
  if (token.type !== "named") return;
  if (token.kind === "ANGLE_LEFT" && beginsElement(previous)) {
    delimiters.elementHeads.push("open");
    return;
  }
  if (token.kind === "ANGLE_CLOSE") {
    delimiters.elementHeads.push("close");
    return;
  }
  if (
    token.kind === "ANGLE_RIGHT" || token.kind === "ANGLE_SELF_CLOSE"
  ) {
    const head = delimiters.elementHeads.pop();
    if (head === "open" && token.kind === "ANGLE_RIGHT") {
      elementSuiteIntroducers.add(token.span.start);
    }
  }
}

function beginsElement(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.type === "literal") {
    return previous.literal === "=" || previous.literal === "=>" ||
      previous.literal === "<-" || previous.literal === "(" ||
      previous.literal === "[" || previous.literal === "{" ||
      previous.literal === ",";
  }
  if (previous.type !== "named") return false;
  return previous.kind === "OPERATOR";
}
