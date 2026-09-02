use crate::ast::Span;

include!("schema.rs");

const TOKEN_WORDS: usize = 4;
const NODE_WORDS: usize = 8;
const EDGE_WORDS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Cursor {
    Token(u32),
    Rule(u32),
}

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub field: Option<u32>,
    pub target: Cursor,
}

pub struct CompactCst<'a> {
    source: &'a [u16],
    tokens: &'a [i32],
    nodes: &'a [i32],
    edges: &'a [i32],
    rule_names: &'a [&'a str],
    original_offsets: Option<&'a [u32]>,
}

impl<'a> CompactCst<'a> {
    pub fn new(
        source: &'a [u16],
        tokens: &'a [i32],
        nodes: &'a [i32],
        edges: &'a [i32],
        rule_names: &'a [&'a str],
    ) -> Result<Self, String> {
        if !tokens.len().is_multiple_of(TOKEN_WORDS) {
            return Err(format!("Baba returned {} token words", tokens.len()));
        }
        if !nodes.len().is_multiple_of(NODE_WORDS) {
            return Err(format!("Baba returned {} node words", nodes.len()));
        }
        if !edges.len().is_multiple_of(EDGE_WORDS) {
            return Err(format!("Baba returned {} edge words", edges.len()));
        }
        if nodes.is_empty() {
            return Err("Baba omitted the root node".to_owned());
        }
        Ok(Self {
            source,
            tokens,
            nodes,
            edges,
            rule_names,
            original_offsets: None,
        })
    }

    pub fn root(&self) -> Cursor {
        Cursor::Rule(0)
    }

    pub fn new_mapped(
        source: &'a [u16],
        tokens: &'a [i32],
        nodes: &'a [i32],
        edges: &'a [i32],
        rule_names: &'a [&'a str],
        original_offsets: &'a [u32],
    ) -> Result<Self, String> {
        let mut cst = Self::new(source, tokens, nodes, edges, rule_names)?;
        if original_offsets.len() != source.len() + 1 {
            return Err(format!(
                "layout map has {} offsets for {} source units",
                original_offsets.len(),
                source.len()
            ));
        }
        cst.original_offsets = Some(original_offsets);
        Ok(cst)
    }

    pub fn rule_name(&self, rule: u32) -> Result<&str, String> {
        let rule_id = self.node_word(rule, 0)?;
        if rule_id < 0 {
            return Err(format!("Baba returned negative rule id {rule_id}"));
        }
        self.rule_names
            .get(rule_id as usize)
            .copied()
            .ok_or_else(|| format!("Baba returned unknown rule {rule_id}"))
    }

    pub fn span(&self, cursor: Cursor) -> Result<Span, String> {
        let raw = self.raw_span(cursor)?;
        self.map_span(raw)
    }

    pub fn significant_span(&self, cursor: Cursor) -> Result<Span, String> {
        let mut stack = vec![cursor];
        let mut significant = None::<Span>;
        while let Some(cursor) = stack.pop() {
            match cursor {
                Cursor::Rule(rule) => stack.extend(self.children(rule)?),
                Cursor::Token(token) => {
                    if matches!(
                        self.token_kind(token)?.as_str(),
                        "LAYOUT_NEWLINE" | "LAYOUT_INDENT" | "LAYOUT_DEDENT"
                    ) {
                        continue;
                    }
                    let span = self.raw_span(cursor)?;
                    significant = Some(match significant {
                        Some(found) => Span {
                            start: found.start.min(span.start),
                            end: found.end.max(span.end),
                        },
                        None => span,
                    });
                }
            }
        }
        let raw = significant.ok_or_else(|| "rule contains no significant token".to_owned())?;
        self.map_span(raw)
    }

    fn map_span(&self, raw: Span) -> Result<Span, String> {
        let Some(offsets) = self.original_offsets else {
            return Ok(raw);
        };
        let start = offsets
            .get(raw.start as usize)
            .copied()
            .ok_or_else(|| format!("layout map omitted offset {}", raw.start))?;
        let end = offsets
            .get(raw.end as usize)
            .copied()
            .ok_or_else(|| format!("layout map omitted offset {}", raw.end))?;
        Ok(Span { start, end })
    }

    fn raw_span(&self, cursor: Cursor) -> Result<Span, String> {
        let (start, end) = match cursor {
            Cursor::Token(token) => (self.token_word(token, 1)?, self.token_word(token, 2)?),
            Cursor::Rule(rule) => (self.node_word(rule, 2)?, self.node_word(rule, 3)?),
        };
        if start < 0 || end < start {
            return Err(format!("Baba returned invalid span {start}..{end}"));
        }
        Ok(Span {
            start: start as u32,
            end: end as u32,
        })
    }

    pub fn text(&self, cursor: Cursor) -> Result<String, String> {
        let Cursor::Token(_) = cursor else {
            return Err("expected a token".to_owned());
        };
        let span = self.raw_span(cursor)?;
        let source = self
            .source
            .get(span.start as usize..span.end as usize)
            .ok_or_else(|| format!("token span {}..{} exceeds source", span.start, span.end))?;
        String::from_utf16(source).map_err(|error| format!("token is not valid UTF-16: {error}"))
    }

    pub fn token_kind(&self, token: u32) -> Result<String, String> {
        let identity = self.token_word(token, 3)?;
        if identity >= 0
            && let Some(kind) = NAMED_TOKEN_KINDS.get(identity as usize)
        {
            return Ok((*kind).to_owned());
        }
        self.text(Cursor::Token(token))
    }

    pub fn child(&self, rule: u32, index: usize) -> Result<Option<Cursor>, String> {
        self.rule_edges(rule)?
            .nth(index)
            .transpose()
            .map(|edge| edge.map(|edge| edge.target))
    }

    pub fn children(&self, rule: u32) -> Result<Vec<Cursor>, String> {
        self.rule_edges(rule)?
            .map(|edge| edge.map(|edge| edge.target))
            .collect()
    }

    pub fn field(&self, rule: u32, name: &str) -> Result<Option<Cursor>, String> {
        let field = field_id(name)?;
        for edge in self.rule_edges(rule)? {
            let edge = edge?;
            if edge.field == Some(field) {
                return Ok(Some(edge.target));
            }
        }
        Ok(None)
    }

    pub fn field_list(&self, rule: u32, name: &str) -> Result<Vec<Cursor>, String> {
        let field = field_id(name)?;
        let repeated = REPEATED_FIELDS.contains(&(self.rule_name(rule)?, name));
        let mut values = Vec::new();
        for edge in self.rule_edges(rule)? {
            let edge = edge?;
            if edge.field == Some(field) {
                if repeated && matches!(edge.target, Cursor::Token(_)) {
                    continue;
                }
                values.push(edge.target);
            }
        }
        Ok(values)
    }

    pub fn unwrap(&self, cursor: Cursor) -> Result<Cursor, String> {
        let Cursor::Rule(rule) = cursor else {
            return Err("expected a rule to unwrap".to_owned());
        };
        let name = self.rule_name(rule)?;
        self.child(rule, 0)?
            .ok_or_else(|| format!("rule {name} has no child"))
    }

    fn rule_edges(
        &self,
        rule: u32,
    ) -> Result<impl Iterator<Item = Result<Edge, String>> + '_, String> {
        let first = self.node_word(rule, 4)?;
        let count = self.node_word(rule, 5)?;
        if first < 0 || count < 0 {
            return Err(format!("Baba returned invalid edge range {first}+{count}"));
        }
        let range = first as usize..first as usize + count as usize;
        Ok(range.map(|edge| self.edge(edge as u32)))
    }

    fn edge(&self, edge: u32) -> Result<Edge, String> {
        let field = self.edge_word(edge, 0)?;
        let category = self.edge_word(edge, 2)?;
        let target = self.edge_word(edge, 3)?;
        if target < 0 {
            return Err(format!("Baba returned negative edge target {target}"));
        }
        let target = match category {
            0 => Cursor::Token(target as u32),
            1 => Cursor::Rule(target as u32),
            _ => return Err(format!("Baba returned edge category {category}")),
        };
        let field = if field < 0 {
            None
        } else {
            FIELD_NAMES
                .get(field as usize)
                .ok_or_else(|| format!("Baba returned unknown field {field}"))?;
            Some(field as u32)
        };
        Ok(Edge { field, target })
    }

    fn token_word(&self, token: u32, offset: usize) -> Result<i32, String> {
        required(self.tokens, token as usize * TOKEN_WORDS + offset, "token")
    }

    fn node_word(&self, node: u32, offset: usize) -> Result<i32, String> {
        required(self.nodes, node as usize * NODE_WORDS + offset, "node")
    }

    fn edge_word(&self, edge: u32, offset: usize) -> Result<i32, String> {
        required(self.edges, edge as usize * EDGE_WORDS + offset, "edge")
    }
}

fn field_id(name: &str) -> Result<u32, String> {
    FIELD_NAMES
        .iter()
        .position(|candidate| *candidate == name)
        .map(|index| index as u32)
        .ok_or_else(|| format!("unknown Blot CST field {name}"))
}

fn required(words: &[i32], index: usize, kind: &str) -> Result<i32, String> {
    words
        .get(index)
        .copied()
        .ok_or_else(|| format!("Baba omitted {kind} word {index}"))
}
