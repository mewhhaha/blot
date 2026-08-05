use std::collections::HashMap;

use crate::ast::Span;
use crate::diagnostic::Diagnostic;

const ASCII_LIMIT: i32 = 128;

struct FrontendPlan {
    root_island: usize,
    terminal_classification: &'static [i32],
    boundaries: &'static [Boundary],
    islands: &'static [Island],
    lexer: Lexer,
}

enum Boundary {
    Root,
    Terminated {
        _terminal: i32,
    },
    Paired {
        open_terminal: i32,
        close_terminal: i32,
    },
    Separated {
        open_terminal: i32,
        close_terminal: i32,
        _separator_terminal: i32,
    },
}

struct Island {
    rule_id: i32,
    start_state: usize,
    states: &'static [IslandState],
}

struct IslandState {
    accepting: bool,
    transitions: &'static [IslandTransition],
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum InputKind {
    Terminal,
    Island,
}

#[derive(Clone)]
struct IslandTransition {
    input_kind: InputKind,
    input: i32,
    target: usize,
    emit: IslandEmit,
}

#[derive(Clone)]
struct IslandEmit {
    field: i32,
}

struct Lexer {
    state_count: usize,
    start_state: usize,
    ascii_transitions: &'static [i32],
    transition_rows: &'static [i32],
    transitions: &'static [i32],
    accept_spec_by_state: &'static [i32],
}

#[derive(Clone)]
struct Token {
    terminal: i32,
    start: usize,
    end: usize,
    lexical_identity: i32,
    output_index: usize,
    dependency_end: usize,
}

struct PendingEdge {
    field: i32,
    token: Option<Token>,
    child: Option<Box<PendingNode>>,
    ordinal: usize,
}

struct PendingNode {
    island: usize,
    start: usize,
    end: usize,
    edges: Vec<PendingEdge>,
    id: usize,
}

struct IslandMatch {
    node: PendingNode,
    next_token: usize,
}

struct IslandProgress {
    farthest_token: usize,
    island: usize,
    state: usize,
}

pub struct CompactProgram {
    pub tokens: Vec<i32>,
    pub nodes: Vec<i32>,
    pub edges: Vec<i32>,
}

pub struct FrontendState {
    source: Vec<u16>,
    tokens: Vec<Token>,
}

pub fn ingest(source: &[u16]) -> Result<CompactProgram, Vec<Diagnostic>> {
    ingest_incremental(source, None).map(|(program, _)| program)
}

pub fn ingest_incremental(
    source: &[u16],
    previous: Option<&FrontendState>,
) -> Result<(CompactProgram, FrontendState), Vec<Diagnostic>> {
    let plan = frontend_plan();
    let (tokens, mut diagnostics) = match previous {
        Some(previous) => lex_incremental(source, previous, plan),
        None => lex_from(source, 0, 0, plan),
    };
    let delimiter_matches = match_delimiters(&tokens, plan.boundaries, &mut diagnostics);
    let root = if diagnostics.is_empty() {
        execute_root_island(&tokens, &delimiter_matches, plan, &mut diagnostics)
    } else {
        None
    };
    diagnostics.sort_by_key(|diagnostic| (diagnostic.span.start, diagnostic.code));
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }
    let Some(root) = root else {
        panic!("frontend produced neither a root node nor a diagnostic");
    };
    let program = materialize(tokens.clone(), root, plan);
    Ok((
        program,
        FrontendState {
            source: source.to_vec(),
            tokens,
        },
    ))
}

fn frontend_plan() -> &'static FrontendPlan {
    &GENERATED_FRONTEND_PLAN
}

fn lex_incremental(
    source: &[u16],
    previous: &FrontendState,
    plan: &FrontendPlan,
) -> (Vec<Token>, Vec<Diagnostic>) {
    if source == previous.source {
        return (previous.tokens.clone(), Vec::new());
    }
    let edit_start = source
        .iter()
        .zip(&previous.source)
        .position(|(current, previous)| current != previous)
        .unwrap_or_else(|| source.len().min(previous.source.len()));
    let prefix_count = previous
        .tokens
        .iter()
        .position(|token| token.dependency_end >= edit_start)
        .unwrap_or(previous.tokens.len());
    let relex_start = previous
        .tokens
        .get(prefix_count)
        .map_or(previous.source.len(), |token| token.start)
        .min(source.len());
    let mut tokens = previous.tokens[..prefix_count].to_vec();
    let (suffix, diagnostics) = lex_from(source, relex_start, prefix_count, plan);
    tokens.extend(suffix);
    (tokens, diagnostics)
}

