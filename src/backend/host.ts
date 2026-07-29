// The host side of a host effect.
//
// A `@effect.host` declaration becomes a gpufuck capability, and a capability
// becomes typed WebAssembly imports. This is what answers them. blot has no
// raw import form on purpose: you declare an effect, and the boundary follows
// from its operation types.

import type { WasmInit } from "gpufuck";

/**
 * The capabilities `blot build` grants when it runs what it compiled.
 *
 * Deliberately small and named after the effect, not after a filename or an
 * ambient global — a program that did not declare `Console` cannot reach this.
 */
export function hostInit(write: (line: string) => void): WasmInit {
  return {
    // Core carries text without measuring or rendering it, so blot declares
    // this capability itself and the host answers it. Every program that
    // inspects text imports it, and it is visible in the module's imports.
    Text: {
      length: (value: unknown) => ({
        kind: "integer" as const,
        value: [...String((value as { value?: string }).value ?? "")].length,
      }),
      of_int: (value: unknown) => ({
        kind: "text" as const,
        value: String((value as { value?: number | bigint }).value ?? 0),
      }),
      compare: (value: unknown) => {
        const pair = value as { fields?: readonly { value?: string }[] };
        const left = String(pair.fields?.[0]?.value ?? "");
        const right = String(pair.fields?.[1]?.value ?? "");
        return {
          kind: "integer" as const,
          value: left < right ? -1 : left > right ? 1 : 0,
        };
      },
    },
    // Whatever the entry module reached for through its parameter. `blot build`
    // grants exactly this; a program that asked for something else would not
    // find it.
    Init: {
      print: (value: unknown) => {
        write(String((value as { value?: string }).value ?? ""));
        return { kind: "unit" as const };
      },
    },
    Console: {
      write: (value: unknown) => {
        const text = value as { kind?: string; value?: string };
        write(text.kind === "text" ? String(text.value) : String(value));
        return { kind: "unit" as const };
      },
    },
  };
}
