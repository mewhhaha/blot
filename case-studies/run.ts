import { build } from "../src/backend/compile.ts";

type Study =
  | {
    readonly kind: "grep";
    readonly source: "case-studies/grep/main.blot";
    readonly pattern: string;
    readonly lines: readonly string[];
  }
  | {
    readonly kind: "terminal";
    readonly source: "case-studies/terminal/main.blot";
  }
  | {
    readonly kind: "agent";
    readonly source: "case-studies/agent/main.blot";
  };

class GuestMemory {
  #instance: WebAssembly.Instance | null = null;

  attach(instance: WebAssembly.Instance): void {
    this.#instance = instance;
  }

  readText(pointer: number, length: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(this.memory().buffer, pointer, length),
    );
  }

  writeText(resultPointer: number, value: string): void {
    const bytes = new TextEncoder().encode(value);
    const reallocate = this.exportedFunction("cabi_realloc");
    const pointer = Number(reallocate(0, 0, 1, bytes.length));
    new Uint8Array(this.memory().buffer, pointer, bytes.length).set(bytes);
    const result = new DataView(this.memory().buffer);
    result.setUint32(resultPointer, pointer, true);
    result.setUint32(resultPointer + 4, bytes.length, true);
  }

  private memory(): WebAssembly.Memory {
    const memory = this.instance().exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("case study module did not export canonical ABI memory");
    }
    return memory;
  }

  private exportedFunction(name: string): CallableFunction {
    const exported = this.instance().exports[name];
    if (typeof exported !== "function") {
      throw new Error(`case study module did not export ${name}`);
    }
    return exported;
  }

  private instance(): WebAssembly.Instance {
    if (this.#instance === null) {
      throw new Error("case study host was called before instantiation");
    }
    return this.#instance;
  }
}

const [studyName, ...studyArguments] = Deno.args;
let study: Study;
if (studyName === "grep") {
  const [pattern, path] = studyArguments;
  if (
    pattern === undefined ||
    path === undefined ||
    studyArguments.length !== 2
  ) {
    throw new Error("usage: deno task case-study grep <pattern> <path>");
  }
  const file = await Deno.readTextFile(path);
  const lines = file.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  study = {
    kind: "grep",
    source: "case-studies/grep/main.blot",
    pattern,
    lines,
  };
} else if (studyName === "terminal" && studyArguments.length === 0) {
  study = {
    kind: "terminal",
    source: "case-studies/terminal/main.blot",
  };
} else if (studyName === "agent" && studyArguments.length === 0) {
  study = {
    kind: "agent",
    source: "case-studies/agent/main.blot",
  };
} else {
  throw new Error(
    "usage: deno task case-study <grep <pattern> <path>|terminal|agent>",
  );
}

const guest = new GuestMemory();
const terminal = {
  read_line(resultPointer: number) {
    let line = prompt("");
    if (line === null) line = "";
    guest.writeText(resultPointer, line);
  },
  write(pointer: number, length: number) {
    console.log(guest.readText(pointer, length));
  },
};

let imports: WebAssembly.Imports;
if (study.kind === "grep") {
  imports = {
    "blot:host/Arguments": {
      pattern(resultPointer: number) {
        guest.writeText(resultPointer, study.pattern);
      },
    },
    "blot:host/File": {
      line_count() {
        return BigInt(study.lines.length);
      },
      line(index: bigint, resultPointer: number) {
        const line = study.lines[Number(index)];
        if (line === undefined) {
          throw new RangeError(
            `grep requested line ${index} from ${study.lines.length} lines`,
          );
        }
        guest.writeText(resultPointer, line);
      },
    },
    "blot:host/Console": {
      write(pointer: number, length: number) {
        console.log(guest.readText(pointer, length));
      },
    },
  };
} else if (study.kind === "terminal") {
  imports = { "blot:host/Terminal": terminal };
} else {
  imports = {
    "blot:host/Terminal": terminal,
    "blot:host/Model": {
      complete(pointer: number, length: number, resultPointer: number) {
        const transcript = guest.readText(pointer, length);
        const turns = transcript.split("\nUser: ");
        let request = turns.at(-1);
        if (request === undefined) request = transcript;
        const message = request.replace(/\nAssistant:$/, "");
        let reply = `I heard: ${message}`;
        if (message.includes("help")) {
          reply = "Try asking a short, concrete question.";
        }
        guest.writeText(resultPointer, reply);
      },
    },
  };
}

const built = await build(study.source);
const wasm = new Uint8Array(built.wasm);
const module = await WebAssembly.compile(wasm);
const instance = await WebAssembly.instantiate(module, imports);
guest.attach(instance);

const exported = built.manifest.exports.find((candidate) =>
  candidate.sourceName === "default"
);
if (exported?.name === null || exported?.name === undefined) {
  throw new Error("case study did not publish a runtime default export");
}
const main = instance.exports[exported.name];
if (typeof main !== "function") {
  throw new Error(`case study module did not export ${exported.name}`);
}
const result = main();
if (study.kind === "grep" && result === 0n) Deno.exitCode = 1;
