// apps/backend/src/bootstrap/erasers/registry.ts — the M4 destruction-cert eraser
// registry. Every PHI data class must register a DataEraser or boot fails
// (validateErasers()), mirroring validateSeams(). This is decision D4 from the promoted
// boot.ts example: a missing eraser means a right-to-erasure request would silently
// no-op a data class, so we fail closed at startup instead.

import type { DataClass, DataEraser } from "../interfaces";

export class EraserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraserError";
  }
}

const erasers = new Map<DataClass, DataEraser>();

/** Every PHI data class that must have a registered eraser before serving traffic. */
export const REQUIRED_ERASERS: readonly DataClass[] = [
  "audit_event",
  "clinical_record",
  "documents",
  "messages",
  "consent",
  "telehealth_recording",
];

export function registerEraser(dataClass: DataClass, eraser: DataEraser): void {
  erasers.set(dataClass, eraser);
}

export function getEraser(dataClass: DataClass): DataEraser {
  const e = erasers.get(dataClass);
  if (e === undefined) throw new EraserError(`no eraser registered for data class '${dataClass}'`);
  return e;
}

/** Boot gate: throw listing every PHI data class with no registered eraser. */
export function validateErasers(): void {
  const missing = REQUIRED_ERASERS.filter((c) => !erasers.has(c));
  if (missing.length > 0) {
    throw new EraserError(
      `validateErasers: ${missing.length} data class(es) without an eraser — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetErasersForTest(): void {
  erasers.clear();
}
