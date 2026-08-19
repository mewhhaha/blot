import type { PartitionAlgebra } from "./partition.ts";

/** A rectangular tile of one row-major tensor allocation. */
export interface RectangleFootprint {
  readonly root: string;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * A checked partition-family adapter.
 *
 * Tiles compose only across one complete matching face.  L-shaped unions are
 * intentionally refused because they have no rectangular footprint.  Runtime
 * adapters may lower a tile to one Store plus shape/stride metadata after
 * separately proving the row-major layout witness.
 */
export const RECTANGLE_PARTITIONS: PartitionAlgebra<
  "tensor-rectangle",
  RectangleFootprint
> = {
  sameFamily: (left, right) => left === right,
  samePart: (left, right) =>
    left.root === right.root && left.x0 === right.x0 &&
    left.x1 === right.x1 && left.y0 === right.y0 &&
    left.y1 === right.y1,
  compose: (_family, left, right) => {
    if (left.root !== right.root) return null;
    const horizontal = left.y0 === right.y0 && left.y1 === right.y1 &&
      left.x1 === right.x0;
    if (horizontal) {
      return { ...left, x1: right.x1 };
    }
    const vertical = left.x0 === right.x0 && left.x1 === right.x1 &&
      left.y1 === right.y0;
    if (vertical) {
      return { ...left, y1: right.y1 };
    }
    return null;
  },
};

export function rectangleContains(
  footprint: RectangleFootprint,
  x: number,
  y: number,
): boolean {
  return footprint.x0 <= x && x < footprint.x1 &&
    footprint.y0 <= y && y < footprint.y1;
}
