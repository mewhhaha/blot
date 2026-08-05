import type {
  CompactFrontendProgram,
  CpuFrontend,
} from "@mewhhaha/baba/runtime/webgpu";
import type { Rule, TokenCursor } from "./lower.ts";
import {
  compactFieldNames as fieldNames,
  compactNamedTokenKinds as namedTokenKinds,
  compactRepeatedFields,
} from "./compact_schema.ts";

const tokenWords = 4;
const nodeWords = 8;
const edgeWords = 4;

export interface CompactSchema {
  readonly fieldNames: readonly string[];
  readonly namedTokenKinds: readonly string[];
  readonly repeatedFields: readonly string[];
}

const currentSchema: CompactSchema = {
  fieldNames,
  namedTokenKinds,
  repeatedFields: compactRepeatedFields,
};

type Cursor = Rule | TokenCursor;

type Edge = {
  readonly field: string | null;
  readonly ordinal: number;
  readonly target: Cursor;
};

export function materializeCpuCst(
  frontend: CpuFrontend,
  program: CompactFrontendProgram,
  source: string,
  originalOffset: (offset: number) => number = (offset) => offset,
  schema: CompactSchema = currentSchema,
): Rule {
  const materializer = new CpuCstMaterializer(
    frontend,
    program,
    source,
    originalOffset,
    schema,
  );
  return materializer.root();
}

class CpuCstMaterializer {
  readonly #frontend: CpuFrontend;
  readonly #program: CompactFrontendProgram;
  readonly #source: string;
  readonly #originalOffset: (offset: number) => number;
  readonly #schema: CompactSchema;
  readonly #repeatedFields: ReadonlySet<string>;
  readonly #ruleNameById: ReadonlyMap<number, string>;
  readonly #rules = new Map<number, Rule>();
  readonly #tokens = new Map<number, TokenCursor>();

  constructor(
    frontend: CpuFrontend,
    program: CompactFrontendProgram,
    source: string,
    originalOffset: (offset: number) => number,
    schema: CompactSchema,
  ) {
    this.#frontend = frontend;
    this.#program = program;
    this.#source = source;
    this.#originalOffset = originalOffset;
    this.#schema = schema;
    this.#repeatedFields = new Set(schema.repeatedFields);
    this.#ruleNameById = new Map(
      frontend.plan.islands.map((island) => [island.ruleId, island.ruleName]),
    );
    if (program.tokens.length % tokenWords !== 0) {
      throw new Error(
        `Baba CPU frontend returned ${program.tokens.length} token words`,
      );
    }
    if (program.nodes.length % nodeWords !== 0) {
      throw new Error(
        `Baba CPU frontend returned ${program.nodes.length} node words`,
      );
    }
    if (program.edges.length % edgeWords !== 0) {
      throw new Error(
        `Baba CPU frontend returned ${program.edges.length} edge words`,
      );
    }
  }

  root(): Rule {
    if (this.#program.nodes.length === 0) {
      throw new Error("Baba CPU frontend omitted the root node");
    }
    return this.rule(0);
  }

  rule(id: number): Rule {
    const existing = this.#rules.get(id);
    if (existing !== undefined) return existing;
    const base = id * nodeWords;
    const ruleId = this.#required(this.#program.nodes, base, "rule");
    const name = this.#ruleNameById.get(ruleId);
    if (name === undefined) {
      throw new Error(`Baba CPU frontend returned unknown rule ${ruleId}`);
    }
    const start = this.#required(this.#program.nodes, base + 2, "node start");
    const end = this.#required(this.#program.nodes, base + 3, "node end");
    const edgeStart = this.#required(
      this.#program.nodes,
      base + 4,
      "node edge start",
    );
    const edgeCount = this.#required(
      this.#program.nodes,
      base + 5,
      "node edge count",
    );
    let materializedEdges: readonly Edge[] | null = null;
    const edges = (): readonly Edge[] => {
      if (materializedEdges !== null) return materializedEdges;
      materializedEdges = Array.from(
        { length: edgeCount },
        (_, offset) => this.edge(edgeStart + offset),
      );
      return materializedEdges;
    };
    let fields: ReadonlyMap<string, readonly Cursor[]> | null = null;
    const indexedFields = (): ReadonlyMap<string, readonly Cursor[]> => {
      if (fields !== null) return fields;
      const indexed = new Map<string, Cursor[]>();
      for (const edge of edges()) {
        if (edge.field === null) continue;
        const values = indexed.get(edge.field);
        if (values === undefined) {
          indexed.set(edge.field, [edge.target]);
        } else {
          values.push(edge.target);
        }
      }
      fields = indexed;
      return fields;
    };
    const rule: Rule = {
      type: "rule",
      name,
      span: {
        start: this.#originalOffset(start),
        end: this.#originalOffset(end),
      },
      child: (index) => edges()[index]?.target,
      children: () => edges().map((edge) => edge.target),
      field: (fieldName) => {
        const values = indexedFields().get(fieldName);
        if (values === undefined) return undefined;
        if (this.#repeatedFields.has(`${name}.${fieldName}`)) {
          return values.filter((value) => value.type === "rule");
        }
        if (values.length === 1) return values[0];
        return values;
      },
    };
    this.#rules.set(id, rule);
    return rule;
  }

  edge(id: number): Edge {
    const base = id * edgeWords;
    const fieldId = this.#required(this.#program.edges, base, "edge field");
    const ordinal = this.#required(
      this.#program.edges,
      base + 1,
      "edge ordinal",
    );
    const category = this.#required(
      this.#program.edges,
      base + 2,
      "edge category",
    );
    const targetId = this.#required(
      this.#program.edges,
      base + 3,
      "edge target",
    );
    let target: Cursor;
    if (category === 0) {
      target = this.token(targetId);
    } else if (category === 1) {
      target = this.rule(targetId);
    } else {
      throw new Error(`Baba CPU frontend returned edge category ${category}`);
    }
    let field: string | null = null;
    if (fieldId >= 0) {
      field = this.#schema.fieldNames[fieldId] ?? null;
      if (field === null) {
        throw new Error(`Baba CPU frontend returned unknown field ${fieldId}`);
      }
    }
    return { field, ordinal, target };
  }

  token(id: number): TokenCursor {
    const existing = this.#tokens.get(id);
    if (existing !== undefined) return existing;
    const base = id * tokenWords;
    const start = this.#required(this.#program.tokens, base + 1, "token start");
    const end = this.#required(this.#program.tokens, base + 2, "token end");
    const identity = this.#required(
      this.#program.tokens,
      base + 3,
      "token identity",
    );
    const text = this.#source.slice(start, end);
    let kind: string = text;
    if (identity < this.#schema.namedTokenKinds.length) {
      kind = this.#schema.namedTokenKinds[identity];
      if (kind === "WHITESPACE" || kind === "COMMENT") {
        throw new Error(`Baba CPU frontend emitted trivia token ${kind}`);
      }
    }
    const token: TokenCursor = {
      type: "token",
      kind,
      text,
      span: {
        start: this.#originalOffset(start),
        end: this.#originalOffset(end),
      },
    };
    this.#tokens.set(id, token);
    return token;
  }

  #required(values: Int32Array, index: number, label: string): number {
    const value = values[index];
    if (value === undefined) {
      throw new Error(`Baba CPU frontend omitted ${label} at word ${index}`);
    }
    return value;
  }
}
