import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BlotError } from "../diagnostic.ts";
import { runArtifact } from "../node/run.ts";
import { CompilerLimitDiagnostic } from "./policy.ts";
import { Compiler } from "./session.ts";

test("unrelated affine facts do not exhaust a constant array-index proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-proof-dependencies-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "main.blot");
    const declarations = Array.from(
      { length: 1500 },
      (_, index) => `let value_${index} = ${index}\n`,
    ).join("");
    await writeFile(path, declarations + "return @array.get [1] 0\n");
    assert.deepEqual(await compiler.check(path), { type: "1", effects: "" });
    assert.equal((await compiler.evaluate(path)).display, "1");
    const cold = await compiler.compile(path);
    assert.equal(await runArtifact(cold), "1");
    assert.deepEqual((await compiler.compile(path)).wasm, cold.wasm);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("connected affine and predicate exhaustion retain their public limit class", async () => {
  let aliases = "let value_0 = 0\n";
  for (let index = 1; index <= 513; index += 1) {
    aliases += `let value_${index} = value_${index - 1}\n`;
  }
  aliases += "return @array.get [1] value_513\n";
  let predicates = Array.from({ length: 129 }, () => "value >= 0");
  while (predicates.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < predicates.length; index += 2) {
      if (index + 1 === predicates.length) next.push(predicates[index]);
      else next.push(`(${predicates[index]}) && (${predicates[index + 1]})`);
    }
    predicates = next;
  }
  const source = `open import "blot:prelude"
const Allowed = refine (Int, fn value => ${predicates[0]})
let answer :: Allowed
let answer = 0
return answer
`;
  const compiler = await Compiler.create();
  try {
    for (
      const [name, sourceText, code] of [
        ["affine", aliases, "BLOT_REFINEMENT_BUDGET"],
        ["predicate", source, "BLOT_PREDICATE_BUDGET"],
      ]
    ) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          compiler.checkSource(`/tmp/blot-limit-${name}.blot`, sourceText),
          (error: unknown) => {
            assert.ok(
              error instanceof CompilerLimitDiagnostic,
              `${name}: ${error}`,
            );
            assert.equal(error.code, code);
            assert.ok(!(error instanceof BlotError));
            return true;
          },
        );
      }
    }
  } finally {
    compiler.destroy();
  }
});
