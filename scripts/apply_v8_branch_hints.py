from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"{path}: expected {expected} occurrence(s), found {count}: {old[:120]!r}"
        )
    file.write_text(text.replace(old, new))


replace_exact(
    "compiler/Cargo.toml",
    'wasm-encoder = "=0.255.0"\n',
    'wasm-encoder = "=0.255.0"\n'
    'wasmparser = { version = "=0.255.0", default-features = false }\n',
)

replace_exact(
    "compiler/src/backend.rs",
    "use wasm_encoder::{\n"
    "    BlockType, CodeSection, ConstExpr, CustomSection, DataSection, EntityType, ExportKind,\n"
    "    ExportSection, Function, FunctionSection, GlobalSection, GlobalType, Ieee32, Ieee64,\n"
    "    ImportSection, InstructionSink, MemorySection, MemoryType, Module, TypeSection, ValType,\n"
    "};\n",
    "use wasm_encoder::{\n"
    "    BlockType, BranchHint, BranchHints, CodeSection, ConstExpr, CustomSection, DataSection,\n"
    "    EntityType, ExportKind, ExportSection, Function, FunctionSection, GlobalSection,\n"
    "    GlobalType, Ieee32, Ieee64, ImportSection, InstructionSink, MemorySection, MemoryType,\n"
    "    Module, TypeSection, ValType,\n"
    "};\n"
    "use wasmparser::{BinaryReader, FunctionBody, Operator};\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "    #[serde(rename = \"requiredFeatures\")]\n"
    "    required_features: Vec<&'static str>,\n"
    "    memory: &'static str,\n",
    "    #[serde(rename = \"requiredFeatures\")]\n"
    "    required_features: Vec<&'static str>,\n"
    "    #[serde(rename = \"optimizationFeatures\")]\n"
    "    optimization_features: Vec<&'static str>,\n"
    "    memory: &'static str,\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "            core_specification: \"3.0\",\n"
    "            required_features,\n"
    "            memory: \"memory32\",\n",
    "            core_specification: \"3.0\",\n"
    "            required_features,\n"
    "            optimization_features: vec![\"branch-hinting\"],\n"
    "            memory: \"memory32\",\n",
)

helper = r'''fn cold_trap_branch_hints(function: &Function) -> Result<Vec<BranchHint>, String> {
    let body = function.clone().into_raw_body();
    let operators = FunctionBody::new(BinaryReader::new(&body, 0))
        .get_operators_reader()
        .map_err(|error| format!("could not inspect emitted Wasm function: {error}"))?
        .into_iter_with_offsets()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("could not inspect emitted Wasm operator: {error}"))?;
    let mut hints = Vec::new();
    for pair in operators.windows(2) {
        if matches!(&pair[0].0, Operator::If { .. })
            && matches!(&pair[1].0, Operator::Unreachable)
        {
            let offset = u32::try_from(pair[0].1)
                .map_err(|_| "emitted Wasm function exceeds branch-hint offset space")?;
            hints.push(BranchHint {
                branch_func_offset: offset,
                branch_hint_value: 0,
            });
        }
    }
    Ok(hints)
}

fn append_code_function(
    code: &mut CodeSection,
    branch_hints: &mut BranchHints,
    function_index: u32,
    function: Function,
) -> Result<(), String> {
    let hints = cold_trap_branch_hints(&function)?;
    if !hints.is_empty() {
        branch_hints.function_hints(function_index, hints);
    }
    code.function(&function);
    Ok(())
}

'''
replace_exact(
    "compiler/src/backend.rs",
    "fn emit_dynamic_module(\n",
    helper + "fn emit_dynamic_module(\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "    let mut functions = FunctionSection::new();\n"
    "    let mut code = CodeSection::new();\n",
    "    let mut functions = FunctionSection::new();\n"
    "    let mut code = CodeSection::new();\n"
    "    let mut branch_hints = BranchHints::new();\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "    functions.function(realloc_type);\n"
    "    code.function(&realloc_function());\n",
    "    functions.function(realloc_type);\n"
    "    append_code_function(\n"
    "        &mut code,\n"
    "        &mut branch_hints,\n"
    "        realloc_index,\n"
    "        realloc_function(),\n"
    "    )?;\n",
)

