import { CpuFrontend } from "@mewhhaha/baba/runtime/webgpu";
import {
  compactFieldNames,
  compactNamedTokenKinds,
  compactRepeatedFields,
  compactRuleNames,
  currentCompactFieldNames,
} from "../src/syntax/compact_schema.ts";

const plan = await Deno.readFile("generated/wasm/parser.plan");
const frontend = CpuFrontend.create(plan);
const stableRuleIdByName = new Map<string, number>(
  compactRuleNames.map((name, id) => [name, id] as const),
);
const stableFieldIdByName = new Map<string, number>(
  compactFieldNames.map((name, id) => [name, id] as const),
);
for (const island of frontend.plan.islands) {
  if (!stableRuleIdByName.has(island.ruleName)) {
    throw new Error(
      `Baba rule ${island.ruleName} has no stable compact rule identifier`,
    );
  }
}

function stableRuleId(name: string): number {
  const id = stableRuleIdByName.get(name);
  if (id === undefined) throw new Error(`unknown stable rule ${name}`);
  return id;
}

function stableFieldId(id: number): number {
  if (id < 0) return id;
  const name = currentCompactFieldNames[id];
  if (name === undefined) {
    throw new Error(`Baba emitted unknown live field ${id}`);
  }
  const stable = stableFieldIdByName.get(name);
  if (stable === undefined) {
    throw new Error(
      `Baba field ${name} has no stable compact field identifier`,
    );
  }
  return stable;
}

const repeated = compactRepeatedFields.map((entry) => {
  const separator = entry.indexOf(".");
  if (separator < 1 || separator === entry.length - 1) {
    throw new Error(`invalid repeated compact field ${entry}`);
  }
  return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
});

const source = [
  rustSlice("RULE_NAMES", compactRuleNames),
  rustSlice("FIELD_NAMES", compactFieldNames),
  rustSlice("NAMED_TOKEN_KINDS", compactNamedTokenKinds),
  `pub(crate) const REPEATED_FIELDS: &[(&str, &str)] = &[\n${
    repeated.map(([rule, field]) =>
      `    (${JSON.stringify(rule)}, ${JSON.stringify(field)}),`
    )
      .join("\n")
  }\n];\n`,
].join("\n");

if (!frontend.lexer.guardFree) {
  throw new Error(
    `Baba's generated lexer is not guard-free: ${
      frontend.lexer.guardDiagnostics.join("; ")
    }`,
  );
}
const frontendPlan = rustFrontendPlan(frontend);

const outputs = [
  ["compiler/src/schema.rs", source],
  ["compiler/src/frontend_plan.rs", frontendPlan],
  ...await protocolOutputs(),
  ...await languageOutputs(),
] as const;
if (Deno.args.includes("--check")) {
  for (const [outputPath, expected] of outputs) {
    const current = await Deno.readTextFile(outputPath);
    if (current !== expected) {
      throw new Error(
        `${outputPath} is stale; run \`deno task generate:compiler-schema\``,
      );
    }
  }
} else {
  for (const [outputPath, generated] of outputs) {
    await Deno.writeTextFile(outputPath, generated);
  }
}

async function protocolOutputs(): Promise<
  readonly (readonly [string, string])[]
> {
  const protocol = JSON.parse(
    await Deno.readTextFile("compiler/protocol.json"),
  ) as Record<string, unknown>;
  const compilerHostAbi = protocolVersion(protocol, "compilerHostAbi");
  const checkedModuleCertificate = protocolVersion(
    protocol,
    "checkedModuleCertificate",
  );
  const runtimeHir = protocolVersion(protocol, "runtimeHir");
  return [
    [
      "compiler/src/protocol.rs",
      `// Generated from compiler/protocol.json. Do not edit.\n\n` +
      `pub(crate) const COMPILER_HOST_ABI_VERSION: u32 = ${compilerHostAbi};\n` +
      `pub(crate) const CHECKED_MODULE_CERTIFICATE_SCHEMA: u32 = ${checkedModuleCertificate};\n` +
      `pub(crate) const RUNTIME_HIR_SCHEMA: u8 = ${runtimeHir};\n`,
    ],
    [
      "src/compiler/protocol.ts",
      `// Generated from compiler/protocol.json. Do not edit.\n\n` +
      `export const compilerHostAbiVersion = ${compilerHostAbi} as const;\n` +
      `export const checkedModuleCertificateSchema = ${checkedModuleCertificate} as const;\n` +
      `export const runtimeHirSchema = ${runtimeHir} as const;\n`,
    ],
  ];
}

function protocolVersion(
  protocol: Record<string, unknown>,
  name: string,
): number {
  const value = protocol[name];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`compiler protocol ${name} must be a positive integer`);
  }
  return value as number;
}

interface OperatorEntry {
  readonly operator: string;
  readonly associativity: "left" | "right" | "none" | "prefix";
  readonly precedence: number;
  readonly target: string;
}

async function languageOutputs(): Promise<
  readonly (readonly [string, string])[]
