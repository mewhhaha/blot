# Executable example catalog

The catalog distinguishes four outcomes. Keeping them separate matters: a hard
but valid program, a specified trap, an invalid program, and a useful feature
that has not been implemented are four different claims about the language.

| location             | meaning                                                           | enforced outcome                                                                            |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `examples/*.blot`    | supported programs, including files prefixed `pathological_`      | check, evaluate to the golden value, and compile in the ordinary corpus                     |
| `examples/traps/`    | valid programs whose requested execution reaches a specified trap | check successfully, then fail during evaluation with the recorded code                      |
| `examples/rejected/` | programs the language intentionally rejects                       | fail in the recorded compiler phase with the recorded diagnostic                            |
| `examples/pending/`  | desirable pressure tests which are **not implemented yet**        | retain the recorded refusal or non-principal type, then fail loudly when it can be promoted |

Every pathological and pending file explains the edge in its opening comment.
Pending files are not language proposals by themselves; `LANGUAGE.md` and
`spec/` remain authoritative. They are executable markers for work already named
in `TASKS.md` or `SUGGESTION.md`, not disabled tests that can silently rot.

When a pending case is implemented, move it to the top-level catalog, add its
golden value, and remove its entry from `PENDING` in `examples.test.ts`. When a
trap becomes total by design, promote it the same way rather than weakening the
expected diagnostic.