for builder in [
    "text_compare_function()",
    "text_contains_function()",
    "utf8_validator_function()",
    "i64_to_text_function(realloc_index)",
]:
    replace_exact(
        "compiler/src/backend.rs",
        f"        functions.function(type_index);\n"
        f"        code.function(&{builder});\n"
        f"        Some(function_index)\n",
        f"        functions.function(type_index);\n"
        f"        append_code_function(\n"
        f"            &mut code,\n"
        f"            &mut branch_hints,\n"
        f"            function_index,\n"
        f"            {builder},\n"
        f"        )?;\n"
        f"        Some(function_index)\n",
    )

replace_exact(
    "compiler/src/backend.rs",
    "    for function in internal_functions {\n"
    "        code.function(&dynamic_internal_function(\n"
    "            module,\n"
    "            function,\n"
    "            manifest,\n"
    "            dynamic_helpers,\n"
    "            &text_offsets,\n"
    "            &runtime_function_indices,\n"
    "        )?);\n"
    "    }\n",
    "    for function in internal_functions {\n"
    "        let function_index = *runtime_function_indices.get(&function.id).ok_or_else(|| {\n"
    "            format!(\n"
    "                \"{}: runtime function {} has no emitted function index\",\n"
    "                module.source, function.id\n"
    "            )\n"
    "        })?;\n"
    "        append_code_function(\n"
    "            &mut code,\n"
    "            &mut branch_hints,\n"
    "            function_index,\n"
    "            dynamic_internal_function(\n"
    "                module,\n"
    "                function,\n"
    "                manifest,\n"
    "                dynamic_helpers,\n"
    "                &text_offsets,\n"
    "                &runtime_function_indices,\n"
    "            )?,\n"
    "        )?;\n"
    "    }\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "        functions.function(type_index);\n"
    "        code.function(&dynamic_export_function(\n"
    "            module,\n"
    "            runtime_function,\n"
    "            manifest,\n"
    "            PublicExport {\n"
    "                parameter_types: &public_function.parameters,\n"
    "                parameter_runtime_types: &signature.parameters,\n"
    "                result_type: result,\n"
    "                result_runtime_type: signature.result,\n"
    "                call_id: export_ordinal as u32 + 1,\n"
    "            },\n"
    "            dynamic_helpers,\n"
    "            &text_offsets,\n"
    "            &runtime_function_indices,\n"
    "        )?);\n",
    "        functions.function(type_index);\n"
    "        append_code_function(\n"
    "            &mut code,\n"
    "            &mut branch_hints,\n"
    "            function_index,\n"
    "            dynamic_export_function(\n"
    "                module,\n"
    "                runtime_function,\n"
    "                manifest,\n"
    "                PublicExport {\n"
    "                    parameter_types: &public_function.parameters,\n"
    "                    parameter_runtime_types: &signature.parameters,\n"
    "                    result_type: result,\n"
    "                    result_runtime_type: signature.result,\n"
    "                    call_id: export_ordinal as u32 + 1,\n"
    "                },\n"
    "                dynamic_helpers,\n"
    "                &text_offsets,\n"
    "                &runtime_function_indices,\n"
    "            )?,\n"
    "        )?;\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "            functions.function(post_type);\n"
    "            code.function(&post_return_function(export_ordinal as u32 + 1));\n"
    "            function_exports.push((post_return.clone(), post_index));\n",
    "            functions.function(post_type);\n"
    "            append_code_function(\n"
    "                &mut code,\n"
    "                &mut branch_hints,\n"
    "                post_index,\n"
    "                post_return_function(export_ordinal as u32 + 1),\n"
    "            )?;\n"
    "            function_exports.push((post_return.clone(), post_index));\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "    wasm.section(&functions)\n"
    "        .section(&memories)\n"
    "        .section(&globals)\n"
    "        .section(&exports)\n"
    "        .section(&code);\n",
    "    wasm.section(&functions)\n"
    "        .section(&memories)\n"
    "        .section(&globals)\n"
    "        .section(&exports);\n"
    "    if !branch_hints.is_empty() {\n"
    "        wasm.section(&branch_hints);\n"
    "    }\n"
    "    wasm.section(&code);\n",
)

