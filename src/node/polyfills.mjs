// Node 24 does not yet expose the ES typed-array base64 helpers used by the
// generated gpupaper Wasm byte module.
if (typeof Uint8Array.fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    value(source) {
      return new Uint8Array(Buffer.from(source, "base64"));
    },
  });
}

if (typeof Uint8Array.prototype.toBase64 !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    configurable: true,
    value() {
      return Buffer.from(this).toString("base64");
    },
  });
}
