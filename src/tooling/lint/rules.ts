import type { LintRule } from "./types.ts";
import { booleanIdentityConditional } from "./rules/boolean_identity_conditional.ts";
import { discardedBooleanCase } from "./rules/discarded_boolean_case.ts";
import { emptyArrayAppend } from "./rules/empty_array_append.ts";
import { equalityCase } from "./rules/equality_case.ts";
import { equalityIfChain } from "./rules/equality_if_chain.ts";
import { guardShapedCase } from "./rules/guard_shaped_case.ts";
import { identicalConditionalBranches } from "./rules/identical_conditional_branches.ts";
import { nestedIfChain } from "./rules/nested_if_chain.ts";
import { nestedCaseChain } from "./rules/nested_case_chain.ts";
import { noopRebinding } from "./rules/noop_rebinding.ts";
import { operatorSpelling } from "./rules/operator_spelling.ts";
import { persistentArrayCopy } from "./rules/persistent_array_copy.ts";
import { provedArrayLookup } from "./rules/proved_array_lookup.ts";
import { quadraticArrayAppend } from "./rules/quadratic_array_append.ts";
import { specializationCount } from "./rules/specialization_count.ts";
import { singletonArrayAppend } from "./rules/singleton_array_append.ts";
import { unreachableCaseArm } from "./rules/unreachable_case_arm.ts";
import { unusedBinding } from "./rules/unused_binding.ts";
import { unusedEffectResult } from "./rules/unused_effect_result.ts";

export const DEFAULT_LINT_RULES: readonly LintRule[] = [
  unusedBinding,
  unusedEffectResult,
  discardedBooleanCase,
  noopRebinding,
  unreachableCaseArm,
  nestedCaseChain,
  equalityCase,
  equalityIfChain,
  nestedIfChain,
  identicalConditionalBranches,
  booleanIdentityConditional,
  guardShapedCase,
  quadraticArrayAppend,
  singletonArrayAppend,
  emptyArrayAppend,
  persistentArrayCopy,
  provedArrayLookup,
  operatorSpelling,
  specializationCount,
];
