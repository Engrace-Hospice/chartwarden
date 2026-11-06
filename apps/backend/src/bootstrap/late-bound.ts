// apps/backend/src/bootstrap/late-bound.ts — a dependency the composition root builds AFTER something that needs it.
//
// The wizard's post-commit clearinghouse sync needs the pricing contract service, which is built later, when the pricing routes mount
// (M34 has no edge to M35, so it is reached through a holder). A bare `holder.current?.call()` silently does nothing if the wiring is
// ever lost, and a missed "outside means billing mode none" is money. `get()` throws a loud, named error instead, and `assertBound()` lets
// boot prove the wiring once the roots are built.
export interface LateBound<T> {
  bind(value: T): void;
  get(): T;
  /** Throws if nothing was bound: call at the end of boot, so a lost wiring fails the process rather than a later request. */
  assertBound(): void;
}

export function lateBound<T>(name: string): LateBound<T> {
  let value: T | undefined;
  const unbound = (): never => {
    throw new Error(
      `${name} is not bound: the composition root did not wire it before it was used (a boot-order bug, not a request error)`,
    );
  };
  return {
    bind: (next) => {
      value = next;
    },
    get: () => (value === undefined ? unbound() : value),
    assertBound: () => {
      if (value === undefined) unbound();
    },
  };
}
