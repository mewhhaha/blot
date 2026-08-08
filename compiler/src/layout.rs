use std::collections::HashSet;

use crate::ast::Span;
use crate::cst::NAMED_TOKEN_KINDS;
use crate::diagnostic::Diagnostic;
use crate::frontend::{Token, lex_source};

const LAYOUT_NEWLINE: u16 = 0xe000;
const LAYOUT_INDENT: u16 = 0xe001;
const LAYOUT_DEDENT: u16 = 0xe002;

#[derive(Clone)]
pub(crate) struct LayoutSource {
    pub(crate) source: Vec<u16>,
    pub(crate) original_offsets: Vec<u32>,
}

impl LayoutSource {
    pub(crate) fn map_diagnostics(&self, diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
        diagnostics
            .into_iter()
            .map(|diagnostic| Diagnostic {
                code: diagnostic.code,
                message: diagnostic.message,
                span: self.map_span(diagnostic.span),
                origin: diagnostic.origin,
            })
            .collect()
    }

    fn map_span(&self, span: Span) -> Span {
        let start = self
            .original_offsets
            .get(span.start as usize)
            .copied()
            .unwrap_or(span.start);
        let end = self
            .original_offsets
            .get(span.end as usize)
            .copied()
            .unwrap_or(span.end);
        Span { start, end }
    }
}

#[derive(Clone, Copy)]
struct LayoutFrame {
    indent: usize,
    close_indent: usize,
    brackets: usize,
    element_heads: usize,
}

#[derive(Default)]
struct Delimiters {
    brackets: usize,
    element_heads: Vec<ElementHead>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ElementHead {
    Open,
    Close,
}

pub(crate) fn elaborate(source: &[u16]) -> Result<LayoutSource, Vec<Diagnostic>> {
    for marker in [LAYOUT_NEWLINE, LAYOUT_INDENT, LAYOUT_DEDENT] {
        if let Some(offset) = source.iter().position(|unit| *unit == marker) {
            return Err(vec![Diagnostic::new(
                "BLOT_RESERVED_LAYOUT_CHARACTER",
                "Source contains a character reserved for layout elaboration.",
                Span {
                    start: offset as u32,
                    end: (offset + 1) as u32,
                },
            )]);
        }
    }

    let all_tokens = lex_source(source)?;
    let tokens = all_tokens
        .iter()
        .filter(|token| token.terminal >= 0)
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Ok(identity(source));
    }

    let mut insertions: Vec<(usize, Vec<u16>)> = Vec::new();
    let mut frames = vec![LayoutFrame {
        indent: 0,
        close_indent: 0,
        brackets: 0,
        element_heads: 0,
    }];
    let mut delimiters = Delimiters::default();
    let mut element_suite_introducers = HashSet::new();
    let mut previous = tokens[0];
    update_delimiters(
        source,
        &mut delimiters,
        previous,
        None,
        &mut element_suite_introducers,
        true,
    );

