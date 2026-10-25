#!/usr/bin/env python3
"""Qualify the Goose WebAssembly target with emitted programs, not snapshots.

The quick corpus covers the major language/runtime paths. --full adds the
curated cases in corpus.json; it does not claim to run all upstream tests.
Every portable corpus program is compared with its upstream expected output
and the compiler's native TinyCC execution at the same optimization level.
The local fixtures pressure the target's fixed-partition safety boundary.

Logs and a machine-readable report are retained under the output directory.
There are no network operations and no automatically skipped failures.
"""

import argparse
import concurrent.futures
import dataclasses
import difflib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parent
TOOL = HERE.parent
REPO = TOOL.parents[1]
CAPACITY = 65536


@dataclasses.dataclass(frozen=True)
class Case:
    name: str
    source: Path
    stdout: str = ""
    stderr: tuple = ()
    aborts: bool = False
    reject: bool = False
    debug: bool = False
    stack_size: int = 16 * 1024 * 1024
    stdin: str = ""
    native: bool = True
    c_sources: tuple = ()


def normalized(value):
    return value.replace("\r\n", "\n").rstrip("\n")


def unsigned_leb(data, position):
    value = 0
    shift = 0
    while position < len(data) and shift < 70:
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
        shift += 7
    raise AssertionError("malformed WebAssembly unsigned LEB128")


def assert_wasm_memory(data, memory64):
    if data[:8] != b"\x00asm\x01\x00\x00\x00":
        raise AssertionError("output does not have a WebAssembly binary header")
    position = 8
    while position < len(data):
        section = data[position]
        size, payload = unsigned_leb(data, position + 1)
        end = payload + size
        if end > len(data):
            raise AssertionError("truncated WebAssembly section")
        if section == 5:
            count, cursor = unsigned_leb(data, payload)
            if count != 1:
                raise AssertionError("target must define exactly one linear memory")
            flags, _ = unsigned_leb(data, cursor)
            if bool(flags & 4) != memory64:
                raise AssertionError("linear-memory address width does not match the selected target")
            if flags & 2:
                raise AssertionError("single-thread target unexpectedly emitted shared memory")
            return
        position = end
    raise AssertionError("output has no defined linear memory")


