// apps/backend/src/bootstrap/late-bound.ts — a dependency the composition root builds AFTER something that needs it.
//
// The wizard's post-commit clearinghouse sync needs the pricing contract service, which is built later, when the pricing routes mount
// (M34 has no edge to M35, so it is reached through a holder). A bare `holder.current?.call()` silently does nothing if the wiring is
// ever lost, and a missed "outside means billing mode none" is money. `get()` throws a loud, named error instead, and `assertBound()` lets
// boot prove the wiring once the roots are built.
//
// Some holders are OPTIONAL by configuration (the outbox dispatcher needs the platform credential, realtime is opt-in, the AI port needs a
// model backend): there the wiring must DECIDE, either `bind` the value or `decline` with the reason. `find()` answers the value or
// undefined, and `assertResolved()` at boot throws if the wiring did neither, which is the lost-wiring case a bare `?.` hides.
export interface LateBound<T> {
  bind(value: T): void;
  /** Mandatory: the value, or a loud named error if nothing was bound. */
  get(): T;
  /** Optional by configuration: the wiring chose not to bind it (and says why). */
  decline(reason: string): void;
  /** Optional: the value, or undefined when none is bound (declined, or boot has not got there yet). */
  find(): T | undefined;
  /** Mandatory holders: throws at boot if nothing was bound. */
  assertBound(): void;
  /** Optional holders: throws at boot if the wiring neither bound nor declined it. */
  assertResolved(): void;
}

export function lateBound<T>(name: string): LateBound<T> {
  let value: T | undefined;
  let declined: string | undefined;
  const unbound = (): never => {
    throw new Error(
      `${name} is not bound: the composition root did not wire it before it was used (a boot-order bug, not a request error)`,
    );
  };
  const unresolved = (): never => {
    throw new Error(
      `${name} was neither bound nor declined: the composition root lost its wiring (every path must bind it or decline it with a reason)`,
    );
  };
  return {
    bind: (next) => {
      value = next;
      declined = undefined;
    },
    get: () => (value === undefined ? unbound() : value),
    decline: (reason) => {
      if (value === undefined) declined = reason;
    },
    find: () => value,
    assertBound: () => {
      if (value === undefined) unbound();
    },
    assertResolved: () => {
      if (value === undefined && declined === undefined) unresolved();
    },
  };
}
