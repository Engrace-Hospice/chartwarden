// M23 — an opaque holder for a value that carries the beneficiary's MBI (the 837I input, its rendered payloads).
// The value is reachable only through `reveal()`; every ambient serialisation path (JSON.stringify, String(),
// template literals, util.inspect / console.log, structured logging that walks own properties) yields "[redacted]",
// so a result object that is logged, thrown into an error message or snapshotted by accident leaks nothing.
import { inspect } from "node:util";

const REDACTED = "[redacted]";

export class SensitiveValue<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** The held value. Call it only at the transmit boundary; never store, log or serialise what it returns. */
  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
