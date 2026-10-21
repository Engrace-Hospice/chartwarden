// @chartwarden/audit — In-memory eraser ports (M4-T08): the infra-free `EraserPorts` adapter every
// destruction/eraser test runs against, mirroring the in-memory adapters in ./query + the M2
// eraser store. Seed patients (lifecycle), legal holds (which row-groups are held), and a fixed
// clock; `performErasure` reports a deterministic count so a run's tallies are assertable. The
// production adapters live elsewhere: the guard legs (patient SELECT, legal_hold match) in the M4
// backend module, the partitioned DELETE executor in ./drizzle-erase (destruction-granted client).
import type { EraseInput, EraserPorts, PatientLifecycle } from "./eraser";

/** Seed shape for the in-memory eraser ports. */
export interface InMemoryEraserSeed {
  /** Patient lifecycle keyed by `patientId` (org-scoping omitted — tests use one org). */
  readonly patients?: Readonly<Record<string, PatientLifecycle>>;
  /** Row-groups under an active legal hold → the holding hold id, keyed by `resourceId`. */
  readonly legalHolds?: Readonly<Record<string, string>>;
  /** Rows erased per successful `performErasure` call (default 1). */
  readonly rowsPerErase?: number;
  /** Fixed "now" for the §6 six-year window (ISO-8601); defaults to a stable date. */
  readonly now?: string;
}

/** A deterministic in-memory `EraserPorts` plus a tally of how many erases it performed. */
export function createInMemoryEraserPorts(seed: InMemoryEraserSeed = {}): {
  ports: EraserPorts;
  erasedCalls(): number;
} {
  const patients = seed.patients ?? {};
  const legalHolds = seed.legalHolds ?? {};
  const rowsPerErase = seed.rowsPerErase ?? 1;
  const fixedNow = new Date(seed.now ?? "2026-06-15T00:00:00.000Z");
  let erasedCalls = 0;

  const ports: EraserPorts = {
    legalHoldFor: (input: EraseInput) => legalHolds[input.resourceId] ?? null,
    loadPatient: (_orgId, patientId) => patients[patientId] ?? null,
    performErasure: () => {
      erasedCalls += 1;
      return rowsPerErase;
    },
    now: () => fixedNow,
  };

  return { ports, erasedCalls: () => erasedCalls };
}
