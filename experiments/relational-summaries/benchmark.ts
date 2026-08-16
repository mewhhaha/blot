import { performance } from "node:perf_hooks";
import {
  instantiateSummaryProposition,
  parameter,
  RelationalState,
  type RelationalSummary,
  result,
  type SummaryCall,
} from "./summary.ts";
import {
  type RelationalCaller,
  RelationalCheckSession,
  type RelationalDefinition,
} from "./verification.ts";

const callers = integerArg("--callers", 200);
const depth = integerArg("--depth", 12);
const rounds = integerArg("--rounds", 9);
const pressure = integerArg("--pressure", 128);
const step = summary(1);
const wrapper = definition("body-v1", depth);
const privateEdit = definition("body-v2", depth);

runReplay(wrapper, 2);
runSealedCold(wrapper, 2);
prepareSealedEdit(wrapper, privateEdit, 2)();
runPressure(wrapper.summary, 4, false);
runPressure(wrapper.summary, 4, true);

const replayCold: number[] = [];
const sealedCold: number[] = [];
const replayEdit: number[] = [];
const sealedEdit: number[] = [];
for (let round = 0; round < rounds; round += 1) {
  if (round % 2 === 0) {
    replayCold.push(timed(() => runReplay(wrapper, callers)));
    sealedCold.push(timed(() => runSealedCold(wrapper, callers)));
    replayEdit.push(timed(() => runReplay(privateEdit, callers)));
    sealedEdit.push(timed(prepareSealedEdit(wrapper, privateEdit, callers)));
    continue;
  }
  sealedCold.push(timed(() => runSealedCold(wrapper, callers)));
  replayCold.push(timed(() => runReplay(wrapper, callers)));
  sealedEdit.push(timed(prepareSealedEdit(wrapper, privateEdit, callers)));
  replayEdit.push(timed(() => runReplay(privateEdit, callers)));
}

const pressureSizes = uniqueSorted([
  Math.max(4, Math.floor(pressure / 4)),
  Math.max(4, Math.floor(pressure / 2)),
  pressure,
]);
const factPressure = pressureSizes.map((calls) => {
  const accumulating: number[] = [];
  const pruned: number[] = [];
  let accumulatingFacts = 0;
  let prunedFacts = 0;
  for (let round = 0; round < rounds; round += 1) {
    if (round % 2 === 0) {
      accumulating.push(timed(() => {
        accumulatingFacts = runPressure(wrapper.summary, calls, false);
      }));
      pruned.push(timed(() => {
        prunedFacts = runPressure(wrapper.summary, calls, true);
      }));
      continue;
    }
    pruned.push(timed(() => {
      prunedFacts = runPressure(wrapper.summary, calls, true);
    }));
    accumulating.push(timed(() => {
      accumulatingFacts = runPressure(wrapper.summary, calls, false);
    }));
  }
  return {
    calls,
    accumulating: {
      medianMs: median(accumulating),
      samplesMs: accumulating,
      retainedFacts: accumulatingFacts,
    },
    lifetimePruned: {
      medianMs: median(pruned),
      samplesMs: pruned,
      retainedFacts: prunedFacts,
    },
    speedup: median(accumulating) / median(pruned),
  };
});

const replayColdMedian = median(replayCold);
const sealedColdMedian = median(sealedCold);
const replayEditMedian = median(replayEdit);
const sealedEditMedian = median(sealedEdit);
console.log(JSON.stringify(
  {
    runtime: process.version,
    configuration: { callers, bodySteps: depth, rounds, pressure },
    callReuse: {
      cold: {
        replay: {
          medianMs: replayColdMedian,
          samplesMs: replayCold,
          bodyExecutions: callers,
          callerChecks: callers,
        },
        sealed: {
          medianMs: sealedColdMedian,
          samplesMs: sealedCold,
          bodyExecutions: 1,
          callerChecks: callers,
        },
        speedup: replayColdMedian / sealedColdMedian,
      },
      privateBodyEdit: {
        replay: {
          medianMs: replayEditMedian,
          samplesMs: replayEdit,
          bodyExecutions: callers,
          callerRechecks: callers,
        },
        sealed: {
          medianMs: sealedEditMedian,
          samplesMs: sealedEdit,
          bodyExecutions: 1,
          callerRechecks: 0,
        },
        speedup: replayEditMedian / sealedEditMedian,
      },
    },
    factPressure,
  },
  null,
  2,
));

