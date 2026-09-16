// Bounded LSP byte framing over Content-Length delimited JSON-RPC.
//
// The reader buffers inbound chunks as segments and only copies the exact
// bytes of each delivered frame, so a steady stream of small chunks never
// recopies the whole buffer. Header and body sizes are bounded by centrally
// configured limits. The writer is the single ordered path to stdout: every
// write is chained behind its predecessor, which honors backpressure, and
// nothing else in the server may write to stdout, so stdout carries protocol
// frames only.
//
// Framing failures are distinct from request failures. A body that is not
// JSON is a parse error (-32700) answered with a null id. JSON that is not a
// message is an invalid request (-32600) answered with the best-effort id.
// Oversized or length-less frames cannot be answered, so they are reported
// through window/logMessage and skipped. Truncated input is fatal and
// distinct from a clean end of stream.

import { ErrorCodes } from "./errors.ts";
import type { RequestId } from "./errors.ts";

/** Centrally configured bounds for one LSP frame. */
export interface FramingLimits {
  readonly maxHeaderBytes: number;
  readonly maxBodyBytes: number;
}

/** Starting limits: 16 KiB headers, 16 MiB bodies. */
export const DEFAULT_FRAMING_LIMITS: FramingLimits = {
  maxHeaderBytes: 16 * 1024,
  maxBodyBytes: 16 * 1024 * 1024,
};

/** Resolves configured limits over the defaults, rejecting nonsense. */
export function framingLimits(
  overrides: Partial<FramingLimits> = {},
): FramingLimits {
  let maxHeaderBytes = DEFAULT_FRAMING_LIMITS.maxHeaderBytes;
  if (overrides.maxHeaderBytes !== undefined) {
    maxHeaderBytes = overrides.maxHeaderBytes;
  }
  let maxBodyBytes = DEFAULT_FRAMING_LIMITS.maxBodyBytes;
  if (overrides.maxBodyBytes !== undefined) {
    maxBodyBytes = overrides.maxBodyBytes;
  }
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes <= 0) {
    throw new Error(
      `framing maxHeaderBytes must be a positive integer, saw ${maxHeaderBytes}`,
    );
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error(
      `framing maxBodyBytes must be a positive integer, saw ${maxBodyBytes}`,
    );
  }
  return { maxHeaderBytes, maxBodyBytes };
}

/** A decoded JSON-RPC request, response, or notification. */
export interface InboundMessage {
  readonly jsonrpc?: string;
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * A framing failure the server can report without aborting the stream.
 * When responseId is undefined the frame carried no usable identity, so the
 * server must log instead of responding.
 */
export class FramingError extends Error {
  readonly code: number;
  readonly responseId: RequestId | undefined;

  constructor(
    code: number,
    message: string,
    responseId: RequestId | undefined,
  ) {
    super(message);
    this.name = "FramingError";
    this.code = code;
    this.responseId = responseId;
  }
}

/** A body that is not JSON. Answered with a null id per JSON-RPC. */
export class ParseFrameError extends FramingError {
  constructor(message: string) {
    super(ErrorCodes.ParseError, message, null);
    this.name = "ParseFrameError";
  }
}

/** JSON that is not a request, response, or notification. */
export class InvalidFrameError extends FramingError {
  constructor(message: string, responseId: RequestId | undefined) {
    super(ErrorCodes.InvalidRequest, message, responseId);
    this.name = "InvalidFrameError";
  }
}

/** A header that overflowed maxHeaderBytes. Logged, then skipped. */
export class OversizedHeaderError extends FramingError {
  constructor(message: string) {
    super(ErrorCodes.InternalError, message, undefined);
    this.name = "OversizedHeaderError";
  }
}

/** A body that overflowed maxBodyBytes. Logged, then skipped. */
export class OversizedBodyError extends FramingError {
  constructor(message: string) {
    super(ErrorCodes.InternalError, message, undefined);
    this.name = "OversizedBodyError";
  }
}

/** A header without Content-Length. Logged; reading continues past it. */
export class MissingContentLengthError extends FramingError {
  constructor(message: string) {
    super(ErrorCodes.InternalError, message, undefined);
    this.name = "MissingContentLengthError";
  }
}

/** Input that ended in the middle of a frame. Fatal, unlike clean EOF. */
export class TruncatedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedInputError";
  }
}

const headerNeedle: readonly number[] = [13, 10, 13, 10];

interface Segment {
  readonly bytes: Uint8Array;
  start: number;
}

/**
 * Pulls framed messages from a byte stream without recopying the buffer per
 * chunk. Inbound chunks are appended as segments; bytes are copied only when
 * a complete frame is extracted.
 */
