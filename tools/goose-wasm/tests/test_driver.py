#!/usr/bin/env python3
"""End-to-end driver errors, path handling, and importable Node loader."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
TOOL = HERE.parent
REPO = HERE.parents[2]
DRIVER = TOOL / "goose_wasm.py"
COMPILER = REPO / "build" / "goose-wasm" / "bin" / "goose"
WORK = REPO / "build" / "goose-wasm" / "driver-tests"
EMCC = "emcc"
NODE = "node"
VERSION = json.loads((TOOL / "upstream.json").read_text(encoding="utf-8"))["emscripten"]


class Driver(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=WORK)
        self.root = Path(self.temporary.name)
        self.source = self.root / "main.goose"
        self.source.write_text('fn main() { print("hello wasm"); }\n', encoding="utf-8")
        self.output = self.root / "program.mjs"

    def tearDown(self):
        self.temporary.cleanup()

    def build(self, *, emcc=None, compiler=None, extra=()):
        if emcc is None:
            emcc = EMCC
        if compiler is None:
            compiler = COMPILER
        env = os.environ.copy()
        env["GOOSE_HOME"] = str(self.root / "goose-home")
        return subprocess.run(
            [sys.executable, str(DRIVER), "build", str(self.source), "-o", str(self.output),
             "--goose", str(compiler), "--emcc", str(emcc), *extra],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=180, check=False,
        )

    def fake_tool(self, name, body):
        path = self.root / name
        path.write_text("#!" + sys.executable + "\nimport sys\n" + body, encoding="utf-8")
        path.chmod(0o755)
        return path

    def preserve_prior_outputs(self):
        self.output.write_bytes(b"previous module\n")
        self.output.with_suffix(".wasm").write_bytes(b"previous wasm\n")

    def assert_prior_outputs(self):
        self.assertEqual(self.output.read_bytes(), b"previous module\n")
        self.assertEqual(self.output.with_suffix(".wasm").read_bytes(), b"previous wasm\n")

    def test_missing_emcc_is_actionable(self):
        result = self.build(emcc=self.root / "no-such-emcc")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Emscripten emcc not found", result.stderr)
        self.assertFalse(self.output.exists())

    def test_wrong_sdk_version_is_rejected(self):
        fake = self.fake_tool("wrong-emcc", 'print("emcc (Emscripten) 0.0.0")\n')
        result = self.build(emcc=fake)
        self.assertEqual(result.returncode, 1)
        self.assertIn("requires Emscripten " + VERSION, result.stderr)
        self.assertFalse(self.output.exists())

    def test_invalid_sizes_are_rejected(self):
        for value in ("0", "63K", "65537", "2G"):
            with self.subTest(value=value):
                result = self.build(extra=("--stack-size", value))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--stack-size", result.stderr)
                self.assertFalse(self.output.exists())

    def test_frontend_failure_preserves_previous_artifacts(self):
        fake = self.fake_tool(
            "failing-goose",
            'print("deliberate frontend failure", file=sys.stderr)\nsys.exit(23)\n',
        )
        self.preserve_prior_outputs()
        result = self.build(compiler=fake)
        self.assertEqual(result.returncode, 1)
        self.assertIn("deliberate frontend failure", result.stderr)
        self.assertIn("exit 23", result.stderr)
        self.assert_prior_outputs()

    def test_link_failure_preserves_previous_artifacts(self):
        fake = self.fake_tool(
            "failing-emcc",
            'if "--version" in sys.argv:\n'
            '    print("emcc (Emscripten) ' + VERSION + '")\n'
            '    sys.exit(0)\n'
            'print("deliberate link failure", file=sys.stderr)\n'
            'sys.exit(24)\n',
        )
        self.preserve_prior_outputs()
        result = self.build(emcc=fake)
        self.assertEqual(result.returncode, 1)
        self.assertIn("deliberate link failure", result.stderr)
        self.assertIn("exit 24", result.stderr)
        self.assert_prior_outputs()

    def test_spaces_unicode_and_module_import_from_stdin(self):
        folder = self.root / "folder with spaces żółć"
        folder.mkdir()
        self.source = folder / "source λ.goose"
        self.source.write_text('fn main() { print("hello wasm"); }\n', encoding="utf-8")
        self.output = folder / "program λ.mjs"
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        direct = subprocess.run(
            [NODE, str(self.output)], capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertEqual(direct.stdout, "hello wasm\n")
        # process.argv[1] is '-' for a stdin script. Importing the executable
        # should neither run main nor try to resolve '-' as a real filename.
        code = (
            "const {default: create} = await import(" + json.dumps(self.output.as_uri()) + ");\n"
            "const lines = [];\n"
            "await create({print: (line) => lines.push(line)});\n"
            'if (JSON.stringify(lines) !== JSON.stringify(["hello wasm"])) {\n'
            '    throw new Error("factory output mismatch: " + JSON.stringify(lines));\n'
            "}\n"
            'process.stdout.write("loader ok\\n");\n'
        )
        imported = subprocess.run(
            [NODE, "--input-type=module", "-"], input=code,
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(imported.returncode, 0, imported.stderr)
        self.assertEqual(imported.stdout, "loader ok\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--goose", type=Path, default=COMPILER)
    parser.add_argument("--emcc", default=EMCC)
    parser.add_argument("--node", default=NODE)
    parser.add_argument("--output-dir", type=Path, default=WORK)
    args, remaining = parser.parse_known_args()
    COMPILER = args.goose.resolve()
    EMCC = args.emcc
    NODE = args.node
    WORK = args.output_dir.resolve()
    WORK.mkdir(parents=True, exist_ok=True)
    unittest.main(argv=[sys.argv[0], *remaining])
