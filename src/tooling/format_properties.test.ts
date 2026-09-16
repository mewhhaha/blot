// src/tooling/format_properties.test.ts
//
// Round-trip properties over generated inputs: idempotence,
// representation equivalence, trivia preservation, and purity of text.
// The generator is a seeded PRNG over known-good fragments (no framework);
// every case must parse, or the failure names the generator bug.

import { assert, assertEquals } from "@std/assert";
import { snapshotSource } from "../syntax/snapshot.ts";
import { digestModule } from "./format/equivalence.ts";
import { attachTrivia } from "./format/trivia.ts";
import { formatSource } from "./formatter.ts";

const CASES = 50;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, options: readonly T[]): T {
  const chosen = options[Math.floor(rand() * options.length)];
  if (chosen === undefined) throw new Error("empty generator options");
  return chosen;
}

function genLongName(rand: () => number): string {
  const alphabet = "abcdefgh";
  let name = "";
  const length = 60 + Math.floor(rand() * 40);
  for (let i = 0; i < length; i += 1) {
    name += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return name;
}

function genExpr(rand: () => number, depth: number): string {
  const leaf = () => String(Math.floor(rand() * 100000));
  if (depth <= 0) return pick(rand, [leaf(), "v" + Math.floor(rand() * 9)]);
  const kind = Math.floor(rand() * 5);
  if (kind === 0) {
    const count = 1 + Math.floor(rand() * 14);
    const elements: string[] = [];
    for (let i = 0; i < count; i += 1) elements.push(genExpr(rand, 0));
    return "[" + elements.join(", ") + "]";
  }
  if (kind === 1) {
    return "(" + genExpr(rand, 0) + ", " + genExpr(rand, 0) + ")";
  }
  if (kind === 2) {
    const param = pick(rand, ["x", "y", "value"]);
    const body = rand() < 0.4 ? genLongName(rand) : genExpr(rand, 0);
    return `fn ${param} => ${body}`;
  }
  if (kind === 3) return genLongName(rand);
  return leaf();
}

function genProgram(rand: () => number): string {
  const lines: string[] = [];
  if (rand() < 0.5) {
    lines.push("// generated case " + Math.floor(rand() * 1000));
  }
  const bindings = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < bindings; i += 1) {
    if (rand() < 0.25) lines.push("");
    const keyword = pick(rand, ["let", "const"]);
    const gap = rand() < 0.3 ? "   " : " ";
    let line = `${keyword}${gap}g${i}${gap}=${gap}${genExpr(rand, 2)}`;
    if (rand() < 0.3) line += " // trailing " + i;
    lines.push(line);
    if (rand() < 0.2) lines.push("// between " + i);
  }
  lines.push("return g" + (bindings - 1));
  return lines.join("\n") + "\n";
}

async function mustFormat(source: string): Promise<string> {
  const formatted = await formatSource(source);
  if (!formatted.ok) {
    throw new Error(
      "generated input did not format: " +
        JSON.stringify(formatted.diagnostics) +
        "\n--- input ---\n" + source,
    );
  }
  return formatted.source;
}

function commentTexts(source: string): Promise<readonly string[]> {
  return snapshotSource(source).then((snapshot) => {
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    const attached = attachTrivia(
      snapshot.snapshot.lineIndex,
      snapshot.snapshot.tokens,
    );
    return attached.comments.map((comment) => comment.text);
  });
}

Deno.test("generated programs format to a stable fixpoint", async () => {
  const rand = mulberry32(0x9e3779b9);
  for (let index = 0; index < CASES; index += 1) {
    const input = genProgram(rand);
    const once = await mustFormat(input);
    const twice = await mustFormat(once);
    assertEquals(twice, once, `case ${index} unstable:\n${input}`);
  }
});

Deno.test("generated programs keep their representation and trivia", async () => {
  const rand = mulberry32(0x51ed270b);
  for (let index = 0; index < CASES; index += 1) {
    const input = genProgram(rand);
    const output = await mustFormat(input);
    const before = await snapshotSource(input);
    if (!before.ok) throw new Error(JSON.stringify(before.diagnostics));
    const after = await snapshotSource(output);
    if (!after.ok) throw new Error(JSON.stringify(after.diagnostics));
    assertEquals(
      digestModule(after.snapshot.module),
      digestModule(before.snapshot.module),
      `case ${index} changed representation:\n${input}`,
    );
    assertEquals(
      await commentTexts(output),
      await commentTexts(input),
      `case ${index} lost trivia:\n${input}`,
    );
  }
});

Deno.test("formatting generated programs is a pure function of text", async () => {
  const rand = mulberry32(0x85ebca6b);
  for (let index = 0; index < CASES; index += 1) {
    const input = genProgram(rand);
    const direct = await mustFormat(input);
    // A repeat call, a supplied snapshot, and an edited resubmission agree.
    assertEquals(
      await mustFormat(input),
      direct,
      `case ${index} nondeterministic`,
    );
    const snapshot = await snapshotSource(input);
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    const viaSnapshot = await formatSource(input, snapshot.snapshot);
    if (!viaSnapshot.ok) {
      throw new Error(JSON.stringify(viaSnapshot.diagnostics));
    }
    assertEquals(
      viaSnapshot.source,
      direct,
      `case ${index} snapshot-dependent`,
    );
    const edited = input.replace("\n", "\n\n// edit-reconstruction\n");
    const reformatted = await mustFormat(edited);
    assertEquals(
      await mustFormat(reformatted),
      reformatted,
      `case ${index} edit unstable:\n${edited}`,
    );
    const editedSnapshot = await snapshotSource(edited);
    if (!editedSnapshot.ok) {
      throw new Error(JSON.stringify(editedSnapshot.diagnostics));
    }
    const reformattedSnapshot = await snapshotSource(reformatted);
    if (!reformattedSnapshot.ok) {
      throw new Error(JSON.stringify(reformattedSnapshot.diagnostics));
    }
    assert(
      digestModule(reformattedSnapshot.snapshot.module) ===
        digestModule(editedSnapshot.snapshot.module),
      `case ${index} edit changed representation:\n${edited}`,
    );
  }
});
