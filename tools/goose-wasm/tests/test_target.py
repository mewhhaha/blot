#!/usr/bin/env python3
"""Exercise native compiler target policy without requiring Emscripten."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
COMPILER = REPO / "build" / "goose-wasm" / "bin" / "goose"
WORK = REPO / "build" / "goose-wasm" / "target-tests"


class TargetPolicy(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=WORK)
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def source(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def check(self, source, target="wasm", extra=()):
        env = os.environ.copy()
        env["GOOSE_HOME"] = str(self.root / "goose-home")
        return subprocess.run(
            [str(COMPILER), "--target", target, "--check", str(source), *extra],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def assert_refusal(self, result, fragment):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("WebAssembly target", result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn(":0: error:", result.stderr)

    def test_plain_program_and_static_math_extern_are_accepted(self):
        source = self.source(
            "main.goose",
            'extern fn sqrt(x: f64) -> f64;\n'
            'fn main() { print(sqrt(4.0)); }\n',
        )
        result = self.check(source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_comments_strings_and_identifiers_are_not_target_syntax(self):
        source = self.source(
            "main.goose",
            '// thread_fn fake() {} and extern "libfake" are comments.\n'
            'fn main() {\n'
            '    let thread_fn_text = "thread_spawn qget extern";\n'
            '    print(thread_fn_text);\n'
            '}\n',
        )
        result = self.check(source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_thread_spawn_is_refused(self):
        self.assert_refusal(self.check(HERE / "fixtures" / "threads.goose"), "thread")

    def test_typed_queue_without_worker_is_refused(self):
        source = self.source(
            "main.goose",
            "fn main() { qput(42); print(qget<i64>()); }\n",
        )
        self.assert_refusal(self.check(source), "typed queues")

    def test_imported_thread_spawn_is_refused(self):
        self.source(
            "worker.goose",
            'thread_fn task() { print("worker"); }\n'
            'fn start() { thread_wait(thread_spawn(task)); }\n',
        )
        source = self.source("main.goose", "import worker;\nfn main() { start(); }\n")
        self.assert_refusal(self.check(source), "thread")

    def test_dynamic_library_is_refused(self):
        self.assert_refusal(self.check(HERE / "fixtures" / "dynamic_library.goose"), "dynamic")

    def test_imported_dynamic_library_is_refused(self):
        self.source("foreign.goose", 'extern "libexample" { fn answer() -> i32; }\n')
        source = self.source("main.goose", "import foreign;\nfn main() { print(answer()); }\n")
        self.assert_refusal(self.check(source), "dynamic")

    def test_native_profile_keeps_native_language_features(self):
        for fixture in ("threads.goose", "dynamic_library.goose"):
            with self.subTest(fixture=fixture):
                result = self.check(HERE / "fixtures" / fixture, target="native")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_native_sidecar_is_refused_before_building(self):
        source = self.source(
            "main.goose",
            "extern fn foreign_value() -> i64;\n"
            "fn main() { print(foreign_value()); }\n",
        )
        self.source("main.build", 'c_sources = ["native.c"];\n')
        self.source("native.c", "#error This target must not build the native sidecar\n")
        self.assert_refusal(self.check(source), "native sidecar")

    def test_native_package_is_refused_before_fetching(self):
        source = self.source("main.goose", 'import gfx;\nfn main() { print("ok"); }\n')
        self.assert_refusal(self.check(source), "native package gfx")

    def test_source_errors_keep_their_source_location(self):
        source = self.source("broken.goose", 'fn main() { print("bad\\q"); }\n')
        result = self.check(source)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown escape sequence", result.stderr)
        self.assertIn("broken.goose:1:", result.stderr)
        self.assertNotIn("WebAssembly target", result.stderr)

    def test_unknown_target_is_an_error(self):
        source = self.source("main.goose", 'fn main() { print("ok"); }\n')
        result = self.check(source, target="made-up")
        self.assertEqual(result.returncode, 1)
        self.assertIn("native or wasm", result.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--goose", type=Path, default=COMPILER)
    parser.add_argument("--output-dir", type=Path, default=WORK)
    args, remaining = parser.parse_known_args()
    COMPILER = args.goose.resolve()
    WORK = args.output_dir.resolve()
    WORK.mkdir(parents=True, exist_ok=True)
    if not COMPILER.is_file():
        parser.error("compiler is missing: " + str(COMPILER))
    unittest.main(argv=[sys.argv[0], *remaining])
