import { Compiler } from "./compiler.ts";

export interface Grants {
  /** Where a granted `print` capability and handled Console writes go. */
  readonly write: (line: string) => void;
}

export type EvaluatedValue = unknown;

const displays = new WeakMap<object, string>();

let sharedCompiler: Promise<Compiler> | undefined;

/** Evaluates one source graph using the same Rust semantics used by `build`. */
export async function evaluateFile(
  path: string,
  grants: Grants,
): Promise<EvaluatedValue> {
  if (sharedCompiler === undefined) sharedCompiler = Compiler.create();
  const evaluated = await (await sharedCompiler).evaluate(path);
  for (const line of evaluated.writes) grants.write(line);
  const value = decodeValue(evaluated.value);
  if (typeof value === "object" && value !== null) {
    displays.set(value, evaluated.display);
  }
  return value;
}

export function show(value: EvaluatedValue): string {
  if (typeof value === "object" && value !== null) {
    const display = displays.get(value);
    if (display !== undefined) return display;
  }
  return String(value);
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.tag === "int" && typeof record.value === "string") {
    return { ...record, value: BigInt(record.value) };
  }
  const decoded: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(record)) {
    decoded[name] = decodeValue(member);
  }
  return decoded;
}
