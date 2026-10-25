# Goose to WebAssembly

This toolchain compiles [Goose](https://github.com/aardappel/goose) programs
into an executable `.wasm` module and its `.mjs` host. It uses the complete
upstream Goose parser, type checker, specialization, optimizer, bounds-check
elimination, standard library, and C generator, with a checked WebAssembly
runtime.

The compiler runs on the build machine. The programs it produces run as
WebAssembly in Node or an Emscripten-compatible browser host. The generated
module uses the Emscripten host ABI; it is not a standalone WASI executable.

Goose has its own `.goose` syntax and semantics. This directory is an
independent toolchain in the Blot repository; Blot's Rust compiler, Baba
frontend, Runtime HIR, package entry points, and Core Wasm ABI continue to
define `.blot` programs.

## Build

Requirements: Python 3.10+, Git, CMake 3.27+, a C++20 compiler, and Emscripten
**6.0.13**. Node 22.16+ runs the default output. Use Node 24+ or another engine
with memory64 enabled for the optional `--memory64` mode. Linux is the host
qualified by this toolchain's CI.

From the repository root, build the native compiler:

```sh
python3 tools/goose-wasm/bootstrap.py
```

The bootstrap fetches exactly
[`2e2bedef5b980bf013cac5aaa0095bfea64e5569`](https://github.com/aardappel/goose/tree/2e2bedef5b980bf013cac5aaa0095bfea64e5569),
applies the versioned patch, regenerates the embedded runtime, builds Goose, and
installs the compiler, standard library, C interop header, TinyCC runtime, and
notices into `build/goose-wasm/bin/`. The source, patch, runtime, and compiler
identities are recorded in `build/goose-wasm/toolchain.json`.

An existing local Goose clone can supply the immutable commit without network
access:

```sh
python3 tools/goose-wasm/bootstrap.py --source-repo /path/to/goose
```

An unchanged setup can be rebuilt in place. If the pin or patch changes, use a
fresh `--build-dir`; bootstrap refuses to overwrite local source edits or
silently reuse a compiler from different inputs.

Install the matching SDK if it is not already available:

```sh
git clone https://github.com/emscripten-core/emsdk.git build/emsdk
git -C build/emsdk checkout d7b4130688bfa348392b921ab04015aa15c4f154
build/emsdk/emsdk install 6.0.13
build/emsdk/emsdk activate 6.0.13
. build/emsdk/emsdk_env.sh
```

The driver checks the SDK version. Toolchain installation and source fetching
are setup operations; compiling an already available source graph needs no
network. Use `--offline` to make Goose reject imports whose packages have not
been fetched.

## Compile and run

```sh
python3 tools/goose-wasm/goose_wasm.py build \
  tools/goose-wasm/examples/stable_tree.goose -o build/stable-tree.mjs
node build/stable-tree.mjs
```

The example grows a linked data structure, keeps a reference alive across 4,095
pushes, serializes it, validates the serialized image, and traverses the
restored relative links. It prints:

```text
nodes=4096 first=42 sum=8386602
```

Keep the generated `.mjs` and `.wasm` together. Arguments after the module name
become the Goose program's arguments, and stdin/stdout/stderr use the Node
process streams.

Type checking includes target compatibility checks:

```sh
python3 tools/goose-wasm/goose_wasm.py check program.goose
python3 tools/goose-wasm/goose_wasm.py build program.goose \
  -o build/program.mjs -O0 --debug --stack-size 32M --emit-c build/program.c
```

`-O0`, `-O1`, and `-O2` select both Goose and C optimization; `-O2` is the
default. `--debug` adds Goose's checked arithmetic and conversion behavior.
Data-stack capacity checks run in every optimization and debug configuration.

Use `--goose` and `--emcc` for explicit executables, or `--build-dir` to select
another bootstrap installation. `GOOSE_WASM_COMPILER` and `EMCC` provide the
equivalent environment overrides. `--stdlib` selects a standard-library tree.
Paths with spaces and Unicode are supported; subprocesses use argument arrays.

Failed source checks or links return a nonzero status and leave any previous
output pair in place. New output is staged and the executable is installed only
after compilation succeeds. `--emit-c` creates independently buildable
standalone C, with include paths relative to that file's destination.

## Memory and representation

Goose requires references to remain valid when arrays grow. Its native runtime
uses virtual address reservations and inaccessible guard pages. WebAssembly
linear memory has no such per-stack guards. This port allocates a fixed block
per data stack and checks capacity **before** writes and pointer advancement.
The block never moves. Exceeding a stack's capacity reports
`goose runtime error: data stack overflow` and exits nonzero.

| Setting             | Default | Meaning                                                          |
| ------------------- | ------- | ---------------------------------------------------------------- |
| `--stack-size`      | `16M`   | Usable capacity of each data stack; 64K to 1G, in 64K steps      |
| `--max-memory`      | `2G`    | Total linear-memory ceiling; 32M to 2G, in 64K steps             |
| `--call-stack-size` | `4M`    | C shadow stack; checked by Emscripten, separate from data stacks |

Capacities are committed as allocations in linear memory. A program with many
data stacks can reach its total memory limit before any individual stack fills.
Allocation failure is reported; the runtime does not silently reduce a requested
stack capacity. `trim_memory()` validates stack tops but cannot release a fixed
stack's unused interior pages. JavaScript engine call-stack exhaustion is an
engine exception, distinct from the checked C shadow stack.

The C generator's reference, slice, and serialized-data layouts use 64-bit
pointers. The default builds a 64-bit C data model and lowers memory operations
to wasm32 with Emscripten's `MEMORY64=2`. The result works on wasm32 engines
while retaining Goose's layouts. Compiling this C directly as ordinary 32-bit C
is rejected at compile time.

`MEMORY64=2` is deprecated by Emscripten and is retained in the pinned SDK.
`--memory64` uses its full memory64 mode instead, without the compatibility
lowering. The same capacity checks and 2 GiB driver ceiling apply. Changing the
SDK pin requires qualifying both modes; silently switching the C data model to
32 bits would corrupt Goose layouts.

## Host services and C interop

Core language features, generics, functions, algebraic data types, stable and
relative references, all array forms, pools, formatting, serialization, math,
and the source standard library use the same frontend as native Goose.

Filesystem operations use Emscripten's virtual filesystem. They do not
implicitly expose the host's working directory. Bundle input files with
`--preload-file local-file@/virtual-file`, or populate the exported `FS` API in
a browser/Node host. Preloaded files add a companion `.data` artifact, which
must be deployed alongside the module. File persistence, environment values,
clock resolution, sleeping, and resource paths follow Emscripten's host
semantics, rather than a native process's OS environment.

The generated ES module exports a factory. Importing it does not run main:

```js
import createProgram from "./program.mjs";

await createProgram({
  arguments: ["example"],
  print: (line) => console.log(line),
  printErr: (line) => console.error(line),
});
```

Serve the `.mjs`, `.wasm`, and optional `.data` files over HTTP for a browser.
To populate files before main, use a `preRun` callback and the provided module's
`FS`, or set `noInitialRun: true` and invoke its exported `callMain`. Each
factory call creates a separate module instance and memory.

Static C extern implementations can be compiled into the same Wasm module:

```sh
python3 tools/goose-wasm/goose_wasm.py build program.goose \
  -o build/program.mjs --c-source adapter.c --include adapter.h
```

Repeat `--c-source` or `--c-include-dir` for additional sources and header
directories. The patched `goose.h` is installed and supplied on the include
path; its builder append checks the same data-stack capacity before writing.
Extern C code remains responsible for following its declared ABI and memory
contract, as it does on native Goose.

The following platform capabilities are explicitly refused by the compiler's
WebAssembly target profile:

- Reachable thread spawning and typed queues, including imported helpers.
- Dynamic native-library extern bindings.
- Native package sidecar builds. Supply target-compatible C with `--c-source`.
- Automatically resolved native graphics, audio, UI, and physics packages.

These checks use parsed/resolved program information. Comments or string
literals containing feature names do not trigger them. No unsupported thread or
dynamic library is replaced with a silent stub. `hardware_threads()` is one.

## Validation

With the compiler built and Emscripten activated:

```sh
python3 tools/goose-wasm/tests/test_target.py
python3 tools/goose-wasm/tests/test_driver.py
python3 tools/goose-wasm/tests/run_tests.py --full
python3 tools/goose-wasm/tests/run_tests.py --quick --memory64 \
  --output-dir build/goose-wasm/memory64-results
```

The full qualification corpus runs 69 upstream fixtures, the linked-data
example, targeted 64 KiB boundary fixtures, static C/builder interop, and
source/target rejections. Programs run at both `-O0` and `-O2`. Supported
fixtures are checked against upstream expectations and native Goose output;
Wasm-specific overflows must terminate with a capacity diagnostic. The corpus is
a curated portability suite, not a claim that every upstream platform test has
run.

Coverage includes exact-capacity formatting, nested construction, variable
prefix growth, cached tops, `from_bytes`, relative links, reusable slice pools,
freelist allocation, size multiplication, and stdin/extern builders. Driver
tests exercise real output under Unicode/space paths, import without execution,
unavailable tools, incompatible SDKs, and failed-build preservation.

Each run writes machine-readable results plus per-case compiler/runtime logs
under `build/goose-wasm/`. The dedicated GitHub workflow runs the full suite,
checks memory64 and minimum-Node compatibility, and uploads the compiler,
patched upstream source, example output, and qualification reports. Binaries are
derived artifacts rather than committed files.

## Source provenance and maintenance

The CI compiler archive can be extracted and used with the same driver commands.
It includes the patched upstream source but omits Git internals. To rebuild an
extracted archive through bootstrap, choose a fresh `--build-dir`; its installed
compiler can be used directly without bootstrapping again.

[`upstream.json`](upstream.json) records the source and SDK pins.
[`patches/0001-webassembly-target.patch`](patches/0001-webassembly-target.patch)
contains the complete upstream changes. The generated `runtime_inline.h` is
rebuilt from the patched runtime and checked against Goose's own generator.

To update the port, check out the pinned Goose revision in a development clone,
apply the patch, make the source changes, and regenerate the patch with
`git diff --binary --full-index -- src ':!src/runtime_inline.h'`. Use a new
bootstrap build directory and run qualification. Keep generated runtime text and
build products out of the patch.

Goose's source and these modifications retain its
[Apache-2.0 license](GOOSE-LICENSE). New integration scripts and tests follow
the repository's [MIT license](../../LICENSE). Upstream's bundled TinyCC is
LGPL-2.1, and its shader/process libraries carry their own notices. Bootstrap
preserves those files, and CI includes the patched source needed to rebuild the
compiler. See the pinned upstream `third_party/` directories for the full
dependency provenance and licenses.

Relevant upstream references:

- [Goose WebAssembly design proposal](https://github.com/aardappel/goose/blob/2e2bedef5b980bf013cac5aaa0095bfea64e5569/docs/design/wasm.md)
- [Emscripten memory settings](https://emscripten.org/docs/tools_reference/settings_reference.html#memory64)
- [Emscripten SDK setup](https://emscripten.org/docs/getting_started/downloads.html)
