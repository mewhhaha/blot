import { requiredFunction, requireGuestScopeToken } from "../src/abi_values.ts";

/** For direct scalar observations; memory results require decoding inside an explicit scope. */
export function scalarExport(
  instance: WebAssembly.Instance,
  name: string,
): (...arguments_: readonly (number | bigint)[]) => unknown {
  const call = requiredFunction(instance, name);
  const enter = requiredFunction(instance, "cabi_enter");
  const leave = requiredFunction(instance, "cabi_leave");
  return (...arguments_) => {
    const scope = requireGuestScopeToken(enter());
    try {
      return call(scope, ...arguments_);
    } finally {
      leave(scope);
    }
  };
}