> {
  const language = JSON.parse(
    await Deno.readTextFile("compiler/language.json"),
  ) as { readonly operators?: readonly OperatorEntry[] };
  const operators = language.operators;
  if (!Array.isArray(operators) || operators.length === 0) {
    throw new Error("compiler language vocabulary must declare operators");
  }
  const keys = new Set<string>();
  for (const entry of operators) {
    const key = `${entry.associativity}:${entry.operator}`;
    if (keys.has(key)) throw new Error(`duplicate operator ${key}`);
    keys.add(key);
    if (!Number.isSafeInteger(entry.precedence) || entry.precedence < 0) {
      throw new Error(`invalid precedence for ${key}`);
    }
  }
  const typescript =
    `// Generated from compiler/language.json. Do not edit.\n\n` +
    `export const generatedFixities = ${
      JSON.stringify(operators, null, 2)
    } as const;\n`;
  const rustEntries = operators.map((entry) => {
    const associativity = entry.associativity[0].toUpperCase() +
      entry.associativity.slice(1);
    return `    GeneratedFixity { operator: ${
      JSON.stringify(entry.operator)
    }, associativity: GeneratedAssociativity::${associativity}, precedence: ${entry.precedence}, target: ${
      JSON.stringify(entry.target)
    } },`;
  }).join("\n");
  const rust = `// Generated from compiler/language.json. Do not edit.\n\n` +
    `#[rustfmt::skip]\n` +
    `const GENERATED_FIXITIES: &[GeneratedFixity] = &[\n${rustEntries}\n];\n`;
  return [
    ["src/syntax/fixities.generated.ts", typescript],
    ["compiler/src/fixities_generated.rs", rust],
  ];
}

function rustSlice(name: string, values: readonly string[]): string {
  const entries = values.map((value) => `    ${JSON.stringify(value)},`).join(
    "\n",
  );
  return `pub(crate) const ${name}: &[&str] = &[\n${entries}\n];\n`;
}

function rustFrontendPlan(frontend: CpuFrontend): string {
  const asciiTransitions = frontend.lexer.asciiTransitions;
  if (asciiTransitions === null) {
    throw new Error(
      "Baba's generated lexer has no dense ASCII transition table",
    );
  }
  const sections: string[] = [];
  for (const [islandIndex, island] of frontend.plan.islands.entries()) {
    for (const [stateIndex, state] of island.states.entries()) {
      const transitions = state.transitions.map((transition) => {
        let inputKind = "InputKind::Terminal";
        if (transition.inputKind === "island") {
          inputKind = "InputKind::Island";
        }
        return `    IslandTransition { input_kind: ${inputKind}, input: ${transition.input}, target: ${transition.target}, emit: IslandEmit { field: ${
          stableFieldId(transition.emit.field)
        } } },`;
      }).join("\n");
      sections.push(
        `static ISLAND_${islandIndex}_STATE_${stateIndex}_TRANSITIONS: &[IslandTransition] = &[\n${transitions}\n];\n`,
      );
    }
    const states = island.states.map((state, stateIndex) =>
      `    IslandState { accepting: ${state.accepting}, transitions: ISLAND_${islandIndex}_STATE_${stateIndex}_TRANSITIONS },`
    ).join("\n");
    sections.push(
      `static ISLAND_${islandIndex}_STATES: &[IslandState] = &[\n${states}\n];\n`,
    );
  }
  const islands = frontend.plan.islands.map((island, islandIndex) =>
    `    Island { rule_id: ${
      stableRuleId(island.ruleName)
    }, start_state: ${island.startState}, states: ISLAND_${islandIndex}_STATES },`
  ).join("\n");
  sections.push(`static ISLANDS: &[Island] = &[\n${islands}\n];\n`);
  const boundaries = frontend.plan.boundaries.map((boundary) => {
    if (boundary.kind === "root") return "    Boundary::Root,";
    if (boundary.kind === "terminated") {
      return `    Boundary::Terminated { _terminal: ${boundary.terminal} },`;
    }
    if (boundary.kind === "paired") {
      return `    Boundary::Paired { open_terminal: ${boundary.openTerminal}, close_terminal: ${boundary.closeTerminal} },`;
    }
    return `    Boundary::Separated { open_terminal: ${boundary.openTerminal}, close_terminal: ${boundary.closeTerminal}, _separator_terminal: ${boundary.separatorTerminal} },`;
  }).join("\n");
  sections.push(`static BOUNDARIES: &[Boundary] = &[\n${boundaries}\n];\n`);
  sections.push(rustIntSlice(
    "TERMINAL_CLASSIFICATION",
    frontend.plan.terminalClassification,
  ));
  sections.push(rustIntSlice(
    "ASCII_TRANSITIONS",
    asciiTransitions,
  ));
  sections.push(rustIntSlice(
    "TRANSITION_ROWS",
    frontend.lexer.transitionRows,
  ));
  sections.push(rustIntSlice("TRANSITIONS", frontend.lexer.transitions));
  sections.push(rustIntSlice(
    "ACCEPT_SPEC_BY_STATE",
    frontend.lexer.acceptSpecByState,
  ));
  sections.push(`static GENERATED_FRONTEND_PLAN: FrontendPlan = FrontendPlan {
    root_island: ${frontend.plan.rootIsland},
    terminal_classification: TERMINAL_CLASSIFICATION,
    boundaries: BOUNDARIES,
    islands: ISLANDS,
    lexer: Lexer {
        state_count: ${frontend.lexer.stateCount},
        start_state: ${frontend.lexer.startState},
        ascii_transitions: ASCII_TRANSITIONS,
        transition_rows: TRANSITION_ROWS,
        transitions: TRANSITIONS,
        accept_spec_by_state: ACCEPT_SPEC_BY_STATE,
    },
};
`);
  return sections.join("\n");
}

function rustIntSlice(name: string, values: ArrayLike<number>): string {
  const lines: string[] = [];
  for (let index = 0; index < values.length; index += 16) {
    const line = Array.from(
      { length: Math.min(16, values.length - index) },
      (_, offset) => values[index + offset],
    ).join(", ");
    lines.push(`    ${line},`);
  }
  return `static ${name}: &[i32] = &[\n${lines.join("\n")}\n];\n`;
}