fn lex_from(
    source: &[u16],
    start: usize,
    output_index: usize,
    plan: &FrontendPlan,
) -> (Vec<Token>, Vec<Diagnostic>) {
    let mut tokens = Vec::new();
    let mut diagnostics = Vec::new();
    let mut position = start;
    while position < source.len() {
        let mut state = plan.lexer.start_state;
        let mut cursor = position;
        let mut accepted_end = None;
        let mut accepted_spec = None;
        let mut dependency_end = position;
        while cursor < source.len() {
            let (code_point, width) = source_code_point(source, cursor);
            dependency_end = cursor + width;
            let Some(target) = lexer_transition(&plan.lexer, state, code_point) else {
                break;
            };
            cursor += width;
            state = target;
            let spec = *plan
                .lexer
                .accept_spec_by_state
                .get(state)
                .expect("generated lexer reached an unknown state");
            if spec >= 0 {
                accepted_end = Some(cursor);
                accepted_spec = Some(spec as usize);
            }
        }
        let (Some(end), Some(spec)) = (accepted_end, accepted_spec) else {
            let (_, width) = source_code_point(source, position);
            diagnostics.push(Diagnostic::new(
                "GPU_FRONTEND_LEXICAL_ERROR",
                format!(
                    "No token matches source span [{position}, {}); first UTF-16 unit is {}.",
                    position + width,
                    source[position]
                ),
                source_span(position, position + width),
            ));
            position += width;
            continue;
        };
        let terminal = *plan
            .terminal_classification
            .get(spec)
            .expect("generated lexer accepted an unknown specification");
        tokens.push(Token {
            terminal,
            start: position,
            end,
            lexical_identity: spec as i32,
            output_index: output_index + tokens.len(),
            dependency_end,
        });
        position = end;
    }
    (tokens, diagnostics)
}

include!("frontend_plan.rs");

fn source_code_point(source: &[u16], position: usize) -> (i32, usize) {
    let first = source[position];
    if (0xd800..=0xdbff).contains(&first) && position + 1 < source.len() {
        let second = source[position + 1];
        if (0xdc00..=0xdfff).contains(&second) {
            let value = 0x10000 + (((first - 0xd800) as i32) << 10) + (second - 0xdc00) as i32;
            return (value, 2);
        }
    }
    (first as i32, 1)
}

fn lexer_transition(lexer: &Lexer, state: usize, code_point: i32) -> Option<usize> {
    assert!(
        state < lexer.state_count,
        "generated lexer reached state {state} outside its state table"
    );
    if (0..ASCII_LIMIT).contains(&code_point) {
        let target = lexer.ascii_transitions[state * ASCII_LIMIT as usize + code_point as usize];
        if target < 0 {
            return None;
        }
        return Some(target as usize);
    }
    let low = lexer.transition_rows[state] as usize;
    let high = lexer.transition_rows[state + 1] as usize;
    for index in low..high {
        let base = index * 3;
        let start = lexer.transitions[base];
        let end = lexer.transitions[base + 1];
        if code_point >= start && code_point <= end {
            let target = lexer.transitions[base + 2];
            if target < 0 {
                return None;
            }
            return Some(target as usize);
        }
    }
    None
}

