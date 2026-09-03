from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one replacement in {path}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "compiler/src/typecheck.rs",
    """                let inferred = self.infer(path, module, value, types, values, dependencies)?;
                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred_type = stable_rebinding_type(inferred.type_.clone());
                self.constrain(inferred_type.clone(), previous.clone(), span)?;
                self.constrain(previous.clone(), inferred_type, span)?;
""",
    """                let previous = stable_rebinding_type(self.instantiate(previous));
                let inferred = self.infer_against(
                    path,
                    module,
                    value,
                    previous.clone(),
                    types,
                    values,
                    dependencies,
                    span,
                )?;
""",
)

replace_once(
    "LANGUAGE.md",
    """The old and new types must constrain each other after singleton integer and text
literals are widened to their stable domains. The previous polymorphic scheme is
retained. Use another `let` or `const` to shadow a name with a different type.
""",
    """The replacement is inferred against the existing binding's stable type. It must
therefore be a subtype of that type, and the rebound name retains the existing
type rather than the replacement's narrower inferred type. For example, when a
binding has type `#True | #False`, rebinding it with `#True` keeps the union type.
Singleton integer and text types are widened to their stable domains at this
boundary. The previous polymorphic scheme is retained. Use another `let` or
`const` to shadow a name with a different type.
""",
)

replace_once(
    "docs/inference.md",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name, but the old and new types must flow into one another. Singleton
integer and text literals widen to their domains at that boundary, so
`value := value + 1` preserves `Int`; changing an integer binding to text
requires another `let value = ...`. The existing binding's scheme is retained,
so rebinding a polymorphic function does not accidentally make it monomorphic.
""",
    """`:=` is deliberately stricter than `let`. It introduces a new binding for an
existing name and infers the replacement against that binding's stable type.
The replacement may be narrower, so assigning `#True` to a `Bool` binding
preserves `#True | #False`; a value outside the stable type is still rejected.
Singleton integer and text literals widen to their domains at that boundary, so
`value := value + 1` preserves `Int`; changing an integer binding to text
requires another `let value = ...`. The existing binding's scheme is retained,
so rebinding a polymorphic function does not accidentally make it monomorphic.
""",
)

Path("src/compiler/stable_rebinding.test.ts").write_text(
    """import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "./session.ts";

test("stable rebinding preserves an explicitly wider variant type", async () => {
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.checkSource(
      join(tmpdir(), "blot-stable-variant-rebinding.blot"),
      'open import "blot:prelude"\\n' +
        "let flag :: Bool\\n" +
        "let flag = #False\\n" +
        "flag := #True\\n" +
        "return flag\\n",
    );
    assert.equal(checked.type, "#True | #False");
  } finally {
    compiler.destroy();
  }
});
""",
    encoding="utf-8",
)
