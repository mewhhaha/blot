import { assert, assertEquals, assertMatch } from "@std/assert";
import { formatSource } from "../tooling/formatter.ts";
import type { Cursor } from "./cursor.ts";
import { parseConcrete } from "./parse.ts";
import {
  snapshotSource,
  SYNTAX_SNAPSHOT_FRONTEND_REVISION,
} from "./snapshot.ts";

const semanticallyBroken = `// leading trivia stays on the input tape
open import "blot:missing-module"

let vague = undefined_name + 1
let bad = 1 + "text"
return vague
`;

Deno.test("snapshot formats source with missing imports and semantic errors", async () => {
  const result = await snapshotSource(semanticallyBroken);
  assert(result.ok, "syntax-valid source has no snapshot");
  if (!result.ok) return;
  const snapshot = result.snapshot;

  assertEquals(snapshot.source, semanticallyBroken);
  assertEquals(snapshot.frontendRevision, SYNTAX_SNAPSHOT_FRONTEND_REVISION);
  assertMatch(snapshot.identity.contentId, /^[0-9]+:[0-9a-f]+$/);

  assert(snapshot.lineIndex.length === semanticallyBroken.split("\n").length);
  assertEquals(snapshot.lineIndex[0], 0);
  const vagueLine = snapshot.lineIndex[3];
  assert(vagueLine !== undefined);
  if (vagueLine === undefined) return;
  assert(semanticallyBroken.slice(vagueLine).startsWith("let vague"));

  assert(snapshot.tokens.length > 0);
  for (const token of snapshot.tokens) {
    assert(token.span.start >= 0);
    assert(token.span.end <= semanticallyBroken.length);
  }
  assert(
    snapshot.tokens.some((token) =>
      token.channel === "trivia" && token.text.includes("leading trivia")
    ),
    "input tape drops trivia",
  );

  assert(snapshot.layoutMap.elaboratedSource.includes("undefined_name"));
  assertEquals(snapshot.layoutMap.originalOffset(0), 0);
  assert(
    snapshot.layoutMap.originalOffset(
      snapshot.layoutMap.elaboratedSource.length,
    ) <=
      semanticallyBroken.length,
  );

  assertEquals(snapshot.cst.name, "program");
  assertEquals(
    snapshot.cst.span.start,
    semanticallyBroken.indexOf("open import"),
  );
  assert(snapshot.cst.span.end <= semanticallyBroken.length);
  assert(Array.isArray(snapshot.module.declarations));

  const formatted = await formatSource(semanticallyBroken, snapshot);
  assert(formatted.ok, "snapshot-backed formatting failed");
  if (!formatted.ok) return;
  assert(formatted.source.endsWith("\n"));
  assertEquals(await formatSource(formatted.source), formatted);
  assertEquals(await formatSource(semanticallyBroken), formatted);

  const detached = await parseConcrete(semanticallyBroken);
  assert(detached.ok, "parseConcrete rejects the fixture");
  if (!detached.ok) return;
  assertEquals(
    await formatSource(semanticallyBroken, {
      ok: true,
      module: detached.module,
      cst: detached.cst,
    }),
    formatted,
  );
});

Deno.test("snapshot failures yield diagnostics and format to no edits", async () => {
  const truncated = "let x = (1 +\n";
  const truncatedSnapshot = await snapshotSource(truncated);
  assert(!truncatedSnapshot.ok, "truncated source has a snapshot");
  if (truncatedSnapshot.ok) return;
  assert(truncatedSnapshot.diagnostics.length > 0);
  const truncatedFormat = await formatSource(truncated);
  assert(!truncatedFormat.ok, "truncated source formatted");
  if (truncatedFormat.ok) return;
  assertEquals(truncatedFormat.diagnostics, truncatedSnapshot.diagnostics);

  const loweringFailure = "continue\nreturn 1\n";
  const loweredSnapshot = await snapshotSource(loweringFailure);
  assert(!loweredSnapshot.ok, "lowering failure has a snapshot");
  if (loweredSnapshot.ok) return;
  assert(
    loweredSnapshot.diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_CONTINUE_OUTSIDE_LOOP"
    ),
  );
  assert(!(await formatSource(loweringFailure)).ok);

  const reservedLayout = "return 1\u{E000}\n";
  const reservedSnapshot = await snapshotSource(reservedLayout);
  assert(!reservedSnapshot.ok, "reserved layout character has a snapshot");
  if (reservedSnapshot.ok) return;
  assert(
    reservedSnapshot.diagnostics.some((diagnostic) =>
      diagnostic.code === "BLOT_RESERVED_LAYOUT_CHARACTER"
    ),
  );

  const other = "return 42\n";
  const first = await snapshotSource(semanticallyBroken);
  assert(first.ok, "fixture lost its snapshot");
  if (!first.ok) return;
  assertEquals(
    await formatSource(other, first.snapshot),
    await formatSource(other),
  );
});

Deno.test("snapshot agrees with parseConcrete on acceptance and spans", async () => {
  const valid = [
    "return 42\n",
    "// only a comment\nreturn 42\n",
    'open import "blot:prelude"\n\nlet sum = 20 + 22\nreturn sum\n',
    "let world = ()\nworld.units[choose 1].position.x := 3\nreturn world\n",
  ];
  for (const source of valid) {
    const snapshotted = await snapshotSource(source);
    const parsed = await parseConcrete(source);
    assert(snapshotted.ok, `snapshot rejects ${JSON.stringify(source)}`);
    assert(parsed.ok, `parseConcrete rejects ${JSON.stringify(source)}`);
    if (!snapshotted.ok || !parsed.ok) continue;
    assertEquals(snapshotted.snapshot.module, parsed.module);
    assertEquals(
      cstSignature(snapshotted.snapshot.cst),
      cstSignature(parsed.cst),
    );
  }
  const invalid = ["let x = (1 +\n", "continue\nreturn 1\n"];
  for (const source of invalid) {
    const snapshotted = await snapshotSource(source);
    const parsed = await parseConcrete(source);
    assert(!snapshotted.ok, `snapshot accepts ${JSON.stringify(source)}`);
    assert(!parsed.ok, `parseConcrete accepts ${JSON.stringify(source)}`);
    if (snapshotted.ok || parsed.ok) continue;
    assertEquals(snapshotted.diagnostics, parsed.diagnostics);
  }
});

function cstSignature(cursor: Cursor): string {
  if (cursor.type === "token") {
    return `t(${cursor.kind},${
      JSON.stringify(cursor.text)
    },${cursor.span.start},${cursor.span.end})`;
  }
  const children = cursor.children().map(cstSignature).join("");
  return `r(${cursor.name},${cursor.span.start},${cursor.span.end},${children})`;
}