export class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #limits: FramingLimits;
  readonly #decoder = new TextDecoder();
  readonly #segments: Segment[] = [];
  #buffered = 0;
  #skipBodyBytes = 0;
  #skipHeaderArmed = false;
  #skipAfterBoundary: number | undefined = undefined;

  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    limits: FramingLimits = DEFAULT_FRAMING_LIMITS,
  ) {
    this.#reader = reader;
    this.#limits = limits;
  }

  /**
   * Reads the next message, or null on clean end of stream. Framing problems
   * throw FramingError subclasses the server reports and reads past, except
   * TruncatedInputError, which ends the server.
   */
  async read(): Promise<InboundMessage | null> {
    while (true) {
      if (this.#skipBodyBytes > 0) {
        const skipped = await this.#discard(this.#skipBodyBytes);
        if (!skipped) return null;
        this.#skipBodyBytes = 0;
        continue;
      }
      const boundary = this.#findBoundary();
      if (this.#skipHeaderArmed) {
        if (boundary < 0) {
          const pulled = await this.#pull();
          if (!pulled) return null;
          if (this.#buffered > headerNeedle.length - 1) {
            this.#consume(this.#buffered - (headerNeedle.length - 1));
          }
          continue;
        }
        this.#consume(boundary + headerNeedle.length);
        this.#skipHeaderArmed = false;
        if (this.#skipAfterBoundary !== undefined) {
          this.#skipBodyBytes = this.#skipAfterBoundary;
          this.#skipAfterBoundary = undefined;
        }
        continue;
      }
      if (boundary >= 0) {
        if (boundary > this.#limits.maxHeaderBytes) {
          const oversized = this.#decoder.decode(this.#take(boundary));
          this.#consume(headerNeedle.length);
          const claimed = claimedContentLength(oversized);
          if (claimed !== undefined) this.#skipBodyBytes = claimed;
          throw new OversizedHeaderError(
            `LSP header of ${boundary} bytes exceeds the ${this.#limits.maxHeaderBytes} byte limit`,
          );
        }
        const header = this.#decoder.decode(this.#take(boundary));
        this.#consume(headerNeedle.length);
        const length = this.#contentLength(header);
        if (length > this.#limits.maxBodyBytes) {
          this.#skipBodyBytes = length;
          throw new OversizedBodyError(
            `LSP body of ${length} bytes exceeds the ${this.#limits.maxBodyBytes} byte limit`,
          );
        }
        const body = this.#decoder.decode(await this.#takeBody(length));
        return decodeMessage(body);
      }
      if (this.#buffered > this.#limits.maxHeaderBytes + headerNeedle.length) {
        const dropped = this.#decoder.decode(this.#take(this.#buffered));
        this.#skipHeaderArmed = true;
        this.#skipAfterBoundary = claimedContentLength(dropped);
        throw new OversizedHeaderError(
          `LSP header exceeds the ${this.#limits.maxHeaderBytes} byte limit`,
        );
      }
      const pulled = await this.#pull();
      if (!pulled) {
        if (this.#buffered === 0) return null;
        throw new TruncatedInputError(
          "LSP input ended in the middle of a message",
        );
      }
    }
  }

  releaseLock(): void {
    this.#reader.releaseLock();
  }

  #contentLength(header: string): number {
    const claimed = claimedContentLength(header);
    if (claimed === undefined) {
      throw new MissingContentLengthError(
        `LSP message omitted Content-Length: ${header}`,
      );
    }
    return claimed;
  }

  async #takeBody(length: number): Promise<Uint8Array> {
    while (this.#buffered < length) {
      const pulled = await this.#pull();
      if (!pulled) {
        throw new TruncatedInputError(
          "LSP input ended in the middle of a message",
        );
      }
    }
    return this.#take(length);
  }

  async #discard(count: number): Promise<boolean> {
    let remaining = count;
    while (remaining > 0) {
      if (this.#buffered === 0) {
        const pulled = await this.#pull();
        if (!pulled) return false;
      }
      const step = Math.min(remaining, this.#buffered);
      this.#consume(step);
      remaining -= step;
    }
    return true;
  }

  async #pull(): Promise<boolean> {
    const chunk = await this.#reader.read();
    if (chunk.done) return false;
    if (chunk.value.byteLength === 0) return true;
    this.#segments.push({ bytes: chunk.value, start: 0 });
    this.#buffered += chunk.value.byteLength;
    return true;
  }

  #findBoundary(): number {
    let absolute = 0;
    let matched = 0;
    for (const segment of this.#segments) {
      for (
        let index = segment.start;
        index < segment.bytes.byteLength;
        index += 1
      ) {
        const byte = segment.bytes[index];
        if (byte === headerNeedle[matched]) {
          matched += 1;
          if (matched === headerNeedle.length) return absolute - 3;
        } else if (byte === headerNeedle[0]) {
          matched = 1;
        } else {
          matched = 0;
        }
        absolute += 1;
      }
    }
    return -1;
  }

  #take(count: number): Uint8Array {
    const taken = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const segment = this.#segments[0];
      if (segment === undefined) {
        throw new Error("framing take ran past the buffered bytes");
      }
      const available = segment.bytes.byteLength - segment.start;
      const step = Math.min(available, count - written);
      taken.set(
        segment.bytes.subarray(segment.start, segment.start + step),
        written,
      );
      segment.start += step;
      written += step;
      if (segment.start >= segment.bytes.byteLength) this.#segments.shift();
    }
    this.#buffered -= count;
    return taken;
  }

  #consume(count: number): void {
    let remaining = count;
    while (remaining > 0) {
      const segment = this.#segments[0];
      if (segment === undefined) {
        throw new Error("framing consume ran past the buffered bytes");
      }
      const available = segment.bytes.byteLength - segment.start;
      const step = Math.min(available, remaining);
      segment.start += step;
      remaining -= step;
      if (segment.start >= segment.bytes.byteLength) this.#segments.shift();
    }
    this.#buffered -= count;
  }
}