    for token in tokens.iter().skip(1) {
        let gap = &source[previous.end..token.start];
        let newline = last_newline_end(gap);
        let suite_introducer = opens_suite(source, previous, &element_suite_introducers);
        let frame = *frames.last().expect("layout always has a root frame");
        let inside_active_suite = frames.len() > 1
            && delimiters.brackets == frame.brackets
            && delimiters.element_heads.len() == frame.element_heads;
        let layout_active = inside_active_suite
            || (delimiters.brackets == 0 && delimiters.element_heads.is_empty())
            || suite_introducer;

        if let Some(newline) = newline
            && layout_active
        {
            let line_start = previous.end + newline;
            let indent = indentation_width(&source[line_start..token.start])
                .expect("Baba left non-trivia text in indentation");
            let current = frame.indent;
            let closes_delimiter = is_text(source, token, ")")
                || is_text(source, token, "]")
                || is_text(source, token, "}")
                || kind(token) == Some("ANGLE_CLOSE");
            let mut markers = vec![LAYOUT_NEWLINE];
            if indent > current {
                if !suite_introducer {
                    update_delimiters(
                        source,
                        &mut delimiters,
                        token,
                        Some(previous),
                        &mut element_suite_introducers,
                        true,
                    );
                    previous = token;
                    continue;
                }
                frames.push(LayoutFrame {
                    indent,
                    close_indent: source_indent_width(source, previous.start),
                    brackets: delimiters.brackets,
                    element_heads: delimiters.element_heads.len(),
                });
                markers.push(LAYOUT_INDENT);
            } else if indent < current {
                let mut structural_indent = None;
                let mut closed_suites = 0;
                while frames.len() > 1 && indent < frames.last().expect("layout frame").indent {
                    let closed = frames.pop().expect("layout frame vanished");
                    structural_indent = Some(closed.close_indent);
                    if closed_suites > 0 {
                        markers.push(LAYOUT_NEWLINE);
                    }
                    markers.push(LAYOUT_DEDENT);
                    closed_suites += 1;
                }
                let active_indent = frames.last().expect("layout root").indent;
                if indent != active_indent && Some(indent) != structural_indent && !closes_delimiter
                {
                    let widths = frames
                        .iter()
                        .map(|active| active.indent.to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(vec![Diagnostic::new(
                        "BLOT_INCONSISTENT_INDENT",
                        format!(
                            "Indentation width {indent} does not match active suite widths {widths} or structural width {}.",
                            structural_indent
                                .map(|width| width.to_string())
                                .unwrap_or_else(|| "none".to_owned())
                        ),
                        Span {
                            start: line_start as u32,
                            end: token.start as u32,
                        },
                    )]);
                }
                if !closes_layout_expression(source, token) {
                    markers.push(LAYOUT_NEWLINE);
                }
            }
            insertions.push((token.start, markers));
        }

        update_delimiters(
            source,
            &mut delimiters,
            token,
            Some(previous),
            &mut element_suite_introducers,
            newline.is_some(),
        );
        previous = token;
    }

    let mut closing = vec![LAYOUT_NEWLINE];
    while frames.len() > 1 {
        frames.pop();
        closing.push(LAYOUT_DEDENT);
        closing.push(LAYOUT_NEWLINE);
    }
    insertions.push((previous.end, closing));
    Ok(apply_insertions(source, &insertions))
}

fn identity(source: &[u16]) -> LayoutSource {
    LayoutSource {
        source: source.to_vec(),
        original_offsets: (0..=source.len()).map(|offset| offset as u32).collect(),
    }
}

fn apply_insertions(source: &[u16], insertions: &[(usize, Vec<u16>)]) -> LayoutSource {
    let inserted = insertions.iter().map(|(_, text)| text.len()).sum::<usize>();
    let mut elaborated = Vec::with_capacity(source.len() + inserted);
    let mut original_offsets = Vec::with_capacity(source.len() + inserted + 1);
    original_offsets.push(0);
    let mut cursor = 0;
    for (offset, text) in insertions {
        assert!(*offset >= cursor, "layout insertions are not ordered");
        for (index, unit) in source[cursor..*offset].iter().enumerate() {
            elaborated.push(*unit);
            original_offsets.push((cursor + index + 1) as u32);
        }
        for unit in text {
            elaborated.push(*unit);
            original_offsets.push(*offset as u32);
        }
        cursor = *offset;
    }
    for (index, unit) in source[cursor..].iter().enumerate() {
        elaborated.push(*unit);
        original_offsets.push((cursor + index + 1) as u32);
    }
    assert_eq!(original_offsets.len(), elaborated.len() + 1);
    LayoutSource {
        source: elaborated,
        original_offsets,
    }
}

fn last_newline_end(text: &[u16]) -> Option<usize> {
    if let Some(index) = text.iter().rposition(|unit| *unit == b'\n' as u16) {
        return Some(index + 1);
    }
    text.iter()
        .rposition(|unit| *unit == b'\r' as u16)
        .map(|index| index + 1)
}

fn indentation_width(text: &[u16]) -> Result<usize, ()> {
    let mut width = 0;
    for unit in text {
        match *unit {
            value if value == b' ' as u16 => width += 1,
            value if value == b'\t' as u16 => width += 8 - (width % 8),
            value if value == b'\r' as u16 || value == b'\n' as u16 => {}
            _ => return Err(()),
        }
    }
    Ok(width)
}

fn source_indent_width(source: &[u16], offset: usize) -> usize {
    let start = source[..offset]
        .iter()
        .rposition(|unit| *unit == b'\n' as u16 || *unit == b'\r' as u16)
        .map_or(0, |index| index + 1);
    let end = source[start..offset]
        .iter()
        .position(|unit| *unit != b' ' as u16 && *unit != b'\t' as u16)
        .map_or(offset, |index| start + index);
    indentation_width(&source[start..end]).expect("line indentation is whitespace")
}

fn opens_suite(source: &[u16], token: &Token, element_suites: &HashSet<usize>) -> bool {
    if ["=", "=>", "<-", "of", "with", ":"]
        .iter()
        .any(|text| is_text(source, token, text))
    {
        return true;
    }
    if kind(token) == Some("ANGLE_RIGHT") && element_suites.contains(&token.start) {
        return true;
    }
    kind(token) == Some("OPERATOR") && is_text(source, token, ":")
}

fn closes_layout_expression(source: &[u16], token: &Token) -> bool {
    if [";", ")", "]", "}", ",", "else"]
        .iter()
        .any(|text| is_text(source, token, text))
    {
        return true;
    }
    matches!(kind(token), Some("ELSE_IF" | "ANGLE_CLOSE"))
}

fn update_delimiters(
    source: &[u16],
    delimiters: &mut Delimiters,
    token: &Token,
    previous: Option<&Token>,
    element_suites: &mut HashSet<usize>,
    starts_line: bool,
) {
    if ["(", "[", "{"]
        .iter()
        .any(|text| is_text(source, token, text))
    {
        delimiters.brackets += 1;
        return;
    }
    if [")", "]", "}"]
        .iter()
        .any(|text| is_text(source, token, text))
    {
        delimiters.brackets = delimiters.brackets.saturating_sub(1);
        return;
    }
    if kind(token) == Some("ANGLE_LEFT") && begins_element(source, previous, starts_line) {
        delimiters.element_heads.push(ElementHead::Open);
        return;
    }
    if kind(token) == Some("ANGLE_CLOSE") {
        delimiters.element_heads.push(ElementHead::Close);
        return;
    }
    if matches!(kind(token), Some("ANGLE_RIGHT" | "ANGLE_SELF_CLOSE")) {
        let head = delimiters.element_heads.pop();
        if head == Some(ElementHead::Open) && kind(token) == Some("ANGLE_RIGHT") {
            element_suites.insert(token.start);
        }
    }
}

fn begins_element(source: &[u16], previous: Option<&Token>, starts_line: bool) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if starts_line {
        return true;
    }
    if ["=", "=>", "<-", "(", "[", "{", ","]
        .iter()
        .any(|text| is_text(source, previous, text))
    {
        return true;
    }
    matches!(
        kind(previous),
        Some("OPERATOR" | "ANGLE_RIGHT" | "ANGLE_SELF_CLOSE")
    )
}

fn kind(token: &Token) -> Option<&'static str> {
    usize::try_from(token.lexical_identity)
        .ok()
        .and_then(|identity| NAMED_TOKEN_KINDS.get(identity).copied())
}

fn is_text(source: &[u16], token: &Token, expected: &str) -> bool {
    let expected = expected.encode_utf16().collect::<Vec<_>>();
    source
        .get(token.start..token.end)
        .is_some_and(|text| text == expected)
}
