from __future__ import annotations

import os
from pathlib import Path
import subprocess


def run(*args: str) -> None:
    subprocess.run(args, check=True)


if os.environ.get("GITHUB_WORKFLOW") != "CI Debug":
    raise SystemExit("source patch runner is only for the write-enabled CI Debug job")

# The branch is shared with another agent. Rebase immediately before touching
# shared compiler files so the patch is applied to the newest head rather than
# overwriting concurrent work.
head = os.environ.get("GITHUB_HEAD_REF") or "codex/owned-slices"
run("git", "pull", "--rebase", "origin", head)

# Import executes the deliberately temporary mechanical patch.
import patch_source  # noqa: F401,E402

paths = [
    "src/check/type.ts",
    "src/check/constrain.ts",
    "src/check/print.ts",
    "src/check/bridge.ts",
    "src/check/primitives.ts",
    "src/comptime/value.ts",
    "src/comptime/primitives.ts",
    "src/comptime/eval.ts",
    "src/linear/check.ts",
    "experiments/owned-regions/source_surface.test.ts",
]
run("deno", "fmt", *paths)
run("git", "config", "user.name", "github-actions[bot]")
run(
    "git",
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
)
run("git", "add", *paths)
# A failed anchor must never leave a partial compiler patch committed. If all
# files applied and formatting completed, this commit is the atomic handoff.
run("git", "commit", "-m", "feat: add scoped owned-region source primitives")
run("git", "push", "origin", f"HEAD:{head}")
print("owned-region source patch committed and pushed")
