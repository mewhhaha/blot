import { Compiler, type CompilerArtifact } from "../../src/compiler/session.ts";

const TICK = 0;
const RUNNING = 1;
const YAW = 2;
const PITCH = 3;
const DISTANCE = 4;
const LENS = 5;
const SELECTION = 6;

const SCREEN_WIDTH = 480;
const SCREEN_HEIGHT = 300;
const VERTEX_WIDTH = 9;
const INITIAL_VERTEX_CAPACITY = 4096;
const CUBE_VERTEX_WIDTH = 6;
const CUBE_VERTEX_COUNT = 36;
const INSTANCE_WIDTH = 7;
const INITIAL_INSTANCE_CAPACITY = 256;
const GAME_LOOP_SOURCE = "case-studies/engine/game_loop.blot";
const DEPTH_FORMAT = "depth24plus";
const SAMPLE_COUNT = 4;
const NEAR_DEPTH = 250;
const CAMERA_SUBSTEPS = 16;
const CAMERA_TURN = 256 * CAMERA_SUBSTEPS;
const ORBIT_UNITS_PER_PIXEL = 6;
const ZOOM_RATE = 0.05;
const MAX_ZOOM_EXPONENT = 0.4;
const ZOOM_REFRESH_DELAY = 80;
const MIN_CAMERA_DISTANCE = 2000;
const MAX_CAMERA_DISTANCE = 60000;
// A streaming guest can draw before Deno Desktop's new surface is presentable.
const MAX_SURFACE_FAILURES = 120;
interface Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface Triangle {
  readonly kind: "tri";
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly depth: number;
  readonly shade: number;
  readonly color: Color;
}

interface Sprite {
  readonly kind: "sprite";
  readonly depth: number;
  readonly size: number;
  readonly texture: string;
  readonly x: number;
  readonly y: number;
}

interface Voxel {
  readonly kind: "voxel";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly color: Color;
}

type Renderable = Triangle | Sprite | Voxel;

const cubeVertices = new Float32Array([
  0.5,
  -0.5,
  -0.5,
  0,
  0,
  -1,
  -0.5,
  -0.5,
  -0.5,
  0,
  0,
  -1,
  -0.5,
  0.5,
  -0.5,
  0,
  0,
  -1,
  0.5,
  -0.5,
  -0.5,
  0,
  0,
  -1,
  -0.5,
  0.5,
  -0.5,
  0,
  0,
  -1,
  0.5,
  0.5,
  -0.5,
  0,
  0,
  -1,

  -0.5,
  -0.5,
  0.5,
  0,
  0,
  1,
  0.5,
  -0.5,
  0.5,
  0,
  0,
  1,
  0.5,
  0.5,
  0.5,
  0,
  0,
  1,
  -0.5,
  -0.5,
  0.5,
  0,
  0,
  1,
  0.5,
  0.5,
  0.5,
  0,
  0,
  1,
  -0.5,
  0.5,
  0.5,
  0,
  0,
  1,

  -0.5,
  -0.5,
  -0.5,
  -1,
  0,
  0,
  -0.5,
  -0.5,
  0.5,
  -1,
  0,
  0,
  -0.5,
  0.5,
  0.5,
  -1,
  0,
  0,
  -0.5,
  -0.5,
  -0.5,
  -1,
  0,
  0,
  -0.5,
  0.5,
  0.5,
  -1,
  0,
  0,
  -0.5,
  0.5,
  -0.5,
  -1,
  0,
  0,

  0.5,
  -0.5,
  0.5,
  1,
  0,
  0,
  0.5,
  -0.5,
  -0.5,
  1,
  0,
  0,
  0.5,
  0.5,
  -0.5,
  1,
  0,
  0,
  0.5,
  -0.5,
  0.5,
  1,
  0,
  0,
  0.5,
  0.5,
  -0.5,
  1,
  0,
  0,
  0.5,
  0.5,
  0.5,
  1,
  0,
  0,

  -0.5,
  0.5,
  -0.5,
  0,
  1,
  0,
  -0.5,
  0.5,
  0.5,
  0,
  1,
  0,
  0.5,
  0.5,
  0.5,
  0,
  1,
  0,
  -0.5,
  0.5,
  -0.5,
  0,
  1,
  0,
  0.5,
  0.5,
  0.5,
  0,
  1,
  0,
  0.5,
  0.5,
  -0.5,
  0,
  1,
  0,

  -0.5,
  -0.5,
  -0.5,
  0,
  -1,
  0,
  0.5,
  -0.5,
  -0.5,
  0,
  -1,
  0,
  0.5,
  -0.5,
  0.5,
  0,
  -1,
  0,
  -0.5,
  -0.5,
  -0.5,
  0,
  -1,
  0,
  0.5,
  -0.5,
  0.5,
  0,
  -1,
  0,
  -0.5,
  -0.5,
  0.5,
  0,
  -1,
  0,
]);

