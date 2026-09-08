import { decodeManifest } from "./abi_values.ts";
import { HostScope } from "./resources.ts";
import { SharedWorkerAccess } from "./shared_memory.ts";
import type { CompiledDevelopmentProgram } from "./callbacks.ts";
import {
  decodeDevelopmentManifest,
  developmentLinkImports,
  type LinkedDevelopmentUnit,
} from "./development_runtime.ts";
import {
  type HostedModule,
  type HostOperation,
  instantiateArtifact,
} from "./host.ts";
import {
  type WorkerPort,
  workerRequest,
  type WorkerResponse,
} from "./worker_protocol.ts";

interface WorkerProgram {
  readonly module: WebAssembly.Module;
  readonly manifestBytes: Uint8Array;
  readonly development?: CompiledDevelopmentProgram;
  instance: Promise<WorkerInstance> | undefined;
}

interface WorkerInstance {
  readonly entry: HostedModule;
  readonly lifetime: HostScope;
  readonly shared: SharedWorkerAccess;
}

async function instantiateProgram(
  program: WorkerProgram,
): Promise<WorkerInstance> {
  const instances = new Map<string, LinkedDevelopmentUnit>();
  const hosted = new Map<string, HostedModule>();
  const lifetime = new HostScope();
  const shared = new SharedWorkerAccess(lifetime);
  let entryName = "entry";
  let compiled = [{
    name: entryName,
    root: "",
    module: program.module,
    manifestBytes: program.manifestBytes,
  }];
  if (program.development !== undefined) {
    entryName = program.development.entryUnit;
    compiled = [...program.development.units];
  }
  try {
    for (const unit of compiled) {
      const capabilities = new Map<string, Map<string, HostOperation>>();
      for (const operation of decodeManifest(unit.manifestBytes).imports) {
        let operations = capabilities.get(operation.capability);
        if (operations === undefined) {
          operations = new Map();
          capabilities.set(operation.capability, operations);
        }
        if (operation.capability === "SharedAccess") {
          const access = shared.operations.get(operation.sourceName);
          if (access === undefined) {
            throw new TypeError(
              `unsupported shared worker access ${operation.sourceName}`,
            );
          }
          operations.set(operation.sourceName, access);
          continue;
        }
        operations.set(operation.sourceName, () => {
          throw new Error(
            `pure worker attempted ${operation.capability}.${operation.sourceName}`,
          );
        });
      }
      if (program.development === undefined) {
        hosted.set(
          unit.name,
          await instantiateArtifact(unit, capabilities, { scope: lifetime }),
        );
        continue;
      }
      const manifest = decodeDevelopmentManifest(unit);
      const links = developmentLinkImports(
        unit.name,
        manifest,
        manifest.links,
        {},
        () => {
          const active = instances.get(unit.name);
          if (active === undefined) {
            throw new Error("worker unit called a link before instantiation");
          }
          return active.instance;
        },
        (name) => instances.get(name),
      );
      const instance = await instantiateArtifact(unit, capabilities, {
        links,
        scope: lifetime,
        callLink: (link, arguments_, context) => {
          const provider = hosted.get(link.unit);
          if (provider === undefined) {
            throw new Error("worker lost its scoped provider");
          }
          return provider.callLinked(
            `blot:dev:${link.name}`,
            arguments_,
            context,
          );
        },
      });
      hosted.set(unit.name, instance);
      instances.set(unit.name, {
        artifact: unit,
        manifest,
        instance: instance.instance,
      });
    }
    const entry = hosted.get(entryName);
    if (entry === undefined) {
      throw new Error("worker lost its compiled entry unit");
    }
    return { entry, lifetime, shared };
  } catch (error) {
    try {
      await lifetime.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "worker instantiation and cleanup failed",
      );
    }
    throw error;
  }
}

/** Execute checked callback entries against private Wasm heaps in a worker. */
export function serveWorker(port: WorkerPort): void {
  const programs = new Map<number, WorkerProgram>();
  const running = new Map<number, AbortController>();
  let retirement = Promise.resolve();
  port.onMessage((message) => {
    const request = workerRequest(message);
    if (request.kind === "install") {
      if (programs.has(request.program)) {
        throw new Error("worker program was installed twice");
      }
      programs.set(request.program, {
        module: request.module,
        manifestBytes: request.manifestBytes,
        development: request.development,
        instance: undefined,
      });
      return;
    }
    if (request.kind === "uninstall") {
      if (running.size > 0) {
        throw new Error("worker cannot retire a running program");
      }
      const program = programs.get(request.program);
      if (program === undefined) {
        throw new Error("worker program was not installed");
      }
      programs.delete(request.program);
      retirement = retirement.then(async () => {
        if (program.instance === undefined) return;
        const instance = await program.instance;
        await instance.lifetime.close();
      });
      return;
    }
    if (request.kind === "cancel") {
      running.get(request.job)?.abort(
        new DOMException("worker job cancelled", "AbortError"),
      );
      return;
    }
    if (running.size > 0) throw new Error("worker received overlapping jobs");
    const controller = new AbortController();
    running.set(request.job, controller);
    void (async () => {
      await retirement;
      const program = programs.get(request.program);
      if (program === undefined) {
        throw new Error("worker callback has no installed program");
      }
      if (program.instance === undefined) {
        program.instance = instantiateProgram(program);
      }
      const instance = await program.instance;
      const scope = new HostScope(instance.lifetime);
      try {
        let arguments_ = request.arguments;
        if (request.shared !== undefined) {
          const entry = decodeManifest(program.manifestBytes).callbacks.find((
            entry,
          ) => entry.name === request.entry);
          if (
            entry === undefined ||
            entry.function.parameters.length !== arguments_.length ||
            arguments_.length === 0
          ) {
            throw new TypeError("shared worker kernel has no checked argument");
          }
          arguments_ = [
            instance.shared.restore(
              entry.function.parameters[0],
              arguments_[0],
              request.shared,
              scope,
            ),
            ...arguments_.slice(1),
          ];
        }
        port.postMessage({ kind: "started", job: request.job });
        return await instance.entry.callCallback(
          request.entry,
          arguments_,
          {
            signal: controller.signal,
            scope,
          },
        );
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          program.instance = undefined;
          await instance.lifetime.close();
        }
        throw error;
      } finally {
        await scope.close();
      }
    })().then((value) => {
      const response: WorkerResponse = {
        kind: "returned",
        job: request.job,
        value,
      };
      port.postMessage(response);
    }, (error: unknown) => {
      let response: WorkerResponse;
      if (controller.signal.aborted) {
        response = { kind: "cancelled", job: request.job };
      } else if (error instanceof Error) {
        response = {
          kind: "failed",
          job: request.job,
          name: error.name,
          message: error.message,
        };
      } else {response = {
          kind: "failed",
          job: request.job,
          name: "Error",
          message: String(error),
        };}
      port.postMessage(response);
    }).finally(() => {
      running.delete(request.job);
    });
  });
}
