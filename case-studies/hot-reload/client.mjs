import { DevelopmentRuntime } from "../../src/development_runtime.ts";

const runtime = new DevelopmentRuntime();
let activeUnits = new Map();
let requested = false;
let refreshing = false;
let generation = -1;
const quantity = document.querySelector("#quantity");
const result = document.querySelector("#result");
const error = document.querySelector("#error");

function renderScore() {
  if (runtime.revision === undefined) return;
  quantity.setCustomValidity("");
  if (!quantity.reportValidity()) return;
  try {
    const score = runtime.entryInstance.exports["blot:score"];
    result.textContent = String(score(BigInt(quantity.value)));
    quantity.setCustomValidity("");
  } catch (failure) {
    quantity.setCustomValidity(String(failure));
    quantity.reportValidity();
  }
}
quantity.addEventListener("input", renderScore);

async function refresh() {
  requested = true;
  if (refreshing) return;
  refreshing = true;
  try {
    while (requested) {
      requested = false;
      const response = await fetch("/build", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Build request failed: ${response.status}`);
      }
      const snapshot = await response.json();
      if (snapshot.generation === generation) continue;
      const started = performance.now();
      const changedUnits = [];
      const retainedUnits = [];
      for (const unit of snapshot.units) {
        const previous = activeUnits.get(unit.name);
        if (
          previous !== undefined &&
          previous.interfaceDigest === unit.interfaceDigest &&
          previous.implementationDigest === unit.implementationDigest &&
          previous.wasmDigest === unit.wasmDigest
        ) {
          retainedUnits.push(unit);
          continue;
        }
        const artifact = await fetch(`/units/${unit.name}/${unit.wasmDigest}`);
        if (artifact.status === 409) {
          requested = true;
          break;
        }
        if (!artifact.ok) {
          throw new Error(
            `Unit ${unit.name} request failed: ${artifact.status}`,
          );
        }
        const bytes = await artifact.json();
        changedUnits.push({
          ...unit,
          wasm: Uint8Array.from(bytes.wasm),
          manifestBytes: Uint8Array.from(bytes.manifestBytes),
        });
      }
      if (requested) continue;
      const next = new Map(snapshot.units.map((unit) => [unit.name, unit]));
      const removedUnits = [...activeUnits.keys()].filter((name) =>
        !next.has(name)
      );
      if (runtime.revision !== snapshot.revision) {
        const activation = await runtime.prepareActivation({
          baseRevision: runtime.revision,
          revision: snapshot.revision,
          entryUnit: snapshot.entryUnit,
          changedUnits,
          retainedUnits,
          removedUnits,
          edges: snapshot.edges,
          durationMilliseconds: snapshot.durationMilliseconds,
        });
        await runtime.commitActivation(activation);
      }
      activeUnits = next;
      generation = snapshot.generation;
      document.querySelector("#message").textContent = snapshot.message.trim();
      document.querySelector("#status").textContent = "Watching for edits";
      document.querySelector("#build-time").textContent = `${
        snapshot.durationMilliseconds.toFixed(1)
      } ms`;
      document.querySelector("#activation-time").textContent = `${
        (performance.now() - started).toFixed(1)
      } ms`;
      document.querySelector("#compilations").textContent = String(
        snapshot.compilations,
      );
      document.querySelector("#specialized").textContent = String(
        Object.values(snapshot.work.specializedFunctions).reduce(
          (sum, count) => sum + count,
          0,
        ),
      );
      document.querySelector("#reused").textContent = String(
        Object.values(snapshot.work.reusedFunctions).reduce(
          (sum, count) => sum + count,
          0,
        ),
      );
      document.querySelector("#restored").textContent = String(
        snapshot.cache.loadedEntries,
      );
      const cacheWarning = document.querySelector("#cache-warning");
      cacheWarning.textContent = snapshot.cache.warnings.join("\n");
      cacheWarning.hidden = snapshot.cache.warnings.length === 0;
      document.querySelector("#replaced").textContent =
        changedUnits.map((unit) => unit.name).join(", ") || "none";
      document.querySelector("#retained").textContent =
        retainedUnits.map((unit) => unit.name).join(", ") || "none";
      document.querySelector("#revision").textContent = snapshot.revision.slice(
        0,
        12,
      );
      error.textContent = snapshot.failure || "";
      error.hidden = snapshot.failure === null;
      renderScore();
    }
  } catch (failure) {
    error.textContent = String(failure);
    error.hidden = false;
    document.querySelector("#status").textContent =
      "Keeping the last working build";
  } finally {
    refreshing = false;
  }
}

const events = new EventSource("/events");
events.onopen = () => {
  generation = -1;
  refresh();
};
events.onmessage = refresh;
events.onerror = () => {
  document.querySelector("#status").textContent = "Reconnecting…";
};
