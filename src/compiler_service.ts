import { isAbsolute, resolve } from "@std/path";
import { BlotCompilerSession, type WasmManifest } from "./backend/compile.ts";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4765;
const PROTOCOL_VERSION = "1";
const MAXIMUM_REQUEST_BYTES = 64 * 1024;

export interface CompilerServerOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface CompilerServer {
  readonly url: string;
  readonly finished: Promise<void>;
  shutdown(): Promise<void>;
}

export interface CompilerServiceBuild {
  readonly wasm: Uint8Array<ArrayBuffer>;
  readonly manifest: WasmManifest;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  readonly capabilities: readonly string[];
}

export async function startCompilerServer(
  options: CompilerServerOptions = {},
): Promise<CompilerServer> {
  if (
    options === null || typeof options !== "object" || Array.isArray(options)
  ) {
    throw new TypeError("Blot compiler server options must be an object.");
  }
  let hostname = DEFAULT_HOSTNAME;
  if (options.hostname !== undefined) hostname = options.hostname;
  let port = DEFAULT_PORT;
  if (options.port !== undefined) port = options.port;
  if (hostname !== DEFAULT_HOSTNAME && hostname !== "::1") {
    throw new TypeError(
      `Blot compiler server must bind a loopback address; received ${
        JSON.stringify(hostname)
      }.`,
    );
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(
      `Blot compiler server port must be 0..65535; received ${port}.`,
    );
  }

  const session = await BlotCompilerSession.create();
  let nextBuild = Promise.resolve();
  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve(
      { hostname, port, onListen: () => {} },
      async (request) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname === "/health" && request.method === "GET") {
          return Response.json({
            protocol: Number(PROTOCOL_VERSION),
            ready: true,
          });
        }
        const writesArtifact = requestUrl.pathname === "/v1/build-file";
        if (
          (requestUrl.pathname !== "/v1/build" && !writesArtifact) ||
          request.method !== "POST"
        ) {
          return Response.json(
            {
              message:
                `No compiler service route for ${request.method} ${requestUrl.pathname}.`,
            },
            { status: 404 },
          );
        }
        if (request.headers.get("x-blot-protocol") !== PROTOCOL_VERSION) {
          return Response.json(
            {
              message:
                `Blot compiler service requires protocol ${PROTOCOL_VERSION}.`,
            },
            { status: 409 },
          );
        }
        const contentLength = Number(request.headers.get("content-length"));
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAXIMUM_REQUEST_BYTES
        ) {
          return Response.json(
            {
              message:
                `Blot compiler request is ${contentLength} bytes; maximum is ${MAXIMUM_REQUEST_BYTES}.`,
            },
            { status: 413 },
          );
        }

        let path: string;
        try {
          const requestBody = await request.text();
          const requestByteLength =
            new TextEncoder().encode(requestBody).byteLength;
          if (requestByteLength > MAXIMUM_REQUEST_BYTES) {
            return Response.json(
              {
                message:
                  `Blot compiler request is ${requestByteLength} bytes; maximum is ${MAXIMUM_REQUEST_BYTES}.`,
              },
              { status: 413 },
            );
          }
          if (writesArtifact) {
            const form = new URLSearchParams(requestBody);
            const requestedPath = form.get("path");
            if (requestedPath === null || requestedPath.length === 0) {
              throw new TypeError(
                "compiler request must contain a non-empty path field",
              );
            }
            path = requestedPath;
          } else {
            const body: unknown = JSON.parse(requestBody);
            if (
              body === null || typeof body !== "object" ||
              Array.isArray(body) ||
              !("path" in body) || typeof body.path !== "string" ||
              body.path.length === 0
            ) {
              throw new TypeError(
                "compiler request must contain a non-empty path string",
              );
            }
            path = body.path;
          }
          if (!isAbsolute(path)) {
            throw new TypeError(
              `compiler request path must be absolute; received ${
                JSON.stringify(path)
              }`,
            );
          }
        } catch (error) {
          return Response.json(
            {
              message: `Invalid Blot compiler request: ${errorMessage(error)}.`,
            },
            { status: 400 },
          );
        }

        const previousBuild = nextBuild;
        let releaseBuild!: () => void;
        nextBuild = new Promise((resolveBuild) => releaseBuild = resolveBuild);
        await previousBuild;
        try {
          const built = await session.build(path);
          if (writesArtifact) {
            if (!path.endsWith(".blot")) {
              throw new TypeError(
                `compiler output path requires a .blot source; received ${
                  JSON.stringify(path)
                }`,
              );
            }
            const outputPath = path.slice(0, -".blot".length) + ".wasm";
            const manifestPath = `${outputPath}.json`;
            await Promise.all([
              Deno.writeFile(outputPath, built.wasm),
              Deno.writeFile(manifestPath, built.manifestBytes),
            ]);
            let imports = "";
            if (built.capabilities.length > 0) {
              imports = `, imports { ${built.capabilities.join(", ")} }`;
            }
            return new Response(
              `${outputPath}: ${built.wasm.byteLength} bytes${imports}, manifest ${manifestPath}\n`,
              { headers: { "content-type": "text/plain; charset=utf-8" } },
            );
          }
          const responseBody = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(built.manifestBytes);
              controller.enqueue(built.wasm);
              controller.close();
            },
          });
          return new Response(responseBody, {
            headers: {
              "content-type": "application/vnd.blot.compiler-build",
              "x-blot-manifest-byte-length": String(
                built.manifestBytes.byteLength,
              ),
              "x-blot-protocol": PROTOCOL_VERSION,
            },
          });
        } catch (error) {
          return Response.json(
            {
              message: `Could not compile ${JSON.stringify(path)}: ${
                errorMessage(error)
              }`,
            },
            { status: 422 },
          );
        } finally {
          releaseBuild();
        }
      },
    );
  } catch (error) {
    session.destroy();
    throw error;
  }

  const address = server.addr;
  let displayHostname = address.hostname;
  if (address.hostname.includes(":")) displayHostname = `[${address.hostname}]`;
  const finished = server.finished.finally(() => session.destroy());
  return {
    url: `http://${displayHostname}:${address.port}`,
    finished,
    async shutdown(): Promise<void> {
      await server.shutdown();
      await finished;
    },
  };
}

