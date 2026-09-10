import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";

function tuple(first: RuntimeValue, second: RuntimeValue): RuntimeValue {
  return {
    kind: "record",
    fields: new Map([["0", first], ["1", second]]),
  };
}

test("Text cursors preserve Unicode, replay, and linear large traversals in Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    assert.equal(
      (await compiler.evaluate("examples/text_cursor.blot")).display,
      '[["α", "α"], ["a", "é", "🐱"], ["α🐱 β"], []]',
    );
    const hosted = await instantiateArtifact(
      await compiler.compile("examples/lib/text_cursor_runtime.blot"),
    );
    try {
      for (
        const text of ["", "ascii", "aéβ\uFEFF🐱\0e\u0301", "\uFEFF\uFEFF"]
      ) {
        let byte = 0n;
        for (const scalar of text) {
          const nextByte = byte + BigInt(Buffer.byteLength(scalar));
          assert.deepEqual(hosted.call("step", [tuple(text, byte)]), {
            kind: "variant",
            name: "Some",
            payload: tuple(scalar, nextByte),
          });
          byte = nextByte;
        }
        for (let repeat = 0; repeat < 2; repeat += 1) {
          assert.deepEqual(hosted.call("step", [tuple(text, byte)]), {
            kind: "variant",
            name: "None",
          });
        }
      }

      const cursor = hosted.call("cursor", ["α🐱"]);
      assert.deepEqual(cursor, {
        kind: "variant",
        name: "TextCursor",
        payload: tuple("α🐱", 0n),
      });
      const first = hosted.call("next", [cursor]);
      assert.deepEqual(first, {
        kind: "variant",
        name: "Some",
        payload: tuple("α", {
          kind: "variant",
          name: "TextCursor",
          payload: tuple("α🐱", 2n),
        }),
      });
      assert.deepEqual(hosted.call("next", [cursor]), first);

      for (
        const text of [
          "",
          " \t\r\n",
          " \tα🐱 β\r\n ",
          " \uFEFFα\uFEFF ",
          " \u00A0α\u00A0 ",
          "\v\fα\v\f",
          " \0e\u0301 ",
          " ".repeat(131_072),
          "α🐱".repeat(65_536),
          ` ${"α \t🐱".repeat(32_768)}\r\n`,
        ]
      ) {
        assert.equal(hosted.call("count", [text]), BigInt([...text].length));
        assert.equal(
          hosted.call("trim", [text]),
          text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, ""),
        );
      }
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("Text byte stepping and forged cursors trap invalid UTF-8 offsets", async () => {
  const compiler = await Compiler.create();
  try {
    const artifact = await compiler.compile(
      "examples/lib/text_cursor_runtime.blot",
    );
    for (const byte of [-1n, 1n, 3n, 9223372036854775807n]) {
      for (const exportName of ["step", "next"]) {
        const hosted = await instantiateArtifact(artifact);
        try {
          let argument = tuple("é", byte);
          if (exportName === "next") {
            argument = {
              kind: "variant",
              name: "TextCursor",
              payload: argument,
            };
          }
          assert.throws(
            () => hosted.call(exportName, [argument]),
            WebAssembly.RuntimeError,
          );
        } finally {
          await hosted.close();
        }
      }
    }
  } finally {
    compiler.destroy();
  }
});