def command(cmd, cwd, timeout, prefix, stdin=""):
    env = os.environ.copy()
    env["GOOSE_HOME"] = str(cwd / "goose-home")
    started = time.monotonic()
    result = subprocess.run(
        [str(arg) for arg in cmd],
        cwd=cwd,
        env=env,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    (cwd / (prefix + ".command.json")).write_text(
        json.dumps([str(arg) for arg in cmd], indent=2) + "\n", encoding="utf-8"
    )
    (cwd / (prefix + ".stdout")).write_text(result.stdout, encoding="utf-8")
    (cwd / (prefix + ".stderr")).write_text(result.stderr, encoding="utf-8")
    return result, time.monotonic() - started


def mismatch(expected, actual):
    return "".join(
        difflib.unified_diff(
            normalized(expected).splitlines(keepends=True),
            normalized(actual).splitlines(keepends=True),
            fromfile="expected",
            tofile="actual",
        )
    )


def assert_execution(case, result, label):
    if case.aborts:
        if result.returncode == 0:
            raise AssertionError(label + " should have aborted")
    elif result.returncode != 0:
        raise AssertionError(
            label + " exited " + str(result.returncode) + ":\n" + result.stderr[-8000:]
        )
    if normalized(result.stdout) != normalized(case.stdout):
        raise AssertionError(label + " stdout differs:\n" + mismatch(case.stdout, result.stdout))
    for wanted in case.stderr:
        if wanted not in result.stderr:
            raise AssertionError(label + " missing diagnostic " + repr(wanted) + ":\n" + result.stderr[-8000:])


def upstream_case(source_dir, relative):
    source = source_dir / "test" / relative
    text = source.read_text(encoding="utf-8")
    expected = source_dir / "test" / "expected" / source.stem
    stdout = ""
    if expected.with_suffix(".out").exists():
        stdout = expected.with_suffix(".out").read_text(encoding="utf-8")
    stderr = ()
    if expected.with_suffix(".stderr").exists():
        stderr = tuple(
            line for line in expected.with_suffix(".stderr").read_text(encoding="utf-8").splitlines() if line
        )
    return Case(
        name="upstream/" + relative[:-6],
        source=source,
        stdout=stdout,
        stderr=stderr,
        aborts=expected.with_suffix(".aborts").exists(),
        debug="// runtime-define: GS_DEBUG=1" in text.splitlines()[0],
    )


def cases(args):
    manifest = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    selected = list(manifest["quick"])
    if args.full:
        selected.extend(manifest["additional"])
    result = [upstream_case(args.source_dir, path) for path in selected]
    result.append(
        Case(
            "example/stable_tree", TOOL / "examples" / "stable_tree.goose",
            "nodes=4096 first=42 sum=8386602", stack_size=CAPACITY,
        )
    )
    for source in sorted((HERE / "fixtures").glob("exact_*.goose")):
        result.append(Case("boundary/" + source.stem, source, "65536", stack_size=CAPACITY))
    for source in sorted((HERE / "fixtures").glob("overflow_*.goose")):
        result.append(
            Case(
                "boundary/" + source.stem, source,
                stderr=("data stack overflow",), aborts=True, stack_size=CAPACITY, native=False,
            )
        )
    # A static input image can be larger than any managed stack. Decoding it
    # must validate destination capacity before copying the verified payload.
    generated = args.output_dir / "inputs"
    generated.mkdir(parents=True, exist_ok=True)
    image = bytes([0x81, 0x80, 0x04]) + bytes(CAPACITY + 1)
    (generated / "oversized-image.bin").write_bytes(image)
    source = generated / "overflow_decode.goose"
    source.write_text(
        'fn main() {\n'
        '    let image = embed_file("oversized-image.bin");\n'
        '    let decoded, ok = from_bytes<u8[>..]>(image);\n'
        '    print("unreachable ", ok, " ", decoded.len);\n'
        '}\n', encoding="utf-8",
    )
    result.append(
        Case("boundary/overflow_decode", source, stderr=("data stack overflow",), aborts=True, stack_size=CAPACITY, native=False)
    )
    result.append(
        Case("boundary/stdin_exact", HERE / "fixtures" / "read_stdin.goose", "65536", stack_size=CAPACITY, stdin="x" * CAPACITY)
    )
    result.append(
        Case(
            "boundary/stdin_overflow", HERE / "fixtures" / "read_stdin.goose",
            stderr=("data stack overflow",), aborts=True, stack_size=CAPACITY,
            stdin="x" * (CAPACITY + 1), native=False,
        )
    )
    result.append(
        Case(
            "extern/scalar", HERE / "fixtures" / "static_extern.goose", "42",
            native=False, c_sources=(HERE / "fixtures" / "static_extern.c",),
        )
    )
    builder_c = generated / "builder.c"
    builder_c.write_text(
        '#include "goose.h"\n'
        "void fill_ab(gs_rref out, int64_t n) {\n"
        "    for (int64_t i = 0; i < n; i++) gs_bld_append(out, \"ab\", 2);\n"
        "    gs_bld_append(out, \"\", 0);\n"
        "}\n", encoding="utf-8",
    )
    for suffix, count in (("exact", 32768), ("overflow", 32769)):
        builder_source = generated / ("builder_" + suffix + ".goose")
        builder_source.write_text(
            "extern fn fill_ab(out: u8[>..]&, n: i64);\n"
            "fn main() {\n"
            "    var bytes: u8[>..] = [];\n"
            "    fill_ab(bytes, " + str(count) + ");\n"
            "    print(bytes.len);\n"
            "}\n", encoding="utf-8",
        )
        case = Case(
            "extern/builder_" + suffix, builder_source, "65536", stack_size=CAPACITY,
            native=False, c_sources=(builder_c,),
        )
        if suffix == "overflow":
            case = dataclasses.replace(case, stdout="", stderr=("data stack overflow",), aborts=True)
        result.append(case)
    for relative in manifest["rejections"]:
        source = args.source_dir / "test" / relative
        markers = tuple(re.findall(r"^// error: (.+)$", source.read_text(encoding="utf-8"), re.MULTILINE))
        if not markers:
            raise AssertionError("rejection fixture has no error markers: " + str(source))
        result.append(Case("reject/" + source.stem, source, stderr=markers, reject=True, native=False))
    result.extend([
        Case("reject/threads", HERE / "fixtures" / "threads.goose", stderr=("WebAssembly", "thread"), reject=True, native=False),
        Case("reject/dynamic_library", HERE / "fixtures" / "dynamic_library.goose", stderr=("WebAssembly", "dynamic"), reject=True, native=False),
    ])
    if args.filter:
        result = [case for case in result if args.filter in case.name]
    if not result:
        raise ValueError("no test cases match the selection")
    return result


def run_case(args, case, level):
    name = case.name + "/O" + str(level)
    work = args.output_dir / name
    work.mkdir(parents=True, exist_ok=True)
    output = work / "program.mjs"
    output.unlink(missing_ok=True)
    output.with_suffix(".wasm").unlink(missing_ok=True)
    started = time.monotonic()
    try:
        build = [
            sys.executable, args.driver, "build", case.source,
            "-o", output, "--goose", args.goose, "--emcc", args.emcc,
            "-O" + str(level), "--stack-size", str(case.stack_size),
        ]
        if case.debug:
            build.append("--debug")
        for source in case.c_sources:
            build.extend(["--c-source", source])
        if args.memory64:
            build.append("--memory64")
        compiled, _ = command(build, work, args.timeout, "build")
        if case.reject:
            if compiled.returncode == 0:
                raise AssertionError("compiler accepted a rejection fixture")
            diagnostic = compiled.stdout + compiled.stderr
            for wanted in case.stderr:
                if wanted not in diagnostic:
                    raise AssertionError("compiler missing diagnostic " + repr(wanted) + ":\n" + diagnostic[-8000:])
            if output.exists() or output.with_suffix(".wasm").exists():
                raise AssertionError("rejected source produced a runnable output")
        else:
            if compiled.returncode != 0:
                raise AssertionError("Wasm build failed:\n" + compiled.stdout[-4000:] + compiled.stderr[-10000:])
            wasm = output.with_suffix(".wasm")
            if not output.is_file() or not wasm.is_file():
                raise AssertionError("build did not produce both .mjs and .wasm")
            assert_wasm_memory(wasm.read_bytes(), args.memory64)
            ran, _ = command([args.node, output], work, args.timeout, "wasm", case.stdin)
            assert_execution(case, ran, "Wasm")
            if case.native and not args.skip_native:
                native = [args.goose, case.source, "-O" + str(level)]
                if case.debug:
                    native.append("--debug")
                reference, _ = command(native, work, args.timeout, "native", case.stdin)
                assert_execution(case, reference, "native")
                if normalized(reference.stdout) != normalized(ran.stdout):
                    raise AssertionError("native and Wasm output differ")
        return {"name": name, "ok": True, "seconds": round(time.monotonic() - started, 3)}
    except (AssertionError, OSError, subprocess.TimeoutExpired) as error:
        return {"name": name, "ok": False, "seconds": round(time.monotonic() - started, 3), "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--quick", action="store_true", help="run the core qualification corpus (default)")
    mode.add_argument("--full", action="store_true", help="run every curated case in corpus.json")
    parser.add_argument("--driver", type=Path, default=TOOL / "goose_wasm.py")
    parser.add_argument("--source-dir", type=Path, default=REPO / "build" / "goose-wasm" / "source")
    parser.add_argument("--goose", type=Path, default=REPO / "build" / "goose-wasm" / "bin" / "goose")
    parser.add_argument("--emcc", default="emcc")
    parser.add_argument("--node", default="node")
    parser.add_argument("--output-dir", type=Path, default=REPO / "build" / "goose-wasm" / "test-results")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=180, help="timeout per build or run in seconds")
    parser.add_argument("--level", type=int, choices=(0, 2), help="run one optimization level; default runs both")
    parser.add_argument("--memory64", action="store_true", help="qualify the optional memory64 output")
    parser.add_argument("--skip-native", action="store_true", help="diagnostic mode: omit native differential execution")
    parser.add_argument("--filter", help="only case names containing this text")
    parser.add_argument("--list", action="store_true", help="list selected cases without executing")
    args = parser.parse_args()
    for attr in ("driver", "source_dir", "goose", "output_dir"):
        setattr(args, attr, getattr(args, attr).resolve())
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    selected = cases(args)
    if args.list:
        for case in selected:
            print(case.name)
        return 0
    for path in (args.driver, args.goose):
        if not path.is_file():
            parser.error("required file is missing: " + str(path))
    for tool in (args.emcc, args.node):
        if shutil.which(tool) is None:
            parser.error("required executable is unavailable: " + tool)
    levels = (0, 2)
    if args.level is not None:
        levels = (args.level,)
    work = []
    for case in selected:
        if case.reject:
            work.append((case, 2))
        else:
            for level in levels:
                work.append((case, level))
    results = []
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run_case, args, case, level) for case, level in work]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            status = "PASS"
            if not result["ok"]:
                status = "FAIL"
            print(status + " " + result["name"] + " (" + str(result["seconds"]) + "s)", flush=True)
            if not result["ok"]:
                print(result["error"], flush=True)
    results.sort(key=lambda item: item["name"])
    failed = sum(not result["ok"] for result in results)
    report = {
        "schema": "goose-wasm-qualification-v1",
        "source_dir": str(args.source_dir),
        "compiler": str(args.goose),
        "memory64": args.memory64,
        "native_differential": not args.skip_native,
        "full_curated_corpus": args.full,
        "passed": len(results) - failed,
        "failed": failed,
        "seconds": round(time.monotonic() - started, 3),
        "results": results,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(str(len(results) - failed) + " passed, " + str(failed) + " failed; report: " + str(report_path))
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