function runReplay(
  target: RelationalDefinition,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const state = new RelationalState();
    const input = state.bindFresh("input", { description: "replay input" });
    const results = target.body(state, [input]);
    for (const proposition of target.summary.ensures) {
      const required = instantiateSummaryProposition(
        proposition,
        [input],
        results,
      );
      if (!state.entails(required)) {
        throw new Error("replayed body did not establish its summary");
      }
    }
  }
}

function runSealedCold(
  target: RelationalDefinition,
  count: number,
): void {
  const session = new RelationalCheckSession();
  const result = session.check(target, makeCallers(count));
  if (!result.bodyVerified || result.recheckedCallers.length !== count) {
    throw new Error("cold sealed check did not verify its complete boundary");
  }
}

function prepareSealedEdit(
  before: RelationalDefinition,
  after: RelationalDefinition,
  count: number,
): () => void {
  const session = new RelationalCheckSession();
  const consumers = makeCallers(count);
  session.check(before, consumers);
  return () => {
    const result = session.check(after, consumers);
    if (!result.bodyVerified || result.interfaceChanged) {
      throw new Error("private edit did not preserve its verified interface");
    }
    if (result.recheckedCallers.length !== 0) {
      throw new Error("private edit rechecked a sealed caller");
    }
  };
}

function runPressure(
  target: RelationalSummary,
  calls: number,
  prune: boolean,
): number {
  const state = new RelationalState();
  for (let index = 0; index < calls; index += 1) {
    const inputName = `input-${index}`;
    const resultName = `result-${index}`;
    const input = state.bindFresh(inputName, { description: inputName });
    const call = accepted(state.call(
      target,
      [input],
      { description: `pressure call ${index}` },
    ));
    state.bind(resultName, call.results[0]!, { description: resultName });
    if (!prune) continue;
    state.drop(resultName);
    state.drop(inputName);
  }
  return state.factCount();
}

function makeCallers(count: number): readonly RelationalCaller[] {
  const callers: RelationalCaller[] = [];
  for (let index = 0; index < count; index += 1) {
    callers.push({
      name: `caller-${index}`,
      revision: "v1",
      check(target) {
        const state = new RelationalState();
        const input = state.bindFresh("input", {
          description: `caller ${index} input`,
        });
        const call = accepted(state.call(target, [input], {
          description: `caller ${index} call`,
        }));
        for (const proposition of target.ensures) {
          const required = instantiateSummaryProposition(
            proposition,
            [input],
            call.results,
          );
          if (!state.entails(required)) {
            throw new Error("sealed caller could not consume its summary");
          }
        }
      },
    });
  }
  return callers;
}

function definition(revision: string, bodyDepth: number): RelationalDefinition {
  return {
    name: "advance",
    revision,
    summary: summary(bodyDepth),
    body(state, parameters) {
      const input = parameters[0];
      if (input === undefined) throw new Error("advance input is missing");
      let current = input;
      for (let index = 0; index < bodyDepth; index += 1) {
        current = accepted(state.call(
          step,
          [current],
          { description: `advance step ${index}` },
        )).results[0]!;
      }
      return [current];
    },
  };
}

function summary(offset: number): RelationalSummary {
  return {
    tag: "relational-summary",
    schema: 1,
    parameters: 1,
    results: [{ tag: "fresh" }],
    requires: [],
    ensures: [{
      tag: "equal-offset",
      left: result(0),
      right: parameter(0),
      offset: BigInt(offset),
    }],
  };
}

function accepted(
  call: SummaryCall,
): Extract<SummaryCall, { tag: "accepted" }> {
  if (call.tag === "refused") {
    throw new Error(`unexpected refusal: ${call.missing.required.tag}`);
  }
  return call;
}

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function uniqueSorted(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function integerArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  let value = Number.NaN;
  if (raw !== undefined) value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}
