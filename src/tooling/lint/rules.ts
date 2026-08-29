import type { LintRule } from "./types.ts";
import { booleanIdentityConditional } from "./rules/boolean_identity_conditional.ts";
import { discardedBooleanCase } from "./rules/discarded_boolean_case.ts";
import { emptyArrayAppend } from "./rules/empty_array_append.ts";
import { emptyArraySpelling } from "./rules/empty_array_spelling.ts";
import { equalityCase } from "./rules/equality_case.ts";
import { equalityIfChain } from "./rules/equality_if_chain.ts";
import { guardShapedCase } from "./rules/guard_shaped_case.ts";
import { identicalConditionalBranches } from "./rules/identical_conditional_branches.ts";
import { largePositionalTuple } from "./rules/large_positional_tuple.ts";
import { nestedIfChain } from "./rules/nested_if_chain.ts";
import { nestedCaseChain } from "./rules/nested_case_chain.ts";
import { noopRebinding } from "./rules/noop_rebinding.ts";
import { openShadow } from "./rules/open_shadow.ts";
import { operatorSpelling } from "./rules/operator_spelling.ts";
import { persistentArrayCopy } from "./rules/persistent_array_copy.ts";
import { provedArrayLookup } from "./rules/proved_array_lookup.ts";
import { quadraticArrayAppend } from "./rules/quadratic_array_append.ts";
import { recordReconstruction } from "./rules/record_reconstruction.ts";
import { redundantDoBlock } from "./rules/redundant_do_block.ts";
import { redundantTerminalElse } from "./rules/redundant_terminal_else.ts";
import { specializationCount } from "./rules/specialization_count.ts";
import { singletonArrayAppend } from "./rules/singleton_array_append.ts";
import { stableShadowing } from "./rules/stable_shadowing.ts";
import { terminalEffectForwarding } from "./rules/terminal_effect_forwarding.ts";
import { unreachableCaseArm } from "./rules/unreachable_case_arm.ts";
import { unnecessaryRec } from "./rules/unnecessary_rec.ts";
import { unusedBinding } from "./rules/unused_binding.ts";
import { unusedEffectResult } from "./rules/unused_effect_result.ts";
import { unusedOpen } from "./rules/unused_open.ts";
import { unusedPatternName } from "./rules/unused_pattern_name.ts";

export const DEFAULT_LINT_RULES: readonly LintRule[] = [
  unusedBinding,
  unusedEffectResult,
  unusedPatternName,
  unusedOpen,
  openShadow,
  discardedBooleanCase,
  noopRebinding,
  stableShadowing,
  unnecessaryRec,
  unreachableCaseArm,
  nestedCaseChain,
  equalityCase,
  equalityIfChain,
  nestedIfChain,
  identicalConditionalBranches,
  booleanIdentityConditional,
  redundantTerminalElse,
  guardShapedCase,
  terminalEffectForwarding,
  redundantDoBlock,
  quadraticArrayAppend,
  singletonArrayAppend,
  emptyArrayAppend,
  emptyArraySpelling,
  recordReconstruction,
  persistentArrayCopy,
  provedArrayLookup,
  operatorSpelling,
  specializationCount,
  largePositionalTuple,
];
