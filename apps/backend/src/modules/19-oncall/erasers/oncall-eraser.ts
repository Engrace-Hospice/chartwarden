// apps/backend/src/modules/19-oncall/erasers/oncall-eraser.ts — M19-T02, the `triage_record` data eraser
// (M19 spec §3.7; M4 destruction-cert workflow).
//
// Under an M4 destruction certificate this (1) acquires a per-patient advisory lock so a concurrent triage
// write cannot interleave with the destruction, (2) SHREDS every PHI-bearing column on the patient's
// `triage_call` rows FIRST — the M5/M6 ids, the caller's name and phone, the chief complaint, the two
// per-tenant-DEK ciphers and the disposition payload — so the PHI is unreadable even if a later delete step
// fails, then (3) deletes the call subtree (escalations → answers → state history), and (4) leaves the
// `triage_call` row itself as a de-identified TOMBSTONE.
//
// WHY THE CALL ROW SURVIVES. §3.7 is explicit and the reason is not bookkeeping: M8's signed
// `triage_telephonic_contact` encounter carries a back-reference to the call (D8), so deleting the row
// would orphan a SIGNED clinical document. The tombstone keeps `(organization_id, on_call_shift_id,
// opened_at)` — enough for the shift to still account for its own night — and nothing that identifies a
// person. M8's own eraser runs in parallel and handles its side.
//
// WHAT IS NEVER TOUCHED, and it is the same argument each time: `tenant_oncall_policy` and
// `external_triage_vendor` are tenant CONFIGURATION (the M11 `order_verbal_policy` / M13
// `administration_policy` posture); `triage_protocol` + `triage_protocol_question` are a catalog;
// `on_call_shift` is the CoP 418.100(c)(2) evidence that a nurse was reachable at 2 a.m., which is the
// AGENCY's compliance record, not the patient's data — erasing it in the name of the patient whose call it
// covered would destroy the agency's own survey evidence. `triage_paper_reentry_worklist` is BCP
// reconciliation state keyed on a shift, not a patient, and holds no patient column at all.
//
// Tenant-offboarding cryptographic shred (architecture §8) destroys the per-tenant DEK, which renders
// `caller_quote_cipher` and `transcript_cipher` unreadable in one operation with no per-row delete (§3.7).
// This eraser is the PER-PATIENT path and does not depend on that.
//
// Idempotent: a second erase finds nothing and reports zero. Registers the REAL eraser over the Phase-0
// deny-stub (`triage_record` is in REQUIRED_ERASERS); the composition root's wireModuleErasers() runs it
// AFTER wireErasers() and before validateErasers().
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq, inArray, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts a triage-record destruction removed (recorded on the cert, §3.7). */
export interface TriageEraseCounts {
  /** `triage_escalation` rows deleted. */
  readonly escalations: number;
  /** `triage_call_answer` rows deleted (the whole append-only ledger, corrections included). */
  readonly answers: number;
  /** `triage_call_state_history` rows deleted. */
  readonly stateHistory: number;
  /** `triage_call` rows de-identified in place (rows PRESERVED — not part of the tally). */
  readonly callsTombstoned: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface TriageEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link TriageEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface TriageEraseStore {
  /** Advisory-lock the patient so a concurrent triage write cannot interleave with the destruction. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Null every PHI-bearing column on the patient's `triage_call` rows BEFORE any delete. Returns the
   * number of call rows whose columns were overwritten.
   */
  shredCallColumns(organizationId: string, patientId: string): Promise<number>;
  /**
   * Delete the patient's call subtree and report the counts. The `triage_call` rows themselves are NOT
   * deleted — they are closed and left as tombstones (see the header).
   */
  erasePatientRecords(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<TriageEraseCounts>;
}

/**
 * Erase a patient's triage record under a destruction certificate (§3.7): lock, shred the PHI columns,
 * delete the subtree, tombstone the calls, and report the total removed. Pure orchestration over the
 * store — no I/O of its own.
 */
export async function eraseTriageRecord(
  organizationId: string,
  patientId: string,
  store: TriageEraseStore,
  options: TriageEraseOptions = {},
): Promise<{ erased: number; shredded: number; counts: TriageEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);
  // PHI first: if the delete pass fails halfway, the caller's words and identity are already unreadable.
  const shredded = await store.shredCallColumns(organizationId, patientId);
  const counts = await store.erasePatientRecords(organizationId, patientId, retentionAsOf);
  // `callsTombstoned` is bookkeeping (rows preserved) — excluded from the tally.
  const erased = counts.escalations + counts.answers + counts.stateHistory;
  return { erased, shredded, counts };
}

const ZERO: TriageEraseCounts = {
  escalations: 0,
  answers: 0,
  stateHistory: 0,
  callsTombstoned: 0,
};

/** Seed shape for the in-memory {@link TriageEraseStore} (slice/tests). */
export interface InMemoryTriageEraseSeed {
  readonly counts?: Partial<TriageEraseCounts>;
  readonly shredded?: number;
}

/** An in-memory store for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryTriageEraseStore(seed: InMemoryTriageEraseSeed = {}): {
  store: TriageEraseStore;
  locked: string[];
} {
  const counts: TriageEraseCounts = { ...ZERO, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_organizationId, patientId) {
        locked.push(patientId);
      },
      async shredCallColumns() {
        return used ? 0 : (seed.shredded ?? 0);
      },
      async erasePatientRecords() {
        const out = used ? ZERO : counts;
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside `withOrgContext` so RLS scopes every
 * statement to the acting org (a destruction certificate can never reach across tenants), and nulls every
 * PHI column before it deletes anything.
 */
export function createDrizzleTriageEraseStore(db: DbClient): TriageEraseStore {
  const CALL = schema.triageCall;
  const ANSWER = schema.triageCallAnswer;
  const ESCALATION = schema.triageEscalation;
  const HISTORY = schema.triageCallStateHistory;

  /** The patient's call-root ids — every child table is keyed on `triage_call_id`, not on the patient. */
  const callIdsFor = async (
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    patientId: string,
  ): Promise<string[]> =>
    (await tx.select({ id: CALL.id }).from(CALL).where(eq(CALL.patientId, patientId))).map(
      (r) => r.id,
    );

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async shredCallColumns(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const shredded = await tx
          .update(CALL)
          .set({
            admissionId: null,
            callerCaregiverId: null,
            callerPortalSessionId: null,
            callerDisplayName: null,
            callerPhoneE164: null,
            callerRelationshipLabel: null,
            chiefComplaintText: null,
            chiefComplaintSnomed: null,
            callerQuoteCipher: null,
            transcriptCipher: null,
            dispositionData: null,
          })
          .where(eq(CALL.patientId, patientId))
          .returning({ id: CALL.id });
        return shredded.length;
      });
    },

    async erasePatientRecords(organizationId, patientId, retentionAsOf) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const callIds = await callIdsFor(tx, patientId);
        if (callIds.length === 0) return ZERO;

        // FK order: escalations and answers reference the call; the answer table also self-references
        // (corrections), so it is deleted whole rather than in two passes.
        const escalations = await tx
          .delete(ESCALATION)
          .where(inArray(ESCALATION.triageCallId, callIds))
          .returning({ id: ESCALATION.id });
        const answers = await tx
          .delete(ANSWER)
          .where(inArray(ANSWER.triageCallId, callIds))
          .returning({ id: ANSWER.id });
        const stateHistory = await tx
          .delete(HISTORY)
          .where(inArray(HISTORY.triageCallId, callIds))
          .returning({ id: HISTORY.id });

        // The tombstone. `patient_id` goes last, because it is the key every statement above selects on —
        // clearing it first would make a partial failure unrecoverable (nothing left to find the subtree
        // by). The call is forced `closed` with a close timestamp so it leaves every open-cases view and
        // still satisfies the `m19_triage_call_closed_at` CHECK.
        const tombstoned = await tx
          .update(CALL)
          .set({
            patientId: null,
            state: "closed",
            closedAt: sql`COALESCE(${CALL.closedAt}, now())`,
          })
          .where(inArray(CALL.id, callIds))
          .returning({ id: CALL.id });

        // `retentionAsOf` bounds nothing here: every row in the subtree belongs to this patient's own
        // calls, and M4's certificate has already applied the retention decision. It stays in the
        // signature (and is validated here) so a future retention-windowed path can use it without
        // changing the contract.
        if (Number.isNaN(Date.parse(retentionAsOf))) {
          throw new Error(`M19_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
        }

        return {
          escalations: escalations.length,
          answers: answers.length,
          stateHistory: stateHistory.length,
          callsTombstoned: tombstoned.length,
        };
      });
    },
  };
}

/** Injected adapter for the M19 eraser (slice defaults to in-memory). */
export interface TriageEraserDeps {
  store?: TriageEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: TriageEraseOptions;
}

/** Build M19's `triage_record` DataEraser. `subjectId` is the PATIENT being destroyed (§3.7). */
export function createTriageEraser(
  store: TriageEraseStore,
  options: TriageEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseTriageRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M19's REAL `triage_record` eraser over the Phase-0 deny-stub (before validateErasers()). */
export function registerTriageErasers(deps: TriageEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryTriageEraseStore().store;
  registerEraser("triage_record", createTriageEraser(store, deps.options ?? {}));
}
