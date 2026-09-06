const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Internal length-delimited compiler transport; not a semantic cache. */
export class BinaryEncoder {
  #bytes = new Uint8Array(64);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;

  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError(`compiler binary u32 cannot encode ${value}`);
    }
    this.#reserve(4);
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
  }

  bytes(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.#reserve(value.byteLength);
    this.#bytes.set(value, this.#length);
    this.#length += value.byteLength;
  }

  string(value: string): void {
    this.bytes(textEncoder.encode(value));
  }

  finish(): Uint8Array {
    // Callers own a stable snapshot, even if they continue using this encoder.
    return this.#bytes.slice(0, this.#length);
  }

  #reserve(additional: number): void {
    const required = this.#length + additional;
    if (required <= this.#bytes.byteLength) return;
    const capacity = Math.max(required, this.#bytes.byteLength * 2);
    const bytes = new Uint8Array(capacity);
    bytes.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer);
  }
}

export class BinaryDecoder {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
  }

  u32(label: string): number {
    const end = this.#offset + 4;
    if (!Number.isSafeInteger(end) || end > this.#bytes.byteLength) {
      throw new Error(`compiler binary frame omitted ${label}`);
    }
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset = end;
    return value;
  }

  bytes(label: string): Uint8Array {
    const length = this.u32(`${label} byte length`);
    const end = this.#offset + length;
    if (!Number.isSafeInteger(end) || end > this.#bytes.byteLength) {
      throw new Error(`compiler binary frame truncated ${label}`);
    }
    const value = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return value;
  }

  string(label: string): string {
    return textDecoder.decode(this.bytes(label));
  }

  finish(): void {
    if (this.#offset !== this.#bytes.byteLength) {
      throw new Error(
        `compiler binary frame has ${
          this.#bytes.byteLength - this.#offset
        } trailing bytes`,
      );
    }
  }
}