replace_exact(
    "compiler/src/backend.rs",
    "mod tests {\n"
    "    use super::*;\n"
    "    use crate::hir::{RuntimeBlock, RuntimeBlockParameter, RuntimeSpan};\n\n",
    "mod tests {\n"
    "    use super::*;\n"
    "    use crate::hir::{RuntimeBlock, RuntimeBlockParameter, RuntimeSpan};\n\n"
    "    #[test]\n"
    "    fn immediate_trap_branches_receive_false_hints() {\n"
    "        let mut function = Function::new(Vec::new());\n"
    "        function\n"
    "            .instructions()\n"
    "            .i32_const(0)\n"
    "            .if_(BlockType::Empty)\n"
    "            .unreachable()\n"
    "            .end()\n"
    "            .end();\n\n"
    "        let hints = cold_trap_branch_hints(&function).expect(\"trap branch should parse\");\n"
    "        assert_eq!(hints.len(), 1);\n"
    "        assert_eq!(hints[0].branch_hint_value, 0);\n"
    "        assert!(hints[0].branch_func_offset > 0);\n"
    "    }\n\n"
    "    #[test]\n"
    "    fn ordinary_branches_do_not_receive_speculative_hints() {\n"
    "        let mut function = Function::new(Vec::new());\n"
    "        function\n"
    "            .instructions()\n"
    "            .i32_const(0)\n"
    "            .if_(BlockType::Empty)\n"
    "            .nop()\n"
    "            .end()\n"
    "            .end();\n\n"
    "        let hints = cold_trap_branch_hints(&function).expect(\"ordinary branch should parse\");\n"
    "        assert!(hints.is_empty());\n"
    "    }\n\n",
)

Path("src/node/v8_wasm.test.ts").write_text(
    '''import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";

interface TargetManifest {
  readonly abi: {
    readonly coreSpecification: string;
    readonly requiredFeatures: readonly string[];
    readonly optimizationFeatures: readonly string[];
  };
}

test("V8 executes the Wasm 3 target and consumes branch metadata", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      resolve(
        "experiments/generated-code/programs/mutual_tail_recursion.blot",
      ),
    );
    const bytes = Uint8Array.from(artifact.wasm);
    assert.equal(WebAssembly.validate(bytes), true);

    const manifest = JSON.parse(
      new TextDecoder().decode(artifact.manifestBytes),
    ) as TargetManifest;
    assert.equal(manifest.abi.coreSpecification, "3.0");
    assert.ok(manifest.abi.requiredFeatures.includes("bulk-memory"));
    assert.ok(manifest.abi.requiredFeatures.includes("tail-call"));
    assert.ok(
      manifest.abi.optimizationFeatures.includes("branch-hinting"),
    );

    const module = await WebAssembly.compile(bytes);
    const branchHints = WebAssembly.Module.customSections(
      module,
      "metadata.code.branch_hint",
    );
    assert.equal(branchHints.length, 1);
    assert.ok(branchHints[0].byteLength > 0);

    const instance = await WebAssembly.instantiate(module);
    const isEven = instance.exports["blot:is_even"] as
      | ((remaining: bigint) => bigint)
      | undefined;
    assert.equal(typeof isEven, "function");
    if (isEven === undefined) {
      throw new Error("mutual-tail-recursion artifact omitted blot:is_even");
    }
    assert.equal(isEven(250_000n), 1n);
    assert.equal(isEven(250_001n), 0n);
  } finally {
    compiler.destroy();
  }
});
'''
)