/** Reads the claimed body length from a header, when it names one. */
function claimedContentLength(header: string): number | undefined {
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (match === null) return undefined;
  return Number(match[1]);
}

/** Decodes one framed body, distinguishing parse from shape failures. */
export function decodeMessage(body: string): InboundMessage {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    let detail = String(error);
    if (error instanceof Error) detail = error.message;
    throw new ParseFrameError(`LSP body is not JSON: ${detail}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidFrameError(
      "LSP body is not a JSON-RPC message object",
      null,
    );
  }
  const record = value as Record<string, unknown>;
  const method = record.method;
  const id = record.id;
  if (method !== undefined && typeof method !== "string") {
    throw new InvalidFrameError(
      "LSP message has a non-string method",
      bestEffortId(id),
    );
  }
  if (id !== undefined && !isRequestId(id)) {
    throw new InvalidFrameError(
      "LSP message has an invalid id",
      null,
    );
  }
  if (method === undefined && id === undefined) {
    throw new InvalidFrameError(
      "LSP message has neither method nor id",
      null,
    );
  }
  const message: {
    jsonrpc?: string;
    id?: RequestId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  } = {};
  if (typeof record.jsonrpc === "string") message.jsonrpc = record.jsonrpc;
  if (id !== undefined) message.id = id as RequestId;
  if (method !== undefined) message.method = method;
  if (record.params !== undefined) message.params = record.params;
  if (record.result !== undefined) message.result = record.result;
  if (record.error !== undefined) message.error = record.error;
  return message;
}

function isRequestId(id: unknown): id is RequestId {
  return id === null || typeof id === "string" || typeof id === "number";
}

function bestEffortId(id: unknown): RequestId | undefined {
  if (isRequestId(id)) return id;
  return null;
}

/** Encodes one outbound frame. The writer below is its only stdout path. */
export function encodeFrame(message: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header);
  frame.set(body, header.byteLength);
  return frame;
}

/**
 * The single ordered path to stdout. Writes chain behind each other, so at
 * most one write is outstanding and backpressure is honored. The first write
 * failure latches: later writes reject with the same reason instead of
 * touching a broken stream.
 */
export class FrameWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #tail: Promise<void> = Promise.resolve();
  #broken = false;
  #breakReason: unknown = undefined;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.#writer = writer;
  }

  get broken(): boolean {
    return this.#broken;
  }

  write(message: unknown): Promise<void> {
    if (this.#broken) return Promise.reject(this.#breakReason);
    let frame: Uint8Array;
    try {
      frame = encodeFrame(message);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = this.#tail.then(() => this.#writeFrame(frame));
    this.#tail = pending.then(
      () => undefined,
      (error: unknown) => {
        this.#latchBroken(error);
      },
    );
    return pending;
  }

  /**
   * Waits for every queued write to reach the stream. Never rejects: write
   * failures latch on the writer and reject their own callers instead.
   */
  flush(): Promise<void> {
    return this.#tail;
  }

  releaseLock(): void {
    this.#writer.releaseLock();
  }

  async #writeFrame(frame: Uint8Array): Promise<void> {
    await this.#writer.write(frame);
  }

  #latchBroken(reason: unknown): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#breakReason = reason;
  }
}
