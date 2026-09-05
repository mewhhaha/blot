import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

interface Claim {
  readonly id: string;
  readonly status: "accepted" | "rejected" | "current-limit";
  readonly source?: string;
  readonly file?: string;
  readonly display?: string;
  readonly code?: string;
}

const document = JSON.parse(
  await readFile(
    new URL("../../docs/language-claims.json", import.meta.url),
    "utf8",
  ),
) as { version: number; claims: Claim[] };
assert.equal(document.version, 1);
const identifiers = new Set<string>();
for (const claim of document.claims) {
  assert.ok(!identifiers.has(claim.id), `Duplicate claim: ${claim.id}`);
  identifiers.add(claim.id);
  assert.ok(["accepted", "rejected", "current-limit"].includes(claim.status));
  assert.notEqual(claim.source === undefined, claim.file === undefined);
  test(`language claim: ${claim.id} (${claim.status})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-claim-"));
    const path = join(directory, "main.blot");
    const compiler = await Compiler.create();
    try {
      let source = claim.source;
      if (claim.file !== undefined) {
        source = await readFile(
          new URL(`../../${claim.file}`, import.meta.url),
          "utf8",
        );
      }
      if (source === undefined) throw new Error("claim has no source");
      await writeFile(path, source);
      if (claim.status === "accepted") {
        assert.equal(typeof claim.display, "string");
        assert.equal(
          await runArtifact(await compiler.compile(path)),
          claim.display,
        );
      } else {
        assert.equal(typeof claim.code, "string");
        if (claim.code === undefined) {
          throw new Error("claim has no diagnostic");
        }
        await assert.rejects(
          () => compiler.check(path),
          new RegExp(claim.code),
        );
      }
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true });
    }
  });
}
