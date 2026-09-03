struct Camera { view_projection: mat4x4<f32>, eye: vec4<f32>, }
struct Material { base_color: vec4<f32>, roughness: f32, metallic: f32, }

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> material: Material;

// SHADER_BODY_SHOULD_NOT_ESCAPE_7F3A
@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((vertex_index << 1u) & 2u);
  let y = f32(vertex_index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
