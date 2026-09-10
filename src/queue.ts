interface Entry<T> {
  readonly value: T;
  previous: Entry<T> | undefined;
  next: Entry<T> | undefined;
  linked: boolean;
}

/** FIFO admission with constant-time removal of cancelled registrations. */
export class Queue<T> {
  #first: Entry<T> | undefined;
  #last: Entry<T> | undefined;
  #size = 0;

  get size(): number {
    return this.#size;
  }

  peek(): T | undefined {
    return this.#first?.value;
  }

  push(value: T): () => void {
    const entry: Entry<T> = {
      value,
      previous: this.#last,
      next: undefined,
      linked: true,
    };
    if (this.#last === undefined) this.#first = entry;
    else this.#last.next = entry;
    this.#last = entry;
    this.#size += 1;
    return () => this.#remove(entry);
  }

  shift(): T | undefined {
    const entry = this.#first;
    if (entry === undefined) return undefined;
    this.#remove(entry);
    return entry.value;
  }

  clear(): void {
    while (this.#first !== undefined) this.#remove(this.#first);
  }

  #remove(entry: Entry<T>): void {
    if (!entry.linked) return;
    if (entry.previous === undefined) this.#first = entry.next;
    else entry.previous.next = entry.next;
    if (entry.next === undefined) this.#last = entry.previous;
    else entry.next.previous = entry.previous;
    entry.previous = undefined;
    entry.next = undefined;
    entry.linked = false;
    this.#size -= 1;
  }
}
