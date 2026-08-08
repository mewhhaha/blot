import type { LintRule } from "./types.ts";
import { equalityIfChain } from "./rules/equality_if_chain.ts";
import { guardShapedCase } from "./rules/guard_shaped_case.ts";
import { nestedIfChain } from "./rules/nested_if_chain.ts";
import { noopRebinding } from "./rules/noop_rebinding.ts";
import { operatorSpelling } from "./rules/operator_spelling.ts";
import { persistentArrayCopy } from "./rules/persistent_array_copy.ts";
import { provedArrayLookup } from "./rules/proved_array_lookup.ts";
import { quadraticArrayAppend } from "./rules/quadratic_array_append.ts";
import { specializationCount } from "./rules/specialization_count.ts";
import { unreachableCaseArm } from "./rules/unreachable_case_arm.ts";
import { unusedBinding } from "./rules/unused_binding.ts";
import { unusedEffectResult } from "./rules/unused_effect_result.ts";

export const DEFAULT_LINT_RULES: readonly LintRule[] = [
  unusedBinding,
  unusedEffectResult,
  noopRebinding,
  unreachableCaseArm,
  equalityIfChain,
  nestedIfChain,
  guardShapedCase,
  quadraticArrayAppend,
  persistentArrayCopy,
  provedArrayLookup,
  operatorSpelling,
  specializationCount,
];