export async function buildWithCompilerService(
  path: string,
  serviceUrl = `http://${DEFAULT_HOSTNAME}:${DEFAULT_PORT}`,
): Promise<CompilerServiceBuild> {
  const absolutePath = resolve(path);
  let response: Response;
  try {
    response = await fetch(new URL("/v1/build", serviceUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-blot-protocol": PROTOCOL_VERSION,
      },
      body: JSON.stringify({ path: absolutePath }),
    });
  } catch (error) {
    throw new Error(
      `could not reach Blot compiler service at ${
        JSON.stringify(serviceUrl)
      }: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const failure: unknown = await response.json();
      if (
        failure !== null && typeof failure === "object" &&
        !Array.isArray(failure) &&
        "message" in failure && typeof failure.message === "string"
      ) message = failure.message;
    } catch (error) {
      throw new Error(
        `Blot compiler service returned ${message} and an invalid error body: ${
          errorMessage(error)
        }`,
        { cause: error },
      );
    }
    throw new Error(
      `Blot compiler service rejected ${
        JSON.stringify(absolutePath)
      }: ${message}`,
    );
  }
  const responseProtocol = response.headers.get("x-blot-protocol");
  if (responseProtocol !== PROTOCOL_VERSION) {
    throw new Error(
      `Blot compiler service returned protocol ${
        JSON.stringify(responseProtocol)
      }; expected ${PROTOCOL_VERSION}.`,
    );
  }

  const manifestByteLength = Number(
    response.headers.get("x-blot-manifest-byte-length"),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    !Number.isSafeInteger(manifestByteLength) || manifestByteLength < 0 ||
    manifestByteLength > bytes.byteLength
  ) {
    throw new Error(
      `Blot compiler service returned manifest length ${manifestByteLength} for ${bytes.byteLength} response bytes.`,
    );
  }
  const manifestBytes = bytes.slice(0, manifestByteLength);
  const wasm = bytes.slice(manifestByteLength);
  let manifest: WasmManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as WasmManifest;
  } catch (error) {
    throw new Error(
      `Blot compiler service returned an invalid manifest for ${
        JSON.stringify(absolutePath)
      }: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (manifest.format !== "blot-core-wasm") {
    throw new Error(
      `Blot compiler service returned manifest format ${
        JSON.stringify(manifest.format)
      }.`,
    );
  }
  return {
    wasm,
    manifest,
    manifestBytes,
    capabilities: [
      ...new Set(manifest.imports.map((imported) => imported.capability)),
    ],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