fn match_delimiters(
    tokens: &[Token],
    boundaries: &[Boundary],
    diagnostics: &mut Vec<Diagnostic>,
) -> HashMap<usize, usize> {
    let mut close_by_open = HashMap::new();
    for boundary in boundaries {
        let terminals = match boundary {
            Boundary::Paired {
                open_terminal,
                close_terminal,
            }
            | Boundary::Separated {
                open_terminal,
                close_terminal,
                ..
            } => Some((*open_terminal, *close_terminal)),
            Boundary::Root | Boundary::Terminated { .. } => None,
        };
        if let Some((open, close)) = terminals
            && let Some(previous) = close_by_open.insert(open, close)
        {
            assert_eq!(
                previous, close,
                "generated frontend opener {open} has conflicting closers"
            );
        }
    }
    let mut open_by_close = HashMap::new();
    for (&open, &close) in &close_by_open {
        if let Some(previous) = open_by_close.insert(close, open) {
            assert_eq!(
                previous, open,
                "generated frontend closer {close} has conflicting openers"
            );
        }
    }
    let mut stack = Vec::new();
    let mut matches = HashMap::new();
    for (index, token) in tokens.iter().enumerate() {
        if token.terminal < 0 {
            continue;
        }
        if let Some(&expected_close) = close_by_open.get(&token.terminal) {
            stack.push((expected_close, index));
            continue;
        }
        if !open_by_close.contains_key(&token.terminal) {
            continue;
        }
        let open = stack.pop();
        if let Some((expected, open_index)) = open {
            if expected == token.terminal {
                matches.insert(open_index, index);
                continue;
            }
            delimiter_diagnostic(token, expected, diagnostics);
            continue;
        }
        delimiter_diagnostic(token, -1, diagnostics);
    }
    for (expected, open_index) in stack {
        let token = &tokens[open_index];
        diagnostics.push(Diagnostic::new(
            "GPU_FRONTEND_MALFORMED_DELIMITER",
            format!(
                "Delimiter at span [{}, {}) expected terminal {expected}, received -1.",
                token.start, token.end
            ),
            source_span(token.start, token.end),
        ));
    }
    matches
}

fn delimiter_diagnostic(token: &Token, expected: i32, diagnostics: &mut Vec<Diagnostic>) {
    diagnostics.push(Diagnostic::new(
        "GPU_FRONTEND_MALFORMED_DELIMITER",
        format!(
            "Delimiter at span [{}, {}) expected terminal {expected}, received {}.",
            token.start, token.end, token.terminal
        ),
        source_span(token.start, token.end),
    ));
}

