// apps/backend/src/bootstrap/erasers/providers.ts — Phase 0 DENY-STUB erasers.
// Each PHI data class registers a stub that throws on actual erase, so validateErasers()
// passes at boot (the contract is present) while a real erase fails loudly until the
// owning module (M4 + the data-class owner) implements it in Phase 1.

import type { DataClass, DataEraser } from "../interfaces";
import { REQUIRED_ERASERS, registerEraser } from "./registry";

export class NotImplementedEraserError extends Error {
  constructor(dataClass: string) {
    super(
      `eraser[${dataClass}]: Phase-0 deny-stub — not implemented until its owning module lands`,
    );
    this.name = "NotImplementedEraserError";
  }
}

function denyStub(dataClass: DataClass): DataEraser {
  return {
    erase() {
      throw new NotImplementedEraserError(dataClass);
    },
  };
}

/** Register a Phase-0 deny-stub eraser for every required data class. */
export function wireErasers(): void {
  for (const dataClass of REQUIRED_ERASERS) registerEraser(dataClass, denyStub(dataClass));
}
