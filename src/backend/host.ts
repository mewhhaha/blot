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
    Console: {
      write: (value: unknown) => {
        const text = value as { kind?: string; value?: string };
        write(text.kind === "text" ? String(text.value) : String(value));
        return { kind: "unit" as const };
      },
    },
  };
}
