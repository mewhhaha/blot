// Independent recipe oracle for the engine's tree regressions. This enumerates
// coordinates directly, without Blot, streaming batches, or compiler artifacts.
// Origins are in detail-grid units; render coordinates are scaled by 225.
export function treeGeometry(kind, seed, origin = [0, 0, 0]) {
  if (kind !== "oak" && kind !== "fir") throw new Error(`unknown tree ${kind}`);
  const voxels = [];
  let height = 29;
  if (kind === "oak") height = 32;
  const directions = [[5, 1], [-4, 3], [-2, -5], [4, -3], [1, 5]];
  for (let z = -12; z <= 12; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = -12; x <= 12; x += 1) {
        let color;
        if (kind === "oak") {
          const trunk = y <= 22 && x * x + z * z <= 4;
          const branch = y >= 12 && y <= 22 && directions.some(([dx, dz]) => {
            const bx = x - Math.trunc(dx * (y - 12) / 5);
            const bz = z - Math.trunc(dz * (y - 12) / 5);
            return bx * bx + bz * bz <= 4;
          });
          const crown = x * x * 2 + (y - 22) ** 2 * 3 + z * z * 2 <= 300;
          const edge = Math.abs(x * 19 + y * 31 + z * 43 + seed) % 11;
          if (!(trunk || branch || crown && edge > 1)) continue;
          color = [55, 129, 62];
          if (trunk || branch) color = [88, 57, 38];
          else if (edge < 5) color = [37, 92, 48];
          else if (edge > 8) color = [92, 164, 71];
        } else {
          const trunk = x * x + z * z <= 4;
          const radius = 14 - Math.trunc(y / 2);
          const cross = y >= 8 && y < 28 &&
            (Math.abs(x) <= radius && Math.abs(z) <= 2 ||
              Math.abs(z) <= radius && Math.abs(x) <= 2);
          const sparse = Math.abs(x * 23 + y * 37 + z * 41 + seed) % 9;
          if (!(trunk || cross && sparse > 0)) continue;
          color = [[26, 76, 54], [39, 111, 70], [78, 145, 82]][y % 3];
          if (trunk) color = [91, 61, 42];
        }
        voxels.push([
          (origin[0] + x) * 225,
          (origin[1] + y) * 225,
          (origin[2] + z) * 225,
          225,
          ...color,
        ]);
      }
    }
  }
  return voxels;
}
