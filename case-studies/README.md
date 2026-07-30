# Case studies

These are small programs with real host boundaries, not additions to the
language's feature catalog. Each program declares every authority it uses as a
host effect and compiles through gpufuck to the stable Blot Core Wasm ABI.

Run them from the repository root. A WebGPU adapter is required because the
compiler itself runs on the GPU:

```bash
WGPU_BACKENDS=vulkan deno task case-study grep "@text.contains" LANGUAGE.md
WGPU_BACKENDS=vulkan deno task case-study terminal
WGPU_BACKENDS=vulkan deno task case-study agent
```

## grep

`grep/main.blot` owns matching, iteration, output selection, and the exit count.
The runner owns argument parsing and file access. It grants only four
operations: obtain the pattern, obtain the number of lines, read one line, and
write one matching line. No filesystem handle or path is visible inside blot.

The program returns the number of matching lines. The runner follows grep's
useful exit convention: zero when at least one line matched and one when none
did.

## terminal

`terminal/main.blot` asks for a name and prints a greeting. Its whole interface
is the `Terminal` effect:

```text
read_line : () -> Text
write     : Text -> ()
```

An empty line is treated as an anonymous answer. A richer terminal program
should return an `Option Text` so end-of-input and an intentionally empty line
remain distinct.

## agent

`agent/main.blot` owns the conversation loop and transcript. The host grants a
terminal and a synchronous `Model.complete` operation. The bundled model adapter
is deterministic so the study runs without credentials or network access.

This case deliberately exposes the next ABI question: Core ABI 1 calls host
effects synchronously, while network model APIs are asynchronous. A production
agent therefore needs either a synchronous local model bridge or a future
suspending host-effect ABI; the case study does not disguise that mismatch with
an ambient network call.
