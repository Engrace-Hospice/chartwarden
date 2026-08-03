// @wardenx/inpatient — the M37 domain failure-code catalog. Every guard failure in the pure IPU domain
// kernels (the bed-cleaning machine, the admission machine, IRC cap, restraint cadence, GIP validators,
// RN-coverage evaluator, …) raises an `IpuStateError` carrying an enumerated machine-readable code. The
// error extends the M1 `WardenXError` envelope (`@wardenx/types` — the M18 `EvvStateError` / M6
// `AdmissionStateError` convention) so the Fastify error handler renders code + HTTP status with NO
// cross-module import edge; the §3.x DB CHECK / partial-unique backstops repeat the strongest of these at
// the schema layer as defense in depth. The route layer (M37-T11) reuses these codes verbatim.
//
// The catalog grows per task: T03 seeds the §2.12 bed-cleaning codes; T04–T10 append the admission / IRC /
// restraint / GIP / RN-coverage / census codes below. All share one `IpuStateError` envelope.
import { WardenXError } from "@wardenx/types";

/** The M37 domain failure-code catalog → HTTP status. */
export const M37_ERROR_STATUS = {
  // ── §2.12 D13 bed-cleaning state machine (M37-T03) ─────────────────────────────────────────────────
  // §2.12 — the event is not accepted from the bed's current cleaning_status (the D13 mermaid graph);
  // `retired` is terminal.
  ILLEGAL_BED_CLEANING_TRANSITION: 409,
  // §2.12 — a turnover-SLA value that attempts to LOOSEN above the 2-hour platform floor (tighten-only).
  TURNOVER_SLA_NOT_TIGHTENING: 409,
} as const;

/** A machine-readable M37 domain failure code. */
export type M37ErrorCode = keyof typeof M37_ERROR_STATUS;

/**
 * A guard / validation failure in a pure M37 domain kernel. Carries the precise `code` so the UI renders an
 * exact message; the M1 error handler maps `statusCode` to the HTTP response. Nothing transitions on a
 * string match — each code is an enumerated constant.
 */
export class IpuStateError extends WardenXError {
  constructor(code: M37ErrorCode, message: string) {
    super(code, message, M37_ERROR_STATUS[code]);
    this.name = "IpuStateError";
  }
}

/** Throw an {@link IpuStateError} when `condition` is false (guard helper). */
export function requireIpu(condition: boolean, code: M37ErrorCode, message: string): void {
  if (!condition) throw new IpuStateError(code, message);
}
