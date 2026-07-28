// Surface -> Wasm, through gpufuck.
//
// This is the one place blot touches a device outside the parser's throughput
// path, and it is deliberately the last stage: `blot check` infers, checks
// ownership, and reports everything it can without a WebGPU adapter existing.

import {
  buildSurfaceModule,
  compileModuleToWasm,
  EvaluationProfile,
  GpuCompiler,
  GpuEvaluator,
  requestWebGpuDevice,
} from "gpufuck";
import { BlotError } from "../diagnostic.ts";
import { load } from "../load.ts";
import { checkFile } from "../check/mod.ts";
import { lowerModule } from "./lower.ts";

export interface Built {
  readonly wasm: Uint8Array;
  /** What gpufuck's own evaluator produced, as a cross-check on the lowering. */
  readonly value: unknown;
}

export async function build(path: string): Promise<Built> {
  const loaded = await load(path);
  // Checking first is not politeness: lowering consumes the field and
  // constructor sets inference recorded, and cannot proceed without them.
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  const lowered = lowerModule(loaded.module, checked, checked.values);

  const module = buildSurfaceModule(
    lowered.definitions,
    lowered.types,
    lowered.entry,
    loaded.source.length,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuCompiler.create(device);
    const compilation = await compiler.compileModule(module);
    if (!compilation.ok) {
      const [first] = compilation.diagnostics;
      // gpufuck re-runs Hindley-Milner on what blot emits. blot's own
      // algebraic-subtyping result is the authority, so a failure here is a
      // lowering bug rather than a disagreement to be resolved in gpufuck's
      // favour — the message says so, because the alternative is a bug report
      // filed against the wrong project.
      throw new BlotError({
        code: "BLOT_LOWERING_BUG",
        message:
          `gpufuck rejected the lowered module: ${first.code}: ${first.message}. blot accepted this program, so the lowering is wrong.`,
        span: loaded.module.span,
      });
    }

    try {
      // Evaluating is a cross-check on the lowering, not part of building. Some
      // values — text among them — cannot cross the evaluator's boundary, and
      // that says nothing about whether the module compiles.
      let value: unknown = null;
      try {
        const evaluator = await GpuEvaluator.create(device);
        const execution = await evaluator.evaluate(compilation.module);
        value = execution.ok ? execution.value : execution.fault;
      } catch (error) {
        value = {
          unavailable: error instanceof Error ? error.message : String(error),
        };
      }
      const wasm = await compileModuleToWasm(compilation.module);
      return { wasm, value };
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
}