Path("docs/wasm-target-profile.md").write_text(
    '''# V8 and WebAssembly 3.0 target profile

## Status

Blot's production target is standard WebAssembly 3.0, tested on V8 through the
current Node LTS and Current release lines. Core Wasm ABI 1 remains memory32.
This document records target selection and implementation status; semantic and
byte-level authority remain in `spec/RUNTIME.md` and `docs/abi.md`.

The similarly named `wasm3` project is an interpreter, not the WebAssembly 3.0
specification. Its current feature set is substantially smaller than the V8
profile. Blot reports exact required features so a host can reject an artifact
before attempting execution.

## Emitted feature contract

The ABI manifest separates semantic requirements from ignorable optimization
metadata:

```json
{
  "abi": {
    "coreSpecification": "3.0",
    "requiredFeatures": ["bulk-memory", "tail-call"],
    "optimizationFeatures": ["branch-hinting"]
  }
}
```

Both lists are sorted and artifact-specific. `requiredFeatures` names instructions
or validation rules needed to execute the artifact. `optimizationFeatures` names
standardized metadata that an engine may ignore without changing behavior.
`WebAssembly.validate` remains authoritative for a concrete engine.

| Feature                       | Current policy                                                        | Reason                                                                                 |
| ----------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| bulk memory                   | always emitted                                                        | `cabi_realloc` and persistent copies use `memory.copy`                                 |
| multi-value                   | internal, when needed                                                 | removes tuple result records and reloads                                               |
| fixed SIMD                    | emitted for supported vector source operations                        | preserves the existing deterministic vector semantics                                  |
| tail calls                    | exact internal direct tail position, including empty forwarding joins | removes recursive frames and call-result local traffic                                 |
| branch hinting                | cold immediate-trap branches                                          | improves V8 layout/register decisions without changing validation or observations      |
| typed references / `call_ref` | deferred                                                              | residual known choices already become direct calls; open closures are refused          |
| GC / JS string builtins       | separate future V8 profile                                            | can remove Text/runtime work but replaces Store and ABI representation proofs          |
| memory64                      | deferred                                                              | ABI 1 is memory32 and current programs gain no offset-space benefit                    |
| multiple memories             | deferred                                                              | no measured benefit yet; complicates canonical adapters and interpreter portability    |
| exception handling / JSPI     | separate future async profile                                         | Blot effects are resumable and ABI 1 host calls are synchronous                        |
| relaxed SIMD                  | deferred                                                              | relaxed/FMA instructions can change deterministic floating-point results               |

## Branch-hint lowering

The emitter scans each completed function body and adds a standardized
`metadata.code.branch_hint` entry only for this exact instruction shape:

```text
condition
if
  unreachable
end
```

The hint value is `0`: the trapping branch is expected not to be taken. This
covers allocator overflow, malformed ABI input, ownership protocol misuse, UTF-8
failure, and other defensive checks already represented as immediate traps.
Ordinary source conditionals and non-trapping control flow receive no guessed
probability.

The custom section appears once and before the code section, as required by the
branch-hinting proposal. Removing the section produces the same source and ABI
observations. An engine that ignores the section remains compatible; a V8 engine
may use it for code layout and register allocation.

## Tail-call lowering

For an internal Runtime-HIR block:

```text
r = call.direct f(args)
return r
```

lowering emits `return_call f` only when the call is the final operation and its
result reaches the function return directly or through a cycle-free chain of
empty forwarding blocks. Target, caller, argument, and result layouts must agree.
Any intervening operation, condition, trap, or cycle disables the optimization.

The optimization applies to self recursion and mutual recursion. It does not
apply across a public export wrapper because that wrapper must execute allocation
checkpoint restoration, canonical lowering, and post-return bookkeeping.

Tail calls remove caller frames from target stack traces. Stack traces are not a
Blot source observation, so this target difference is admissible and is recorded
for debugging tools.

## V8 matrix

CI performs the dedicated target test without experimental flags on:

- Node 24.19.0 LTS; and
- Node 26.7.0 Current.

The test validates the module, checks required and optimization feature metadata,
confirms the branch-hint custom section is present, instantiates it, and executes
250,000 recursive tail calls. Failure to emit `return_call` would ordinarily
exhaust the Wasm stack long before completion.

These runs establish unflagged validation and execution for the emitted profile.
They are compatibility tests, not a claim that a particular optimization tier
must use every hint.

## wasm3 interpreter boundary

The wasm3 interpreter's current README reports:

- multi-value support;
- partial bulk-memory support;
- multiple memories and reference types as work in progress; and
- no tail-call optimization, fixed-width SIMD, exception handling, or stack
  switching.

Therefore current Blot artifacts are not generally wasm3-interpreter compatible.
An artifact requiring `tail-call` or `simd` must be rejected by that host. Branch
hints do not add an incompatibility because they are carried in an ignorable
custom section.

A future wasm3-compatible target profile would have to suppress unsupported
instructions, define the performance consequences explicitly, and run wasm3 in
CI. Blot does not silently replace `return_call` with ordinary recursion because
that would remove the constant-target-stack guarantee advertised by the current
V8 profile.

## Admission rule for further features

A modern Wasm feature is adopted when all of these hold:

1. the source observation and determinism effect is explicit;
2. Runtime HIR and validation record the required premise;
3. the ABI and ownership consequences are specified;
4. the manifest distinguishes required behavior from optional metadata;
5. V8 execution and a fallback or refusal path are tested; and
6. benchmark evidence shows material work reduction or performance improvement.

This rule admits branch hints because they are standardized, semantically
ignorable, automatically derivable from cold traps, and supported by the V8
matrix. It defers representation-changing features until their larger benefit
justifies a separate target and ABI proof.
'''
)