const compiler = await Compiler.create();
const compileGameLoop = async (): Promise<{
  readonly artifact: CompilerArtifact;
  readonly exportName: string;
}> => {
  const artifact = await compiler.compile(GAME_LOOP_SOURCE);
  const manifest = JSON.parse(
    new TextDecoder().decode(artifact.manifestBytes),
  ) as {
    readonly exports: readonly {
      readonly sourceName: string;
      readonly name: string | null;
    }[];
  };
  const defaultExport = manifest.exports.find((candidate) =>
    candidate.sourceName === "default"
  );
  if (defaultExport === undefined || defaultExport.name === null) {
    throw new Error("game_loop.blot did not publish a runtime default export");
  }
  return { artifact, exportName: defaultExport.name };
};

const initialProgram = await compileGameLoop();
let activeProgram = initialProgram;

const adapter = await navigator.gpu.requestAdapter({
  powerPreference: "high-performance",
});
if (adapter === null) throw new Error("no WebGPU adapter is available");
const device = await adapter.requestDevice();

const desktopWindow = new Deno.BrowserWindow({
  title: "Blot game loop — perspective",
  width: 960,
  height: 600,
});
const surface = desktopWindow.getNativeWindow();
const context = surface.getContext("webgpu") as GPUCanvasContext | null;
if (context === null) {
  throw new Error("the native window did not provide a WebGPU surface");
}
const format = navigator.gpu.getPreferredCanvasFormat();
let depthTexture: GPUTexture | undefined;
let multisampleTexture: GPUTexture | undefined;

const resize = () => {
  const [width, height] = desktopWindow.getSize();
  surface.width = width;
  surface.height = height;
  context.configure({ device, format, alphaMode: "opaque" });
  depthTexture?.destroy();
  multisampleTexture?.destroy();
  depthTexture = device.createTexture({
    size: [width, height],
    format: DEPTH_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    sampleCount: SAMPLE_COUNT,
  });
  multisampleTexture = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    sampleCount: SAMPLE_COUNT,
  });
};
resize();
desktopWindow.addEventListener("resize", () => {
  resize();
  requestGpuFrame();
});