fn execute_root_island(
    tokens: &[Token],
    delimiter_matches: &HashMap<usize, usize>,
    plan: &FrontendPlan,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<PendingNode> {
    let syntax_tokens = tokens
        .iter()
        .filter(|token| token.terminal >= 0)
        .cloned()
        .collect::<Vec<_>>();
    let syntax_index_by_output = syntax_tokens
        .iter()
        .enumerate()
        .map(|(index, token)| (token.output_index, index))
        .collect::<HashMap<_, _>>();
    let syntax_matches = delimiter_matches
        .iter()
        .filter_map(|(open, close)| {
            let syntax_open = syntax_index_by_output.get(&tokens[*open].output_index)?;
            let syntax_close = syntax_index_by_output.get(&tokens[*close].output_index)?;
            Some((*syntax_open, *syntax_close))
        })
        .collect::<HashMap<_, _>>();
    let mut progress = IslandProgress {
        farthest_token: 0,
        island: plan.root_island,
        state: 0,
    };
    let mut active = Vec::new();
    let root = run_island(
        plan.root_island,
        0,
        syntax_tokens.len(),
        &syntax_tokens,
        &syntax_matches,
        plan,
        &mut active,
        &mut progress,
    );
    if let Some(root) = root {
        if root.next_token == syntax_tokens.len() {
            return Some(root.node);
        }
        let token = &syntax_tokens[root.next_token];
        diagnostics.push(syntax_diagnostic(token.start, token.end, progress.island));
        return None;
    }
    let (start, end) = if progress.farthest_token < syntax_tokens.len() {
        let token = &syntax_tokens[progress.farthest_token];
        (token.start, token.end)
    } else {
        (0, 0)
    };
    diagnostics.push(syntax_diagnostic(start, end, progress.island));
    None
}

fn syntax_diagnostic(start: usize, end: usize, island: usize) -> Diagnostic {
    Diagnostic::new(
        "GPU_FRONTEND_SYNTAX_ERROR",
        format!("Island {island} rejected syntax at span [{start}, {end})."),
        source_span(start, end),
    )
}

fn source_span(start: usize, end: usize) -> Span {
    Span {
        start: u32::try_from(start).expect("source span start exceeds the compact CST domain"),
        end: u32::try_from(end).expect("source span end exceeds the compact CST domain"),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_island(
    island_id: usize,
    start: usize,
    limit: usize,
    tokens: &[Token],
    delimiter_matches: &HashMap<usize, usize>,
    plan: &FrontendPlan,
    active: &mut Vec<(usize, usize, usize)>,
    progress: &mut IslandProgress,
) -> Option<IslandMatch> {
    let key = (island_id, start, limit);
    if active.contains(&key) {
        return None;
    }
    active.push(key);
    let matched = run_active_island(
        island_id,
        start,
        limit,
        tokens,
        delimiter_matches,
        plan,
        active,
        progress,
    );
    let removed = active.pop();
    assert_eq!(
        removed,
        Some(key),
        "active island path lost its current call"
    );
    matched
}

#[allow(clippy::too_many_arguments)]
fn run_active_island(
    island_id: usize,
    start: usize,
    limit: usize,
    tokens: &[Token],
    delimiter_matches: &HashMap<usize, usize>,
    plan: &FrontendPlan,
    active: &mut Vec<(usize, usize, usize)>,
    progress: &mut IslandProgress,
) -> Option<IslandMatch> {
    let island = plan
        .islands
        .get(island_id)
        .expect("generated frontend references an unknown island");
    let mut state = island.start_state;
    let mut cursor = start;
    let mut edges = Vec::new();
    let mut ordinal = 0;
    while cursor < limit {
        if cursor >= progress.farthest_token {
            progress.farthest_token = cursor;
            progress.island = island_id;
            progress.state = state;
        }
        let state_plan = island
            .states
            .get(state)
            .expect("generated island reached an unknown state");
        let token = &tokens[cursor];
        let terminal_transition = state_plan.transitions.iter().find(|transition| {
            transition.input_kind == InputKind::Terminal && transition.input == token.terminal
        });
        let mut nested_match: Option<(&IslandTransition, IslandMatch)> = None;
        for transition in state_plan
            .transitions
            .iter()
            .filter(|transition| transition.input_kind == InputKind::Island)
        {
            let nested_island = usize::try_from(transition.input)
                .expect("generated frontend has a negative island transition");
            let Some(nested_limit) = island_limit(
                nested_island,
                cursor,
                limit,
                tokens,
                delimiter_matches,
                plan.boundaries,
            ) else {
                continue;
            };
            let Some(candidate) = run_island(
                nested_island,
                cursor,
                nested_limit,
                tokens,
                delimiter_matches,
                plan,
                active,
                progress,
            ) else {
                continue;
            };
            if matches!(
                plan.boundaries[nested_island],
                Boundary::Paired { .. } | Boundary::Separated { .. }
            ) && candidate.next_token != nested_limit
            {
                continue;
            }
            if let Some((_, previous)) = &nested_match {
                if previous.next_token == candidate.next_token {
                    return None;
                }
                if previous.next_token > candidate.next_token {
                    continue;
                }
            }
            nested_match = Some((transition, candidate));
        }
        if let Some(terminal) = terminal_transition {
            let nested_length = nested_match.as_ref().map(|(_, matched)| matched.next_token);
            if nested_length.is_none() || nested_length <= Some(cursor + 1) {
                if nested_length == Some(cursor + 1) {
                    return None;
                }
                edges.push(PendingEdge {
                    field: terminal.emit.field,
                    token: Some(token.clone()),
                    child: None,
                    ordinal,
                });
                ordinal += 1;
                state = terminal.target;
                cursor += 1;
                continue;
            }
        }
        let Some((transition, matched)) = nested_match else {
            break;
        };
        edges.push(PendingEdge {
            field: transition.emit.field,
            token: None,
            child: Some(Box::new(matched.node)),
            ordinal,
        });
        ordinal += 1;
        state = transition.target;
        cursor = matched.next_token;
    }
    let final_state = island.states.get(state)?;
    if !final_state.accepting {
        return None;
    }
    let first_token = tokens.get(start);
    let node_start = first_token.map(|token| token.start).unwrap_or(0);
    let end = if cursor > start {
        tokens[cursor - 1].end
    } else {
        node_start
    };
    Some(IslandMatch {
        node: PendingNode {
            island: island_id,
            start: node_start,
            end,
            edges,
            id: usize::MAX,
        },
        next_token: cursor,
    })
}

fn island_limit(
    island: usize,
    start: usize,
    outer_limit: usize,
    tokens: &[Token],
    delimiter_matches: &HashMap<usize, usize>,
    boundaries: &[Boundary],
) -> Option<usize> {
    match boundaries
        .get(island)
        .expect("generated frontend has no boundary for island")
    {
        Boundary::Root | Boundary::Terminated { .. } => Some(outer_limit),
        Boundary::Paired { open_terminal, .. } | Boundary::Separated { open_terminal, .. } => {
            if tokens.get(start)?.terminal != *open_terminal {
                return None;
            }
            let close = *delimiter_matches.get(&start)?;
            if close >= outer_limit {
                return None;
            }
            Some(close + 1)
        }
    }
}

fn materialize(tokens: Vec<Token>, mut root: PendingNode, plan: &FrontendPlan) -> CompactProgram {
    let mut next_id = 0;
    assign_ids(&mut root, &mut next_id);
    let mut nodes = Vec::with_capacity(next_id * 8);
    let edge_count = count_edges(&root);
    let mut edges = Vec::with_capacity(edge_count * 4);
    materialize_node(&root, plan, &mut nodes, &mut edges);
    let mut token_records = Vec::with_capacity(tokens.len() * 4);
    for token in tokens {
        token_records.extend([
            token.terminal,
            token.start as i32,
            token.end as i32,
            token.lexical_identity,
        ]);
    }
    CompactProgram {
        tokens: token_records,
        nodes,
        edges,
    }
}

fn assign_ids(node: &mut PendingNode, next_id: &mut usize) {
    node.id = *next_id;
    *next_id += 1;
    for edge in &mut node.edges {
        if let Some(child) = &mut edge.child {
            assign_ids(child, next_id);
        }
    }
}

fn count_edges(node: &PendingNode) -> usize {
    node.edges.iter().fold(node.edges.len(), |count, edge| {
        if let Some(child) = &edge.child {
            return count + count_edges(child);
        }
        count
    })
}

fn materialize_node(
    node: &PendingNode,
    plan: &FrontendPlan,
    nodes: &mut Vec<i32>,
    edges: &mut Vec<i32>,
) {
    assert_eq!(
        nodes.len(),
        node.id * 8,
        "frontend nodes were not visited in pre-order"
    );
    let first_edge = edges.len() / 4;
    nodes.extend([
        plan.islands[node.island].rule_id,
        0,
        node.start as i32,
        node.end as i32,
        first_edge as i32,
        node.edges.len() as i32,
        -1,
        -1,
    ]);
    for edge in &node.edges {
        let (category, target) = if let Some(token) = &edge.token {
            (0, token.output_index)
        } else if let Some(child) = &edge.child {
            (1, child.id)
        } else {
            panic!("frontend edge has no target");
        };
        edges.extend([edge.field, edge.ordinal as i32, category, target as i32]);
    }
    for edge in &node.edges {
        if let Some(child) = &edge.child {
            materialize_node(child, plan, nodes, edges);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incremental_frontend_matches_fresh_frontend_after_token_edit() {
        assert_incremental_matches_fresh("return 1\u{e000}", "return 22\u{e000}");
    }

    #[test]
    fn incremental_frontend_matches_fresh_frontend_after_trailing_comment() {
        assert_incremental_matches_fresh("return 1\u{e000}", "return 1\u{e000} // changed");
    }

    #[test]
    fn incremental_frontend_matches_fresh_frontend_when_tokens_merge() {
        assert_incremental_matches_fresh("return x\u{e000}", "return xy\u{e000}");
    }

    fn assert_incremental_matches_fresh(previous: &str, current: &str) {
        let previous = previous.encode_utf16().collect::<Vec<_>>();
        let current = current.encode_utf16().collect::<Vec<_>>();
        let (_, state) = ingest_incremental(&previous, None).expect("previous source should parse");
        let (incremental, _) =
            ingest_incremental(&current, Some(&state)).expect("current source should parse");
        let fresh = ingest(&current).expect("current source should parse from scratch");

        assert_eq!(incremental.tokens, fresh.tokens);
        assert_eq!(incremental.nodes, fresh.nodes);
        assert_eq!(incremental.edges, fresh.edges);
    }
}
