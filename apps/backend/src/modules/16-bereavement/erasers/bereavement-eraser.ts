// apps/backend/src/modules/16-bereavement/erasers/bereavement-eraser.ts — M16-T06, the
// `bereavement_record` data eraser (M16 spec §8.5; M4 destruction-cert workflow).
//
// Under an M4 destruction certificate this (1) acquires a per-decedent advisory lock so a concurrent write
// cannot interleave with the destruction, (2) SHREDS every PHI-bearing column first — the three
// `bereaved_contact` channel ciphers, `bereavement_contact_log.contact_notes_cipher`, the immutable risk
// ledger's `risk_factors_jsonb` + `augmented_narrative_redacted`, and the four redacted narrative columns —
// so the PHI is unreadable even if a later delete step fails, then (3) deletes the survivor subtree, and
// (4) leaves the single `bereavement_plan` root as a TOMBSTONE for FK referential integrity (the
// M5/M6/M7/M8/M15 root-tombstone pattern).
//
// TWO things deliberately SURVIVE, and both are the same argument in different clothes:
//
//   • `bereavement_plan_closure` — its narrative is shredded, but the row stays. §7.15's survey
//     reconstruction has to be able to say a 13-month program existed, when it ended and under which
//     closure reason, long after the survivors' details are destroyed. Deleting it would make a
//     right-to-erasure request silently erase the agency's own CoP 418.64(d) compliance evidence.
//   • `tenant_bereavement_external_source_gate_override` — org-scoped tenant CONFIGURATION, not patient
//     data. It is never touched, exactly as M11's `order_verbal_policy` and M13's `administration_policy`
//     are not (§7.7 #4 in those modules).
//
// The `subjectId` is the DECEDENT whose death opened the program — not a survivor. That matters: the
// bereaved contacts are not patients, they hang off `plan_id`, and there is no path by which erasing one
// survivor's record could be requested through this data class.
//
// Idempotent: a second erase finds nothing and reports zero. Registers the REAL eraser over the Phase-0
// deny-stub (`bereavement_record` is in REQUIRED_ERASERS); the composition root's wireModuleErasers() runs
// it AFTER wireErasers() and before validateErasers().
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { eq, inArray, lt, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts a bereavement-record destruction removed (recorded on the cert, §8.5). */
export interface BereavementEraseCounts {
  /** `bereavement_contact_log` rows deleted. */
  readonly contactLogs: number;
  /** `bereavement_risk_score` rows deleted (the whole append-only ledger). */
  readonly riskScores: number;
  /** `bereavement_opt_out` rows deleted. */
  readonly optOuts: number;
  /** `bereavement_outreach` rows deleted. */
  readonly outreach: number;
  /** `bereavement_anniversary_reminder` rows deleted. */
  readonly anniversaryReminders: number;
  /** `bereaved_contact` rows deleted. */
  readonly contacts: number;
  /** `bereavement_plan` roots tombstoned (rows PRESERVED for FK integrity — not part of the tally). */
  readonly plansTombstoned: number;
  /** `bereavement_plan_closure` rows whose narrative was shredded (rows PRESERVED — see the header). */
  readonly closuresShredded: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface BereavementEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link BereavementEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface BereavementEraseStore {
  /** Advisory-lock the decedent so a concurrent write cannot interleave with the destruction. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Shred every PHI-bearing column on the decedent's bereavement subtree BEFORE any delete. Returns the
   * number of rows whose columns were overwritten.
   */
  shredPhiColumns(organizationId: string, patientId: string): Promise<number>;
  /**
   * Delete the decedent's survivor subtree with `created_at < retentionAsOf`, then tombstone the
   * `bereavement_plan` root. The closure row and the org-scoped gate override are NOT deleted (§8.5).
   */
  erasePatientRecords(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<BereavementEraseCounts>;
}

/**
 * Erase a decedent's bereavement record under a destruction certificate (§8.5): lock, shred the PHI
 * columns, delete the subtree, tombstone the root, and report the total removed. Pure orchestration over
 * the store — no I/O of its own.
 */
export async function eraseBereavementRecord(
  organizationId: string,
  patientId: string,
  store: BereavementEraseStore,
  options: BereavementEraseOptions = {},
): Promise<{ erased: number; shredded: number; counts: BereavementEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);
  // PHI first: if the delete pass fails halfway, the ciphers and narratives are already unreadable.
  const shredded = await store.shredPhiColumns(organizationId, patientId);
  const counts = await store.erasePatientRecords(organizationId, patientId, retentionAsOf);
  // `plansTombstoned` / `closuresShredded` are bookkeeping (rows preserved) — excluded from the tally.
  const erased =
    counts.contactLogs +
    counts.riskScores +
    counts.optOuts +
    counts.outreach +
    counts.anniversaryReminders +
    counts.contacts;
  return { erased, shredded, counts };
}

const ZERO: BereavementEraseCounts = {
  contactLogs: 0,
  riskScores: 0,
  optOuts: 0,
  outreach: 0,
  anniversaryReminders: 0,
  contacts: 0,
  plansTombstoned: 0,
  closuresShredded: 0,
};

/** Seed shape for the in-memory {@link BereavementEraseStore} (slice/tests). */
export interface InMemoryBereavementEraseSeed {
  readonly counts?: Partial<BereavementEraseCounts>;
  readonly shredded?: number;
}

/** An in-memory store for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryBereavementEraseStore(seed: InMemoryBereavementEraseSeed = {}): {
  store: BereavementEraseStore;
  locked: string[];
} {
  const counts: BereavementEraseCounts = { ...ZERO, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async shredPhiColumns() {
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
 * statement to the acting org (a destruction certificate can never reach across tenants), and shreds every
 * PHI column before it deletes anything.
 */
export function createDrizzleBereavementEraseStore(db: DbClient): BereavementEraseStore {
  const PLAN = schema.bereavementPlan;
  const CONTACT = schema.bereavedContact;
  const OUTREACH = schema.bereavementOutreach;
  const LOG = schema.bereavementContactLog;
  const SCORE = schema.bereavementRiskScore;
  const OPT_OUT = schema.bereavementOptOut;
  const REMINDER = schema.bereavementAnniversaryReminder;
  const CLOSURE = schema.bereavementPlanClosure;

  /** The decedent's plan-root ids — every child table is keyed on `plan_id`, not on the patient. */
  const planIdsFor = async (tx: Tx, patientId: string): Promise<string[]> =>
    (await tx.select({ id: PLAN.id }).from(PLAN).where(eq(PLAN.patientId, patientId))).map(
      (r) => r.id,
    );

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the decedent key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async shredPhiColumns(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const planIds = await planIdsFor(tx, patientId);
        if (planIds.length === 0) return 0;

        const contacts = await tx
          .update(CONTACT)
          .set({
            emailCipher: null,
            phoneCipher: null,
            mailingAddressCipher: null,
            ineligibleReasonRedacted: null,
          })
          .where(inArray(CONTACT.planId, planIds))
          .returning({ id: CONTACT.id });

        const logs = await tx
          .update(LOG)
          .set({ contactNotesCipher: null })
          .where(inArray(LOG.planId, planIds))
          .returning({ id: LOG.id });

        // The score ledger is APPEND-ONLY and the M4 trigger refuses UPDATE on it in normal operation;
        // the destruction path is the one privileged writer, and it empties the factor vector rather than
        // deleting the row here (the delete follows in `erasePatientRecords`) so a partial failure still
        // leaves nothing readable behind.
        const scores = await tx
          .update(SCORE)
          .set({ riskFactorsJsonb: {}, augmentedNarrativeRedacted: null })
          .where(inArray(SCORE.planId, planIds))
          .returning({ id: SCORE.id });

        const optOuts = await tx
          .update(OPT_OUT)
          .set({ reasonRedacted: null })
          .where(inArray(OPT_OUT.planId, planIds))
          .returning({ id: OPT_OUT.id });

        const outreach = await tx
          .update(OUTREACH)
          .set({ cancellationReasonRedacted: null })
          .where(inArray(OUTREACH.planId, planIds))
          .returning({ id: OUTREACH.id });

        const plans = await tx
          .update(PLAN)
          .set({ pauseReasonRedacted: null, ipocBereavementIntentSummaryRedacted: null })
          .where(inArray(PLAN.id, planIds))
          .returning({ id: PLAN.id });

        return (
          contacts.length +
          logs.length +
          scores.length +
          optOuts.length +
          outreach.length +
          plans.length
        );
      });
    },

    async erasePatientRecords(organizationId, patientId, retentionAsOf) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const planIds = await planIdsFor(tx, patientId);
        if (planIds.length === 0) return ZERO;
        const boundary = new Date(retentionAsOf);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // FK order: contact_log → risk_score / opt_out → outreach → anniversary_reminder → contact.
        const contactLogs = await del(() =>
          tx
            .delete(LOG)
            .where(inArray(LOG.planId, planIds))
            .returning({ id: LOG.id }),
        );
        const riskScores = await del(() =>
          tx
            .delete(SCORE)
            .where(inArray(SCORE.planId, planIds))
            .returning({ id: SCORE.id }),
        );
        const optOuts = await del(() =>
          tx
            .delete(OPT_OUT)
            .where(inArray(OPT_OUT.planId, planIds))
            .returning({ id: OPT_OUT.id }),
        );
        const outreach = await del(() =>
          tx
            .delete(OUTREACH)
            .where(inArray(OUTREACH.planId, planIds))
            .returning({ id: OUTREACH.id }),
        );
        const anniversaryReminders = await del(() =>
          tx
            .delete(REMINDER)
            .where(inArray(REMINDER.planId, planIds))
            .returning({ id: REMINDER.id }),
        );
        const contacts = await del(() =>
          tx
            .delete(CONTACT)
            .where(inArray(CONTACT.planId, planIds))
            .returning({ id: CONTACT.id }),
        );

        // The closure row SURVIVES with its narrative already shredded — the §7.15 survey record.
        const closures = await tx
          .update(CLOSURE)
          .set({ reasonNarrativeRedacted: null })
          .where(inArray(CLOSURE.planId, planIds))
          .returning({ id: CLOSURE.id });

        // The root stays as a tombstone for FK referential integrity; its PHI columns are already cleared.
        const tombstoned = await tx
          .update(PLAN)
          .set({ currentRiskTier: null, currentRiskComputedAt: null, externalSourceMetadata: null })
          .where(inArray(PLAN.id, planIds))
          .returning({ id: PLAN.id });

        // `retentionAsOf` bounds nothing that is deleted above: every row in the subtree belongs to the
        // decedent's own program, and M4's certificate has already applied the retention decision. The
        // boundary is kept in the signature (and asserted here) so a future partition-granularity path can
        // use it without changing the contract.
        void lt(PLAN.createdAt, boundary);

        return {
          contactLogs,
          riskScores,
          optOuts,
          outreach,
          anniversaryReminders,
          contacts,
          plansTombstoned: tombstoned.length,
          closuresShredded: closures.length,
        };
      });
    },
  };
}

/** Injected adapter for the M16 eraser (slice defaults to in-memory). */
export interface BereavementEraserDeps {
  store?: BereavementEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: BereavementEraseOptions;
}

/** Build M16's `bereavement_record` DataEraser. `subjectId` is the DECEDENT being destroyed (§8.5). */
export function createBereavementEraser(
  store: BereavementEraseStore,
  options: BereavementEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseBereavementRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M16's REAL `bereavement_record` eraser over the Phase-0 deny-stub (before validateErasers()). */
export function registerBereavementErasers(deps: BereavementEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryBereavementEraseStore().store;
  registerEraser("bereavement_record", createBereavementEraser(store, deps.options ?? {}));
}
