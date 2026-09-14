import type { LintRule } from "./types.ts";
import { iteratorLoop } from "./rules/iterator_loop.ts";
import { complementaryFilters } from "./rules/complementary_filters.ts";
import { arrayFind } from "./rules/array_find.ts";
import { publicPrimitive } from "./rules/public_primitive.ts";
import { forwardingCallback } from "./rules/forwarding_callback.ts";
import {
  variantChaining,
  variantFallback,
  variantMap,
} from "./rules/variant_combinators.ts";
import { accumulatorFold } from "./rules/accumulator_fold.ts";
import { fieldShorthand } from "./rules/field_shorthand.ts";
import { projectionDestructuring } from "./rules/projection_destructuring.ts";
import { parameterDestructuring } from "./rules/parameter_destructuring.ts";
import { terminalValueForwarding } from "./rules/terminal_value_forwarding.ts";
import { identityVariantCase } from "./rules/identity_variant_case.ts";
import { identityHandlerReturn } from "./rules/identity_handler_return.ts";
import { selectiveOpen } from "./rules/selective_open.ts";
import { localOpen } from "./rules/local_open.ts";
import { handlerPipeline } from "./rules/handler_pipeline.ts";
import { terminalContinue } from "./rules/terminal_continue.ts";
import { filteringLoopPattern } from "./rules/filtering_loop_pattern.ts";
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
  iteratorLoop,
  complementaryFilters,
  arrayFind,
  publicPrimitive,
  forwardingCallback,
  variantMap,
  variantChaining,
  variantFallback,
  accumulatorFold,
  fieldShorthand,
  projectionDestructuring,
  parameterDestructuring,
  terminalValueForwarding,
  identityVariantCase,
  identityHandlerReturn,
  selectiveOpen,
  localOpen,
  handlerPipeline,
  terminalContinue,
  filteringLoopPattern,
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