Path("docs/v8-wasm3-feature-audit.md").write_text(
    '''# V8 and WebAssembly 3 feature audit

## Scope

This audit follows the initial WebAssembly 3 target work. It asks which modern
features materially reduce Blot compiler work or improve emitted-code performance
without weakening source semantics, ABI 1, ownership evidence, or engine
compatibility.

The review used the WebAssembly feature-status table, proposal specifications,
current V8 feature declarations, wasm-tools support, the wasm3 interpreter's
published matrix, and Blot's Runtime HIR/backend.

## Decision matrix

| Feature | Expected payoff for Blot | Integration cost/risk | Decision |
| --- | --- | --- | --- |
| tail calls | removes recursive target frames and call-result traffic | low after direct-call specialization | already adopted |
| branch hinting | better cold-path layout and register allocation in V8 | low; standardized custom metadata | adopt now |
| bulk memory | replaces byte-copy loops | low and already required by allocator | retain |
| multi-value | avoids private result records and reloads | low and already emitted when needed | retain |
| fixed SIMD | native vector arithmetic | already represented with deterministic semantics | retain |
| typed function references / `call_ref` | can reduce defunctionalized dynamic dispatch | high until Runtime HIR has residual dynamic calls | defer |
| Wasm GC | can remove parts of manual object management | very high; conflicts with Store/root and ABI proofs | separate profile |
| JS string builtins / imported strings | can remove UTF-8 copies for V8-hosted Text | high; changes Text representation and caller contract | separate V8 profile |
| memory64 | larger address space | no current workload benefit; ABI is memory32 | defer |
| multiple memories | possible heap/static isolation | no measured win; complicates adapters | defer |
| exception handling | cheaper catchable control in some languages | mismatches Blot resumable effects and source traps | defer |
| JSPI / stack switching | simpler asynchronous host integration | requires a new async host protocol | separate profile |
| relaxed SIMD | possible fused/target-specific vector speedups | changes rounding/NaN determinism | defer |

## Adopted follow-up: cold trap hints

Blot already emits defensive conditions whose taken branch immediately executes
`unreachable`. Those branches represent malformed inputs, arithmetic/extent
overflow, impossible ownership states, and compiler-proved invariant guards.
Their normal execution probability is expected to be low by construction.

The backend now derives branch hints from the completed encoded function rather
than duplicating source or Runtime-HIR analysis. Only `if` immediately followed
by `unreachable` receives a likely-false hint. This keeps the optimization
conservative and prevents profile-guided guesses from becoming semantic facts.

The section is optional metadata. Removing it or running on an engine that ignores
it preserves validation and execution behavior. The manifest reports it under
`optimizationFeatures`, not `requiredFeatures`.

## V8 and wasm3 conclusions

V8 is the production performance target and is tested through current Node LTS
and Current lines. The standardized branch-hinting proposal is supported in
current V8-class engines and is designed to improve code layout and register
allocation.

The wasm3 interpreter is not synonymous with WebAssembly 3.0. Its published
feature matrix currently lacks tail calls and fixed SIMD and has only partial
bulk-memory support. Blot therefore treats wasm3 as a possible future restricted
profile, not as evidence that every WebAssembly 3 artifact is portable to that
interpreter.

## Next high-value experiment

The next feature with potentially large work reduction is a separate V8 Text
profile using standardized JS string integration. It could avoid repeated
UTF-8 lifting/lowering and some linear-memory allocation, but it changes the
representation relation and host contract. It should be benchmarked as a new
profile rather than mixed silently into Core Wasm ABI 1.

Typed function references become worthwhile only after Runtime HIR admits a real
residual dynamic-call representation. Until then direct calls are smaller,
easier to validate, and easier for V8 to optimize.
'''
)

