// @wardenx/consent — the consent-subtree destruction engine (M39-T10, §3.8, D20).
//
// Called by M4's destruction-cert workflow when a patient's overall retention class transitions to
// eligible_for_destruction (the `consent` data class). Pure-over-a-port: the engine decides WHICH
// consent rows may be deleted; the store performs the delete + reports counts. Two refusals make
// erasure conditional (unlike M40/M5's unconditional offboarding erase):
//   • LEGAL HOLD — any consent under an active legal hold is retained, whatever its type (M4 §10.6).
//   • 42 CFR PART 2 LIFETIME — a `42_cfr_part_2_release` consent is retained while the patient is
//     STILL ALIVE (Part 2 retention runs for the patient's lifetime; destruction of those rows is
//     routed through M4's certified audit-retention path, never a domain DELETE). Once the patient is
//     deceased the Part 2 lifetime ends and the rows may be erased.
// consent_eval_audit is NEVER deleted here (INSERT-only, trg_cea_immutable) — M4's audit-partition
// retention owns its destruction (M39-F04). The engine reports `{erased, retained}`; the DataEraser
// wrapper returns the interface's `{erased}` (the certified retained counts are surfaced to M4).
import type { ConsentTypeKey } from "../interfaces/kinds";

export interface ConsentEraseRow {
  readonly id: string;
  readonly typeKey: ConsentTypeKey;
  /** True when this consent (or its patient) is under an active M4 legal hold. */
  readonly legalHold: boolean;
}

export interface ConsentSubjectSummary {
  readonly patientDeceased: boolean;
  readonly rows: readonly ConsentEraseRow[];
}

/** The port the engine runs over (Drizzle-backed in production; in-memory in the slice). */
export interface ConsentEraseStore {
  /** The patient's consent rows + deceased state (drives the Part 2 lifetime refusal). */
  consentSummary(organizationId: string, patientId: string): Promise<ConsentSubjectSummary>;
  /** Delete the named consent subtrees (record + recipients + dpoa + revocations + reminders +
   *  renewal-cycles + delegated-access + document-link); return the total rows removed. */
  deleteConsents(
    organizationId: string,
    patientId: string,
    consentRecordIds: readonly string[],
  ): Promise<number>;
}

export interface ConsentEraseResult {
  readonly erased: number;
  /** Retained class → count (the reason a row was NOT deleted). Surfaced to M4's destruction cert. */
  readonly retained: Readonly<Record<string, number>>;
}

const PART2: ConsentTypeKey = "42_cfr_part_2_release";

/** Decide + perform the §3.8 consent-subtree erasure for one patient. `legalHoldOverride` (a
 *  break-glass / court-ordered destruction) erases even held rows; it never overrides the Part 2
 *  lifetime refusal (that ends only on death). */
export async function eraseConsentForSubject(
  organizationId: string,
  patientId: string,
  store: ConsentEraseStore,
  opts: { legalHoldOverride?: boolean } = {},
): Promise<ConsentEraseResult> {
  const summary = await store.consentSummary(organizationId, patientId);
  const retained: Record<string, number> = {};
  const deletable: string[] = [];

  for (const row of summary.rows) {
    if (row.legalHold && !opts.legalHoldOverride) {
      retained.consent_held_by_legal_hold = (retained.consent_held_by_legal_hold ?? 0) + 1;
      continue;
    }
    if (row.typeKey === PART2 && !summary.patientDeceased) {
      retained[PART2] = (retained[PART2] ?? 0) + 1; // Part 2 lifetime — retained while alive
      continue;
    }
    deletable.push(row.id);
  }

  const erased =
    deletable.length > 0 ? await store.deleteConsents(organizationId, patientId, deletable) : 0;
  return { erased, retained };
}

// ── In-memory store (slice + tests) ──────────────────────────────────────────────────────────

export interface InMemoryConsentEraseData {
  /** key = `${orgId}:${patientId}` → summary. */
  subjects: Map<string, ConsentSubjectSummary>;
}

export function createInMemoryConsentEraseStore(
  data: InMemoryConsentEraseData = { subjects: new Map() },
): { store: ConsentEraseStore; data: InMemoryConsentEraseData } {
  const key = (o: string, p: string) => `${o}:${p}`;
  const store: ConsentEraseStore = {
    async consentSummary(organizationId, patientId) {
      return (
        data.subjects.get(key(organizationId, patientId)) ?? { patientDeceased: false, rows: [] }
      );
    },
    async deleteConsents(organizationId, patientId, ids) {
      const k = key(organizationId, patientId);
      const summary = data.subjects.get(k);
      if (!summary) return 0;
      const remaining = summary.rows.filter((r) => !ids.includes(r.id));
      data.subjects.set(k, { ...summary, rows: remaining });
      return summary.rows.length - remaining.length;
    },
  };
  return { store, data };
}
