// Summarize named Node/V8 CPU profiles from staged-types/compare.mjs.
// Requires llvm-cxxfilt for Rust symbol demangling; sampling is external.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const paths = process.argv.slice(2);
assert(paths.length > 0, "Provide one or more named .cpuprofile files");
const boundary = "compile_compiler_session_module";
const focus = new Map([
  ["evaluation", "blot_compiler::eval::run"],
  ["instruction machine", "<blot_compiler::eval::bytecode::Machine>::run"],
  ["application preparation", "blot_compiler::eval::prepare_application"],
  ["application execution", "blot_compiler::eval::apply_with_expected"],
  [
    "signature substitution",
    "blot_compiler::type_instantiation::substitute_signature",
  ],
  [
    "signature discovery",
    "blot_compiler::type_instantiation::record_signature_substitutions::value_signature",
  ],
  [
    "cached type inflation",
    "<blot_compiler::typecheck::Checker>::inflate_cached_type",
  ],
  [
    "nested specialization",
    "<blot_compiler::typecheck::Checker>::validate_nested_specialization",
  ],
  [
    "speculative constraints",
    "<blot_compiler::typecheck::Checker>::can_constrain_ids",
  ],
  ["union construction", "blot_compiler::primitives::union"],
  ["union insertion", "<blot_compiler::value::UnionMembers>::insert_unique"],
  ["type summaries", "blot_compiler::value::type_value::summarize"],
]);

function increment(counts, key, microseconds) {
  let previous = 0;
  if (counts.has(key)) previous = counts.get(key);
  counts.set(key, previous + microseconds);
}

function ranked(counts, total, limit) {
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, microseconds]) => ({
      name,
      milliseconds: microseconds / 1000,
      percent: 100 * microseconds / total,
    }));
}

function allocationWrapper(name) {
  return name.includes("dlmalloc::") || name.includes("alloc::raw_vec::") ||
    name.includes("alloc::alloc::") || name.includes("__rust") ||
    name.includes("__rdl");
}

function summarize(path) {
  const bytes = readFileSync(path);
  const profile = JSON.parse(bytes);
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  const symbols = [
    ...new Set(profile.nodes.map((node) => node.callFrame.functionName)),
  ];
  const demangled = execFileSync("llvm-cxxfilt", ["--format=rust"], {
    input: `${symbols.join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd().split("\n");
  assert.equal(symbols.length, demangled.length);
  const names = new Map(symbols.map((name, index) => [name, demangled[index]]));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    if (node.children === undefined) continue;
    for (const child of node.children) {
      assert(!parents.has(child), "CPU profile nodes must form a tree");
      parents.set(child, node.id);
    }
  }
  const stacks = new Map();
  for (const node of profile.nodes) {
    const stack = [];
    let current = node.id;
    while (current !== undefined) {
      stack.push(names.get(nodes.get(current).callFrame.functionName));
      current = parents.get(current);
    }
    const boundaryIndex = stack.indexOf(boundary);
    if (boundaryIndex >= 0) {
      stacks.set(node.id, stack.slice(0, boundaryIndex + 1));
    }
  }

  const self = new Map();
  const inclusive = new Map();
  const allocationCallers = new Map();
  const focused = new Map();
  for (const [label] of focus) {
    focused.set(label, { total: 0, insideEvaluation: 0, callers: new Map() });
  }
  const specializationParts = new Map();
  let total = 0;
  let sampleCount = 0;
  let allocationSelf = 0;
  let lifetimeSelf = 0;
  let hashingSelf = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const delta = profile.timeDeltas[index];
    assert(delta >= 0, "Negative CPU sample duration");
    const stack = stacks.get(profile.samples[index]);
    if (stack === undefined) continue;
    total += delta;
    sampleCount++;
    const leaf = stack[0];
    increment(self, leaf, delta);
    for (const name of new Set(stack)) increment(inclusive, name, delta);
    if (leaf.includes("dlmalloc::")) {
      allocationSelf += delta;
      const caller = stack.slice(1).find((name) => !allocationWrapper(name));
      assert(caller !== undefined, "Allocator sample has no caller");
      increment(allocationCallers, caller, delta);
    }
    if (
      leaf.includes("::drop_glue") || leaf.includes("::drop_slow") ||
      leaf.endsWith(" as core::clone::Clone>::clone") ||
      leaf.includes("::dying_next") || leaf.endsWith("::deallocate")
    ) {
      lifetimeSelf += delta;
    }
    if (leaf.includes("core::hash::") || leaf.includes("::hash_one::")) {
      hashingSelf += delta;
    }
    const insideEvaluation = stack.includes(focus.get("evaluation"));
    for (const [label, name] of focus) {
      // Use the outermost occurrence, so recursion is counted only once.
      const frame = stack.lastIndexOf(name);
      if (frame < 0) continue;
      const region = focused.get(label);
      region.total += delta;
      if (insideEvaluation) region.insideEvaluation += delta;
      if (frame + 1 < stack.length) {
        increment(region.callers, stack[frame + 1], delta);
      }
      if (label === "nested specialization") {
        const children = stack.slice(0, frame);
        let part = "outside closure inference and argument evaluation";
        if (
          children.includes(
            "<blot_compiler::typecheck::Checker>::infer_evaluated_closure",
          )
        ) {
          part = "closure inference";
        } else if (
          children.includes("<blot_compiler::typecheck::Checker>::evaluate")
        ) {
          part = "argument evaluation";
        }
        increment(specializationParts, part, delta);
      }
    }
  }
  assert(total > 0, `No samples below ${boundary}; use a named release build`);
  assert(
    ![...self.keys()].some((name) => /^wasm-function\[/.test(name)),
    "Unnamed Wasm functions",
  );
  return {
    profile: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    boundary,
    sampledCompileMs: total / 1000,
    compileSamples: sampleCount,
    wholeProfileMs: (profile.endTime - profile.startTime) / 1000,
    wholeProfileSamples: profile.samples.length,
    selfGroups: {
      allocatorMs: allocationSelf / 1000,
      cloneDropDeallocateMs: lifetimeSelf / 1000,
      hashMs: hashingSelf / 1000,
    },
    self: ranked(self, total, 40),
    inclusive: ranked(inclusive, total, 40),
    allocationCallers: ranked(allocationCallers, total, 20),
    focused: [...focused].map(([name, region]) => ({
      name,
      milliseconds: region.total / 1000,
      percent: 100 * region.total / total,
      insideEvaluationMs: region.insideEvaluation / 1000,
      callers: ranked(region.callers, total, 8),
    })),
    specializationParts: ranked(specializationParts, total, 3),
  };
}

console.log(JSON.stringify(
  {
    schema: 1,
    accounting:
      "Duration-weighted samples below the compile export only; inclusive rows overlap and recursion counts once. Setup, later warm analysis, teardown, and samples without that ancestor are excluded. Self groups classify leaf functions only and omit inlined work.",
    profiles: paths.map(summarize),
  },
  null,
  2,
));
