import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import type { DevelopmentUnitIdentity } from "../../src/compiler/session.ts";
import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import { serveHotReload } from "./serve.ts";

test("browser development reloads only changed units and survives invalid edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-hot-reload-"));
  await cp(new URL("./", import.meta.url), directory, { recursive: true });
  const server = await serveHotReload(join(directory, "blot.json"), 0);
  const origin = `http://127.0.0.1:${server.port}`;
  const runtime = new DevelopmentRuntime();
  let identities = new Map<string, DevelopmentUnitIdentity>();
  const timings: { scenario: string; milliseconds: number }[] = [];
  const events = new AbortController();
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /formula.blot/);
    const client = await fetch(`${origin}/client.js`);
    assert.equal(client.status, 200);
    assert.doesNotMatch(
      await client.text(),
      /node:fs|CompilerWasm|compiler\.wasm/,
    );
    const stream = await fetch(`${origin}/events`, { signal: events.signal });
    assert.equal(stream.headers.get("Content-Type"), "text/event-stream");
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /data: 1/,
    );

    const activate = async () => {
      const snapshot = await (await fetch(`${origin}/build`)).json();
      const changedUnits = [];
      const retainedUnits = [];
      for (const unit of snapshot.units) {
        const previous = identities.get(unit.name);
        if (
          previous !== undefined && previous.wasmDigest === unit.wasmDigest &&
          previous.interfaceDigest === unit.interfaceDigest &&
          previous.implementationDigest === unit.implementationDigest
        ) {
          retainedUnits.push(unit);
        } else {
          const response = await fetch(
            `${origin}/units/${unit.name}/${unit.wasmDigest}`,
          );
          assert.equal(response.status, 200);
          const bytes = await response.json();
          changedUnits.push({
            ...unit,
            wasm: Uint8Array.from(bytes.wasm),
            manifestBytes: Uint8Array.from(bytes.manifestBytes),
          });
        }
      }
      const next = new Map<string, DevelopmentUnitIdentity>(
        snapshot.units.map((
          unit: DevelopmentUnitIdentity,
        ) => [unit.name, unit]),
      );
      const activation = await runtime.prepareActivation({
        ...snapshot,
        baseRevision: runtime.revision,
        changedUnits,
        retainedUnits,
        removedUnits: [...identities.keys()].filter((name) => !next.has(name)),
      });
      runtime.commitActivation(activation);
      identities = next;
      return snapshot;
    };

    let snapshot = await activate();
    timings.push({
      scenario: "initial",
      milliseconds: snapshot.durationMilliseconds,
    });
    const initialApp = runtime.entryInstance;
    const initialFormula = runtime.unitInstance("formula");
    const score = initialApp.exports["blot:score"];
    if (typeof score !== "function") {
      throw new Error("app omitted its score export");
    }
    assert.equal(score(21n), 42n);
    assert.deepEqual(snapshot.changed, ["app", "formula"]);
    const initialCompilations = snapshot.compilations;

    const save = async (name: string, source: string) => {
      const previous = snapshot.generation;
      const pendingEvent = reader.read();
      // Atomic rename exercises the save pattern used by many editors.
      await writeFile(join(directory, `${name}.tmp`), source);
      await rename(join(directory, `${name}.tmp`), join(directory, name));
      await assert.doesNotReject(Promise.race([
        pendingEvent,
        setTimeout(5000, undefined, { ref: false }).then(() => {
          throw new Error(`no reload notification for ${name}`);
        }),
      ]));
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        snapshot = await (await fetch(`${origin}/build`)).json();
        if (snapshot.generation > previous) return;
        await setTimeout(20);
      }
      assert.fail(`watcher did not publish ${name}`);
    };

    const formula = await readFile(join(directory, "formula.blot"), "utf8");
    await save("formula.blot", formula.replace("quantity * 2", "quantity * 3"));
    snapshot = await activate();
    timings.push({
      scenario: "formula edit",
      milliseconds: snapshot.durationMilliseconds,
    });
    assert.equal(runtime.entryInstance, initialApp);
    assert.notEqual(runtime.unitInstance("formula"), initialFormula);
    assert.equal(score(21n), 63n);
    assert.deepEqual(snapshot.changed, ["formula"]);
    const changedFormula = runtime.unitInstance("formula");

    await save("message.txt", "Assets need no compiler.\n");
    snapshot = await activate();
    timings.push({
      scenario: "text resource",
      milliseconds: snapshot.durationMilliseconds,
    });
    assert.equal(snapshot.message, "Assets need no compiler.\n");
    assert.equal(snapshot.compilations, initialCompilations + 1);
    assert.equal(runtime.unitInstance("formula"), changedFormula);
    assert.equal(runtime.entryInstance, initialApp);

    await save("formula.blot", "return (\n");
    assert.match(snapshot.failure, /MALFORMED_DELIMITER/);
    assert.equal(score(21n), 63n);
    await save("message.txt", "The previous formula still works.\n");
    assert.match(snapshot.failure, /MALFORMED_DELIMITER/);
    snapshot = await activate();
    assert.equal(runtime.unitInstance("formula"), changedFormula);

    await save("formula.blot", formula.replace("quantity * 2", "quantity * 4"));
    snapshot = await activate();
    assert.equal(snapshot.failure, null);
    assert.equal(score(21n), 84n);
    assert.equal(runtime.entryInstance, initialApp);
    assert.equal(
      (await fetch(
        `${origin}/units/formula/missing-revision`,
      )).status,
      409,
    );
    const beforeFetch = snapshot.compilations;
    await fetch(`${origin}/build`);
    const unchanged = await (await fetch(`${origin}/build`)).json();
    assert.equal(unchanged.compilations, beforeFetch);

    const manifest = await readFile(join(directory, "blot.json"), "utf8");
    await save("blot.json", "{");
    assert.ok(snapshot.failure);
    await save("formula.blot", formula.replace("quantity * 2", "quantity * 5"));
    assert.ok(snapshot.failure);
    assert.equal(score(21n), 84n);
    await save("blot.json", manifest);
    snapshot = await activate();
    assert.equal(snapshot.failure, null);
    assert.equal(score(21n), 105n);
    console.log(JSON.stringify(timings));
  } finally {
    events.abort();
    await server.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
