import assert from "node:assert/strict";
import test from "node:test";
import { Queue } from "../queue.ts";

test("FIFO cancellation unlinks head, middle and tail without disturbing order", () => {
  const queue = new Queue<number>();
  const remove = Array.from({ length: 10000 }, (_, index) => queue.push(index));
  for (let index = 0; index < remove.length; index += 2) remove[index]();
  remove[9999]();
  remove[9999]();
  assert.equal(queue.size, 4999);
  for (let index = 1; index < 9999; index += 2) {
    assert.equal(queue.shift(), index);
  }
  assert.equal(queue.size, 0);
  assert.equal(queue.shift(), undefined);
  queue.push(42);
  assert.equal(queue.peek(), 42);
  queue.clear();
  assert.equal(queue.size, 0);
  remove[3]();
  queue.push(43);
  assert.equal(queue.shift(), 43);
});