const shader = device.createShaderModule({
  code: `
    struct VertexInput {
      @location(0) position: vec2f,
      @location(1) color: vec3f,
      @location(2) uv: vec2f,
      @location(3) texture_kind: f32,
      @location(4) depth: f32,
    };

    struct VertexOutput {
      @builtin(position) position: vec4f,
      @location(0) color: vec3f,
      @location(1) uv: vec2f,
      @location(2) @interpolate(flat) texture_kind: f32,
    };

    struct CameraAdjustment {
      rendered_distance: f32,
      current_distance: f32,
      lens: f32,
      _padding: f32,
    };

    @group(0) @binding(0) var<uniform> camera: CameraAdjustment;

    @vertex
    fn vertex(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      let screen_centre = vec2f(
        ${SCREEN_WIDTH / 2}.0,
        ${SCREEN_HEIGHT / 2}.0,
      );
      let rendered_depth = input.depth / 1000.0;
      let distance_delta =
        (camera.current_distance - camera.rendered_distance) / 1000.0;
      let current_depth = max(rendered_depth + distance_delta, 0.001);
      var projection_scale = rendered_depth / current_depth;
      if camera.lens >= 0.5 {
        projection_scale = camera.rendered_distance / camera.current_distance;
      }
      let position = screen_centre +
        (input.position - screen_centre) * projection_scale;
      output.position = vec4f(
        position.x / ${SCREEN_WIDTH}.0 * 2.0 - 1.0,
        1.0 - position.y / ${SCREEN_HEIGHT}.0 * 2.0,
        clamp(1.0 - ${NEAR_DEPTH / 1000} / current_depth, 0.0, 1.0),
        1.0,
      );
      output.color = input.color;
      output.uv = input.uv;
      output.texture_kind = input.texture_kind;
      return output;
    }

    @fragment
    fn fragment(input: VertexOutput) -> @location(0) vec4f {
      if input.texture_kind < 0.5 {
        return vec4f(input.color, 1.0);
      }

      let centred = input.uv * 2.0 - vec2f(1.0, 1.0);
      var alpha = 1.0;
      if input.texture_kind < 1.5 {
        let ring = abs(length(centred) - 0.68);
        alpha = 1.0 - smoothstep(0.10, 0.16, ring);
      } else if input.texture_kind < 2.5 {
        let cell = abs(fract(input.uv * 4.0) - vec2f(0.5, 0.5));
        let line = max(cell.x, cell.y);
        alpha = 1.0 - smoothstep(0.42, 0.48, line);
      } else {
        alpha = 1.0 - smoothstep(0.05, 1.0, length(centred));
      }
      if alpha <= 0.01 {
        discard;
      }
      return vec4f(input.color, alpha);
    }
  `,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: {
    module: shader,
    entryPoint: "vertex",
    buffers: [{
      arrayStride: VERTEX_WIDTH * Float32Array.BYTES_PER_ELEMENT,
      attributes: [{
        shaderLocation: 0,
        offset: 0,
        format: "float32x2",
      }, {
        shaderLocation: 1,
        offset: 2 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32x3",
      }, {
        shaderLocation: 2,
        offset: 5 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32x2",
      }, {
        shaderLocation: 3,
        offset: 7 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32",
      }, {
        shaderLocation: 4,
        offset: 8 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32",
      }],
    }],
  },
  fragment: {
    module: shader,
    entryPoint: "fragment",
    targets: [{
      format,
      blend: {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
        alpha: {
          srcFactor: "one",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
      },
    }],
  },
  primitive: { topology: "triangle-list" },
  depthStencil: {
    format: DEPTH_FORMAT,
    depthWriteEnabled: true,
    depthCompare: "less",
  },
  multisample: { count: SAMPLE_COUNT },
});

const voxelShader = device.createShaderModule({
  code: `
    struct Camera {
      yaw: f32,
      pitch: f32,
      distance: f32,
      lens: f32,
    };

    struct VertexInput {
      @location(0) corner: vec3f,
      @location(1) normal: vec3f,
      @location(2) position: vec3f,
      @location(3) scale: f32,
      @location(4) color: vec3f,
    };

    struct VertexOutput {
      @builtin(position) position: vec4f,
      @location(0) @interpolate(flat) color: vec3f,
    };

    @group(0) @binding(0) var<uniform> camera: Camera;

    @vertex
    fn vertex(input: VertexInput) -> VertexOutput {
      let yaw = camera.yaw * ${Math.PI * 2 / CAMERA_TURN};
      let pitch = camera.pitch * ${Math.PI * 2 / CAMERA_TURN};
      let sin_yaw = sin(yaw);
      let cos_yaw = cos(yaw);
      let sin_pitch = sin(pitch);
      let cos_pitch = cos(pitch);
      let world = input.position + input.corner * input.scale;
      let view = vec3f(
        cos_yaw * world.x - sin_yaw * world.z,
        -sin_pitch * sin_yaw * world.x + cos_pitch * world.y -
          sin_pitch * cos_yaw * world.z,
        -cos_pitch * sin_yaw * world.x - sin_pitch * world.y -
          cos_pitch * cos_yaw * world.z + camera.distance,
      );

      var output: VertexOutput;
      if camera.lens < 0.5 {
        output.position = vec4f(
          view.x * ${420 / (SCREEN_WIDTH / 2)},
          view.y * ${420 / (SCREEN_HEIGHT / 2)},
          view.z - ${NEAR_DEPTH / 1000},
          view.z,
        );
      } else {
        let zoom = 420.0 / camera.distance;
        output.position = vec4f(
          view.x * zoom / ${SCREEN_WIDTH / 2},
          view.y * zoom / ${SCREEN_HEIGHT / 2},
          1.0 - ${NEAR_DEPTH / 1000} / max(view.z, 0.0001),
          1.0,
        );
      }

      let light = vec3f(0.53, 0.76, 0.38);
      let shade = (60.0 + max(dot(input.normal, light), 0.0) * 195.0) /
        255.0;
      output.color = input.color * shade;
      return output;
    }

    @fragment
    fn fragment(input: VertexOutput) -> @location(0) vec4f {
      return vec4f(input.color, 1.0);
    }
  `,
});

const voxelPipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: {
    module: voxelShader,
    entryPoint: "vertex",
    buffers: [{
      arrayStride: CUBE_VERTEX_WIDTH * Float32Array.BYTES_PER_ELEMENT,
      attributes: [{
        shaderLocation: 0,
        offset: 0,
        format: "float32x3",
      }, {
        shaderLocation: 1,
        offset: 3 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32x3",
      }],
    }, {
      arrayStride: INSTANCE_WIDTH * Float32Array.BYTES_PER_ELEMENT,
      stepMode: "instance",
      attributes: [{
        shaderLocation: 2,
        offset: 0,
        format: "float32x3",
      }, {
        shaderLocation: 3,
        offset: 3 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32",
      }, {
        shaderLocation: 4,
        offset: 4 * Float32Array.BYTES_PER_ELEMENT,
        format: "float32x3",
      }],
    }],
  },
  fragment: {
    module: voxelShader,
    entryPoint: "fragment",
    targets: [{ format }],
  },
  primitive: { topology: "triangle-list", cullMode: "back" },
  depthStencil: {
    format: DEPTH_FORMAT,
    depthWriteEnabled: true,
    depthCompare: "less",
  },
  multisample: { count: SAMPLE_COUNT },
});

