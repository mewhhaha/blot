import { DevelopmentRuntime } from "../../src/development_runtime.ts";
import { decodeManifest } from "../../src/abi_values.ts";
import { HostScope } from "../../src/resources.ts";
import { SparkRuntime } from "../../src/spark.ts";
import { createWebWorkerExecutor } from "../../src/web_worker_executor.ts";
import { IoRuntime } from "../../src/io.ts";
import { EventRuntime } from "../../src/events.ts";
import { ChannelRuntime } from "../../src/channel.ts";
import { SelectRuntime } from "../../src/select.ts";

const root = new HostScope();
const workers = createWebWorkerExecutor(root, {
  size: 2,
  workerUrl: new URL("/worker.js", location.href),
});
const sparks = new SparkRuntime(root, { workers });
const services = new IoRuntime(root);
const eventRuntime = new EventRuntime(root, sparks);
const channels = new ChannelRuntime(root, sparks);
const selection = new SelectRuntime(channels, eventRuntime, services);
const views = root.resource("Demo.View");
const operations = new Map([
  ["show", (_context, request) => {
    views.get(request.fields.get("0"));
    result.textContent = String(request.fields.get("1"));
    recordActivity(`Published ${result.textContent}`);
    document.querySelector("#received").textContent = String(
      request.fields.get("2"),
    );
    return null;
  }],
  ["activity", (_context, request) => {
    views.get(request.fields.get("0"));
    recordActivity(request.fields.get("1"));
    return null;
  }],
  ["message", (_context, request) => {
    views.get(request.fields.get("0"));
    document.querySelector("#message").textContent = request.fields.get("1")
      .trim();
    return null;
  }],
  ["stopped", (_context, view) => {
    views.get(view);
    recordActivity("Stopped and cleaned up");
    stopped += 1;
    document.querySelector("#stopped").textContent = String(stopped);
    return null;
  }],
]);
const runtime = new DevelopmentRuntime(undefined, {
  scope: root,
  capabilities(artifact) {
    const capabilities = new Map([
      ...sparks.capabilitiesFor(artifact),
      ...services.capabilitiesFor(artifact),
      ...eventRuntime.capabilitiesFor(artifact),
      ...channels.capabilitiesFor(artifact),
      ...selection.capabilitiesFor(artifact),
    ]);
    const selected = new Map();
    for (const imported of decodeManifest(artifact.manifestBytes).imports) {
      if (imported.capability === "Ui") {
        selected.set(imported.sourceName, operations.get(imported.sourceName));
      }
    }
    if (selected.size > 0) capabilities.set("Ui", selected);
    return capabilities;
  },
});
let activeUnits = new Map();
let requested = false;
let refreshing = false;
let activating = false;
let generation = -1;
const quantity = document.querySelector("#quantity");
const result = document.querySelector("#result");
const error = document.querySelector("#error");

let currentSink;
let actor;
let actorController;
let paused = false;
let stopped = 0;
const changes = eventRuntime.source(
  root,
  { kind: "signed-integer-64" },
  (sink) => {
    currentSink = sink;
    quantity.addEventListener("input", renderScore);
    renderScore();
    return () => {
      quantity.removeEventListener("input", renderScore);
      if (currentSink === sink) currentSink = undefined;
    };
  },
);
const io = {
  kind: "record",
  fields: new Map([
    ["executor", sparks.executor],
    ["changes", changes],
    ["clock", services.clock(root)],
    ["http", services.http(root, { baseURL: new URL(location.href) })],
    ["view", views.grant(root, {})],
  ]),
};

function recordActivity(message) {
  document.querySelector("#activity").textContent = message;
  const history = document.querySelector("#history");
  const entry = document.createElement("li");
  entry.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  history.prepend(entry);
  while (history.children.length > 40) history.lastElementChild.remove();
}

setInterval(() => {
  const jobs = sparks.statistics;
  document.querySelector("#active-jobs").textContent = String(jobs.jobsActive);
  document.querySelector("#retained-jobs").textContent = String(
    jobs.jobsRetained,
  );
  document.querySelector("#worker-jobs").textContent = String(
    workers.statistics.jobsCompleted,
  );
}, 100);

function renderScore() {
  quantity.setCustomValidity("");
  if (!quantity.reportValidity() || currentSink === undefined) return;
  const value = quantity.valueAsNumber;
  if (!Number.isSafeInteger(value)) return;
  currentSink.emit(BigInt(value));
}

function ensureActor() {
  if (
    actor !== undefined || paused || activating ||
    runtime.revision === undefined
  ) return;
  actorController = new AbortController();
  const pending = runtime.callAsync("run", [io], {
    signal: actorController.signal,
  })
    .catch((failure) => {
      if (failure instanceof DOMException && failure.name === "AbortError") {
        return;
      }
      error.textContent = String(failure);
      error.hidden = false;
    }).finally(() => {
      if (actor === pending) actor = undefined;
    });
  actor = pending;
}

document.querySelector("#toggle").addEventListener("click", async () => {
  paused = !paused;
  let label = "Stop actor";
  if (paused) label = "Start actor";
  document.querySelector("#toggle").textContent = label;
  if (paused) {
    actorController?.abort(new DOMException("actor paused", "AbortError"));
    await actor;
  }
  ensureActor();
});

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
        activating = true;
        try {
          await runtime.commitActivation(activation);
        } finally {
          activating = false;
        }
      }
      if (changedUnits.length > 0) {
        recordActivity(
          `Activated ${changedUnits.map((unit) => unit.name).join(", ")}`,
        );
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
      ensureActor();
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