replace_exact(
    "spec/RUNTIME.md",
    "Every manifest declares:\n\n"
    "```text\n"
    "coreSpecification = \"3.0\"\n"
    "requiredFeatures   = sorted exact feature names used by this artifact\n"
    "```\n\n"
    "The current emitter may require `bulk-memory`, `multi-value`, fixed-width\n"
    "`simd`, and `tail-call`. A host must validate the complete module and may use\n"
    "the feature list for an earlier compatibility diagnostic. The feature list is\n"
    "descriptive; it never substitutes for WebAssembly validation.\n",
    "Every manifest declares:\n\n"
    "```text\n"
    "coreSpecification    = \"3.0\"\n"
    "requiredFeatures     = sorted exact validation features used by this artifact\n"
    "optimizationFeatures = sorted semantically ignorable metadata emitted\n"
    "```\n\n"
    "The current emitter may require `bulk-memory`, `multi-value`, fixed-width\n"
    "`simd`, and `tail-call`. It may additionally emit standardized\n"
    "`branch-hinting` metadata. A host must validate the complete module and may\n"
    "use the required-feature list for an earlier compatibility diagnostic. An\n"
    "optimization feature can be ignored without changing source or ABI behavior;\n"
    "neither list substitutes for WebAssembly validation.\n",
)

replace_exact(
    "spec/RUNTIME.md",
    "A defensive internal check may remain only with proof that related validated\n"
    "states cannot reach it. Reaching one is an `InvariantFailure`, not a third class\n"
    "of permitted target trap.\n\n"
    "Integer arithmetic, memory operations, and host calls use the source or ABI\n",
    "A defensive internal check may remain only with proof that related validated\n"
    "states cannot reach it. Reaching one is an `InvariantFailure`, not a third class\n"
    "of permitted target trap.\n\n"
    "The emitter may mark an `if` as likely false when its taken arm immediately\n"
    "executes `unreachable`. This branch hint is target metadata, not a source fact\n"
    "or validator premise. Removing it or ignoring it preserves the module's\n"
    "observations. Ordinary conditionals and non-trapping branches receive no\n"
    "synthetic probability.\n\n"
    "Integer arithmetic, memory operations, and host calls use the source or ABI\n",
)

replace_exact(
    "docs/abi.md",
    "- ABI major and minor;\n"
    "- memory, encoding, flattening limits, and allocator export;\n",
    "- ABI major and minor;\n"
    "- required validation features and optional optimization metadata;\n"
    "- memory, encoding, flattening limits, and allocator export;\n",
)

if "tail-call optimization as ready" in Path("docs/wasm-target-profile.md").read_text():
    raise SystemExit("docs/wasm-target-profile.md: stale wasm3 tail-call claim remains")