let vertexCapacity = INITIAL_VERTEX_CAPACITY;
let vertexBuffer = device.createBuffer({
  size: vertexCapacity * VERTEX_WIDTH * Float32Array.BYTES_PER_ELEMENT,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
const cameraBuffer = device.createBuffer({
  size: 4 * Float32Array.BYTES_PER_ELEMENT,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const cameraBindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});
const voxelCameraBindGroup = device.createBindGroup({
  layout: voxelPipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});
const cubeVertexBuffer = device.createBuffer({
  size: cubeVertices.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(cubeVertexBuffer, 0, cubeVertices);
let instanceCapacity = INITIAL_INSTANCE_CAPACITY;
let instanceBuffer = device.createBuffer({
  size: instanceCapacity * INSTANCE_WIDTH * Float32Array.BYTES_PER_ELEMENT,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

const clamp = (value: number, minimum: number, maximum: number): number => {
  return Math.max(minimum, Math.min(maximum, value));
};

const appendVertex = (
  vertices: number[],
  x: number,
  y: number,
  color: readonly [number, number, number],
  u: number,
  v: number,
  textureKind: number,
  depth: number,
): void => {
  vertices.push(
    x,
    y,
    color[0],
    color[1],
    color[2],
    u,
    v,
    textureKind,
    depth,
  );
};

let consecutiveSurfaceFailures = 0;
let uploadedVertexCount = 0;
let uploadedInstanceCount = 0;
let renderedCameraDistance = 18000;
let renderedLens = 0;
let renderMode: "projected" | "voxels" = "projected";
const uploadFrame = (
  renderables: readonly Renderable[],
  distance: number,
  lens: number,
): void => {
  const hasVoxels = renderables.some((renderable) =>
    renderable.kind === "voxel"
  );
  if (hasVoxels) {
    if (!renderables.every((renderable) => renderable.kind === "voxel")) {
      const kinds = [
        ...new Set(renderables.map((renderable) => renderable.kind)),
      ];
      throw new Error(
        `game loop mixed incompatible render batches: ${kinds.join(", ")}`,
      );
    }
    renderMode = "voxels";
    uploadedInstanceCount = renderables.length;
    if (uploadedInstanceCount > instanceCapacity) {
      let nextCapacity = instanceCapacity;
      while (nextCapacity < uploadedInstanceCount) nextCapacity *= 2;
      const nextSize = nextCapacity * INSTANCE_WIDTH *
        Float32Array.BYTES_PER_ELEMENT;
      if (nextSize > device.limits.maxBufferSize) {
        throw new Error(
          `game loop produced ${uploadedInstanceCount} voxel instances (${nextSize} bytes), beyond this adapter's ${device.limits.maxBufferSize}-byte buffer limit`,
        );
      }
      const previousBuffer = instanceBuffer;
      instanceBuffer = device.createBuffer({
        size: nextSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      instanceCapacity = nextCapacity;
      previousBuffer.destroy();
      console.log(`grew the instance buffer to ${instanceCapacity} voxels`);
    }
    const instances = new Float32Array(
      uploadedInstanceCount * INSTANCE_WIDTH,
    );
    let offset = 0;
    for (const voxel of renderables) {
      instances[offset] = voxel.x;
      instances[offset + 1] = voxel.y;
      instances[offset + 2] = voxel.z;
      instances[offset + 3] = voxel.scale;
      instances[offset + 4] = clamp(voxel.color.red, 0, 255) / 255;
      instances[offset + 5] = clamp(voxel.color.green, 0, 255) / 255;
      instances[offset + 6] = clamp(voxel.color.blue, 0, 255) / 255;
      offset += INSTANCE_WIDTH;
    }
    device.queue.writeBuffer(instanceBuffer, 0, instances);
    requestGpuFrame();
    return;
  }

  renderMode = "projected";
  const vertices: number[] = [];
  let ordered: readonly (Triangle | Sprite)[] = renderables.filter(
    (renderable): renderable is Triangle | Sprite =>
      renderable.kind !== "voxel",
  );
  if (renderables.some((renderable) => renderable.kind === "sprite")) {
    const triangles = renderables.filter((renderable) =>
      renderable.kind === "tri"
    );
    const sprites = renderables.filter((renderable) =>
      renderable.kind === "sprite"
    ).sort((left, right) => right.depth - left.depth);
    ordered = [...triangles, ...sprites];
  }
  for (const renderable of ordered) {
    if (renderable.kind === "tri") {
      const shade = clamp(renderable.shade, 0, 255) / 255;
      const color: [number, number, number] = [
        clamp(renderable.color.red, 0, 255) / 255 * shade,
        clamp(renderable.color.green, 0, 255) / 255 * shade,
        clamp(renderable.color.blue, 0, 255) / 255 * shade,
      ];
      appendVertex(
        vertices,
        renderable.ax,
        renderable.ay,
        color,
        0,
        0,
        0,
        renderable.az,
      );
      appendVertex(
        vertices,
        renderable.bx,
        renderable.by,
        color,
        0,
        0,
        0,
        renderable.bz,
      );
      appendVertex(
        vertices,
        renderable.cx,
        renderable.cy,
        color,
        0,
        0,
        0,
        renderable.cz,
      );
      continue;
    }

    const half = Math.max(2, renderable.size) / 2;
    let textureKind = 3;
    let color: [number, number, number] = [1, 0.74, 0.18];
    if (renderable.texture === "ring") {
      textureKind = 1;
      color = [0.49, 0.88, 1];
    } else if (renderable.texture === "grid") {
      textureKind = 2;
      color = [0.73, 0.55, 1];
    }
    const left = renderable.x - half;
    const right = renderable.x + half;
    const top = renderable.y - half;
    const bottom = renderable.y + half;
    appendVertex(
      vertices,
      left,
      top,
      color,
      0,
      0,
      textureKind,
      renderable.depth,
    );
    appendVertex(
      vertices,
      right,
      top,
      color,
      1,
      0,
      textureKind,
      renderable.depth,
    );
    appendVertex(
      vertices,
      right,
      bottom,
      color,
      1,
      1,
      textureKind,
      renderable.depth,
    );
    appendVertex(
      vertices,
      left,
      top,
      color,
      0,
      0,
      textureKind,
      renderable.depth,
    );
    appendVertex(
      vertices,
      right,
      bottom,
      color,
      1,
      1,
      textureKind,
      renderable.depth,
    );
    appendVertex(
      vertices,
      left,
      bottom,
      color,
      0,
      1,
      textureKind,
      renderable.depth,
    );
  }

  uploadedVertexCount = vertices.length / VERTEX_WIDTH;
  renderedCameraDistance = distance;
  renderedLens = lens;
  if (uploadedVertexCount > vertexCapacity) {
    let nextCapacity = vertexCapacity;
    while (nextCapacity < uploadedVertexCount) nextCapacity *= 2;
    const nextSize = nextCapacity * VERTEX_WIDTH *
      Float32Array.BYTES_PER_ELEMENT;
    if (nextSize > device.limits.maxBufferSize) {
      throw new Error(
        `game loop produced ${uploadedVertexCount} vertices (${nextSize} bytes), beyond this adapter's ${device.limits.maxBufferSize}-byte buffer limit`,
      );
    }
    const previousBuffer = vertexBuffer;
    vertexBuffer = device.createBuffer({
      size: nextSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    vertexCapacity = nextCapacity;
    previousBuffer.destroy();
    console.log(`grew the vertex buffer to ${vertexCapacity} vertices`);
  }
  if (vertices.length > 0) {
    device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(vertices));
  }
  requestGpuFrame();
};

const presentGpuFrame = (): void => {
  let cameraUniform = [
    renderedCameraDistance,
    cameraDistance,
    renderedLens,
    0,
  ];
  if (renderMode === "voxels") {
    cameraUniform = [
      Atomics.load(shared, YAW),
      Atomics.load(shared, PITCH),
      cameraDistance / 1000,
      Atomics.load(shared, LENS),
    ];
  }
  device.queue.writeBuffer(
    cameraBuffer,
    0,
    new Float32Array(cameraUniform),
  );
  const encoder = device.createCommandEncoder();
  let texture: GPUTexture;
  try {
    texture = context.getCurrentTexture();
    consecutiveSurfaceFailures = 0;
  } catch (error) {
    consecutiveSurfaceFailures += 1;
    if (consecutiveSurfaceFailures >= MAX_SURFACE_FAILURES) {
      throw new Error(
        `native WebGPU surface remained unavailable for ${consecutiveSurfaceFailures} frames at ${surface.width}x${surface.height}`,
        { cause: error },
      );
    }
    resize();
    requestGpuFrame();
    return;
  }
  if (depthTexture === undefined || multisampleTexture === undefined) {
    throw new Error("the native WebGPU frame attachments were not initialized");
  }
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: multisampleTexture.createView(),
      resolveTarget: texture.createView(),
      clearValue: { r: 0.031, g: 0.035, b: 0.043, a: 1 },
      loadOp: "clear",
      storeOp: "discard",
    }],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  if (renderMode === "voxels") {
    pass.setPipeline(voxelPipeline);
    pass.setBindGroup(0, voxelCameraBindGroup);
    pass.setVertexBuffer(0, cubeVertexBuffer);
    pass.setVertexBuffer(1, instanceBuffer);
    pass.draw(CUBE_VERTEX_COUNT, uploadedInstanceCount);
  } else {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, cameraBindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(uploadedVertexCount);
  }
  pass.end();
  device.queue.submit([encoder.finish()]);
  surface.present();
};

let gpuFrameTimer: ReturnType<typeof setTimeout> | undefined;
const requestGpuFrame = (): void => {
  if (gpuFrameTimer !== undefined) return;
  gpuFrameTimer = setTimeout(() => {
    gpuFrameTimer = undefined;
    presentGpuFrame();
  }, 0);
};

const shared = new Int32Array(
  new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT),
);
let cameraYaw = 34 * CAMERA_SUBSTEPS;
let cameraPitch = 18 * CAMERA_SUBSTEPS;
let cameraDistance = 18000;
let shrubberySelection = 0;
let selectedShrubberyName: string | undefined;
let shrubberyOptions = new Map<number, string>();
Atomics.store(shared, RUNNING, 1);
Atomics.store(shared, YAW, cameraYaw);
Atomics.store(shared, PITCH, cameraPitch);
Atomics.store(shared, DISTANCE, cameraDistance);
Atomics.store(shared, SELECTION, shrubberySelection);

const streamingGuests = new Set<Worker>();
const wakeGuestFrame = (): void => {
  Atomics.add(shared, TICK, 1);
  Atomics.notify(shared, TICK);
};
let zoomRefreshTimer: ReturnType<typeof setTimeout> | undefined;

let lensName = "perspective";
let activeRevision = 0;
const setWindowTitle = (status = ""): void => {
  let suffix = ` · r${activeRevision}`;
  if (status.length > 0) suffix += ` · ${status}`;
  let title = "Blot shrubbery";
  if (selectedShrubberyName !== undefined) {
    title += ` — ${selectedShrubberyName}`;
  }
  desktopWindow.setTitle(`${title} · ${lensName}${suffix}`);
};
setWindowTitle("starting");

let orbiting = false;
let lastX = 0;
let lastY = 0;
desktopWindow.addEventListener("mousedown", (event: MouseEvent) => {
  if (event.button !== 1) return;
  event.preventDefault();
  orbiting = true;
  lastX = event.clientX;
  lastY = event.clientY;
});
desktopWindow.addEventListener("mouseup", (event: MouseEvent) => {
  if (event.button === 1) orbiting = false;
});
desktopWindow.addEventListener("mouseleave", () => {
  orbiting = false;
});
desktopWindow.addEventListener("mousemove", (event: MouseEvent) => {
  if (!orbiting) return;
  cameraYaw -= (event.clientX - lastX) * ORBIT_UNITS_PER_PIXEL;
  cameraPitch += (event.clientY - lastY) * ORBIT_UNITS_PER_PIXEL;
  cameraPitch = clamp(
    cameraPitch,
    -60 * CAMERA_SUBSTEPS,
    60 * CAMERA_SUBSTEPS,
  );
  const wrappedYaw = ((cameraYaw % CAMERA_TURN) + CAMERA_TURN) % CAMERA_TURN;
  Atomics.store(shared, YAW, Math.round(wrappedYaw));
  Atomics.store(shared, PITCH, Math.round(cameraPitch));
  wakeGuestFrame();
  lastX = event.clientX;
  lastY = event.clientY;
});
desktopWindow.addEventListener("wheel", (event: WheelEvent) => {
  event.preventDefault();
  const exponent = clamp(
    -event.deltaY * ZOOM_RATE,
    -MAX_ZOOM_EXPONENT,
    MAX_ZOOM_EXPONENT,
  );
  cameraDistance = clamp(
    cameraDistance * Math.exp(exponent),
    MIN_CAMERA_DISTANCE,
    MAX_CAMERA_DISTANCE,
  );
  Atomics.store(shared, DISTANCE, Math.round(cameraDistance));
  if (renderMode === "voxels") {
    wakeGuestFrame();
  } else {
    requestGpuFrame();
    if (zoomRefreshTimer !== undefined) clearTimeout(zoomRefreshTimer);
    zoomRefreshTimer = setTimeout(() => {
      zoomRefreshTimer = undefined;
      wakeGuestFrame();
    }, ZOOM_REFRESH_DELAY);
  }
});
desktopWindow.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    desktopWindow.close();
    return;
  }
  const requestedSelection = Number(event.key);
  if (
    Number.isInteger(requestedSelection) &&
    shrubberyOptions.has(requestedSelection)
  ) {
    if (requestedSelection === shrubberySelection) return;
    shrubberySelection = requestedSelection;
    Atomics.store(shared, SELECTION, shrubberySelection);
    setWindowTitle("loading");
    startGuest(activeProgram, activeRevision);
    return;
  }
  if (event.key === "l" || event.key === "L") {
    let lens = 0;
    if (Atomics.load(shared, LENS) === 0) lens = 1;
    Atomics.store(shared, LENS, lens);
    lensName = "perspective";
    if (lens !== 0) lensName = "orthographic";
    setWindowTitle();
    wakeGuestFrame();
  }
});

let activeGuest: Worker | undefined;
let candidateGuest: Worker | undefined;
let closing = false;

const startGuest = (
  program: Awaited<ReturnType<typeof compileGameLoop>>,
  revision: number,
): void => {
  if (candidateGuest !== undefined) {
    streamingGuests.delete(candidateGuest);
    candidateGuest.terminate();
  }
  const guest = new Worker(new URL("worker.js", import.meta.url).href, {
    type: "module",
  });
  const candidateOptions = new Map<number, string>();
  let candidateSelection:
    | { readonly key: number; readonly name: string }
    | undefined;
  candidateGuest = guest;
  streamingGuests.add(guest);

  guest.onmessage = (event) => {
    const message = event.data as {
      readonly kind: string;
      readonly draws?: readonly Renderable[];
      readonly distance?: number;
      readonly lens?: number;
      readonly frames?: number;
      readonly key?: number;
      readonly name?: string;
    };
    if (message.kind === "option") {
      if (
        message.key === undefined || !Number.isInteger(message.key) ||
        message.name === undefined || message.name.length === 0
      ) {
        throw new Error(
          `game-loop option has invalid key or name: ${message.key}, ${message.name}`,
        );
      }
      if (candidateOptions.has(message.key)) {
        throw new Error(`game-loop repeated shrubbery option ${message.key}`);
      }
      candidateOptions.set(message.key, message.name);
      return;
    }
    if (message.kind === "selected") {
      if (
        message.key === undefined || !Number.isInteger(message.key) ||
        message.name === undefined || message.name.length === 0
      ) {
        throw new Error(
          `game-loop selection has invalid key or name: ${message.key}, ${message.name}`,
        );
      }
      candidateSelection = { key: message.key, name: message.name };
      return;
    }
    if (message.kind === "settled") {
      streamingGuests.delete(guest);
      return;
    }
    if (message.kind === "redraw") {
      if (activeGuest === guest) requestGpuFrame();
      return;
    }
    if (message.kind === "frame" && message.draws !== undefined) {
      if (message.distance === undefined || message.lens === undefined) {
        throw new Error("game-loop frame omitted its rendered camera state");
      }
      if (candidateGuest === guest) {
        if (candidateSelection === undefined) {
          throw new Error("game-loop candidate omitted its selected shrubbery");
        }
        const catalogName = candidateOptions.get(candidateSelection.key);
        if (catalogName !== candidateSelection.name) {
          throw new Error(
            `game-loop selected ${candidateSelection.key} as ${candidateSelection.name}, but its catalog names it ${catalogName}`,
          );
        }
        const previousGuest = activeGuest;
        activeGuest = guest;
        candidateGuest = undefined;
        activeProgram = program;
        activeRevision = revision;
        shrubberyOptions = new Map(candidateOptions);
        shrubberySelection = candidateSelection.key;
        selectedShrubberyName = candidateSelection.name;
        Atomics.store(shared, SELECTION, shrubberySelection);
        setWindowTitle();
        if (previousGuest !== undefined) streamingGuests.delete(previousGuest);
        previousGuest?.terminate();
        console.log(`activated game_loop.blot revision ${revision}`);
      }
      if (activeGuest === guest) {
        uploadFrame(message.draws, message.distance, message.lens);
      }
      return;
    }
    if (message.kind === "done") {
      streamingGuests.delete(guest);
      console.log(
        `game loop revision ${revision} stopped after ${message.frames} frames`,
      );
    }
  };
  guest.onerror = (event) => {
    event.preventDefault();
    streamingGuests.delete(guest);
    console.error(`game loop revision ${revision} failed: ${event.message}`);
    if (candidateGuest === guest) {
      candidateGuest = undefined;
      guest.terminate();
      setWindowTitle("reload failed");
      if (activeGuest === undefined && !closing) desktopWindow.close();
      return;
    }
    if (activeGuest === guest && !closing) desktopWindow.close();
  };

  const wasm = Uint8Array.from(program.artifact.wasm).buffer;
  guest.postMessage(
    {
      kind: "start",
      wasm,
      shared: shared.buffer,
      export: program.exportName,
      scene: [],
    },
    [wasm],
  );
};

startGuest(initialProgram, 1);

let reloadRequested = false;
let compiling = false;
const reloadGameLoop = async (): Promise<void> => {
  reloadRequested = true;
  if (compiling) return;
  compiling = true;
  while (reloadRequested && !closing) {
    reloadRequested = false;
    try {
      const program = await compileGameLoop();
      startGuest(program, activeRevision + 1);
    } catch (error) {
      console.error(
        "game_loop.blot reload failed; keeping the last working revision",
        error,
      );
      setWindowTitle("compile failed");
    }
  }
  compiling = false;
};

const sourceWatcher = Deno.watchFs("case-studies/engine", { recursive: true });
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
const watchSources = async (): Promise<void> => {
  for await (const event of sourceWatcher) {
    if (closing) return;
    if (!event.paths.some((path) => path.endsWith(".blot"))) continue;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadGameLoop(), 100);
  }
};
void watchSources();

let frameTimer: ReturnType<typeof setTimeout> | undefined;
const tick = () => {
  if (desktopWindow.isClosed()) return;
  if (streamingGuests.size > 0) wakeGuestFrame();
  frameTimer = setTimeout(tick, 16);
};
frameTimer = setTimeout(tick, 0);

desktopWindow.addEventListener("close", () => {
  closing = true;
  if (frameTimer !== undefined) clearTimeout(frameTimer);
  if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  if (zoomRefreshTimer !== undefined) clearTimeout(zoomRefreshTimer);
  if (gpuFrameTimer !== undefined) clearTimeout(gpuFrameTimer);
  Atomics.store(shared, RUNNING, 0);
  Atomics.add(shared, TICK, 1);
  Atomics.notify(shared, TICK);
  sourceWatcher.close();
  candidateGuest?.terminate();
  activeGuest?.terminate();
  vertexBuffer.destroy();
  instanceBuffer.destroy();
  cubeVertexBuffer.destroy();
  cameraBuffer.destroy();
  depthTexture?.destroy();
  multisampleTexture?.destroy();
  compiler.destroy();
  Deno.exit(0);
});
