// apps/backend/src/modules/23-billing-medicare/erasers/billing-eraser.ts — the M23 `billing_record` data
// eraser (M4 destruction registry, §3.7 / §8.4). Unlike M27/M30 (org-only operational rows), the M23
// billing record IS per-patient PHI: claim / claim_line / claim_state_history / validation_run/result/
// override / claim_submission / claim_acknowledgment / hipps_calculation / sia_calculation /
// eligibility_check / noe_record / notr_record all carry the patient FK. The billing record is
// COMPLIANCE-class (7 years past final action per CMS 42 CFR §424 / §405 + state override, M4 D1), so the
// registered eraser is the DESTRUCTION handler the M4 destruction-cert workflow invokes — NOT an
// ordinary-offboarding cleanup. The §3.7 cascade order + the redact/shred surface are the pure
// `@wardenx/billing` eraser contract (`M23_PATIENT_CASCADE_ORDER` / `M23_REDACT_FIELDS`); this backend
// wrapper only adapts the package's `BillingEraseStore` to the M1 `DataEraser` contract and registers the
// REAL eraser over the Phase-0 deny-stub via the composition-root `registerModuleErasers` hook (after
// wireErasers(), before validateErasers() — the same M6/M22/M27/M30 registration shape).
//
// SUBJECT HANDLING (differs from M27): for `billing_record` the `DataEraser.erase(scope, subjectId)`
// subject is the PATIENT (the per-patient cascade is the registered path); the M4 cert workflow passes the
// patient id, and the §3.7 in-flight guard (a `BillingEraseRefused` from the store) refuses an erase that
// would destroy a claim still moving through submission / awaiting a MAC acknowledgment, or a record under
// a surveyor hold. The MAC `client_secret_cipher` cryptographic SHRED + the org-operational config rows are
// an ORGANIZATION-destruction concern (`eraseOrgBillingConfig`), NOT the per-patient subject path; that
// org-destruction binding lands with the M4 org-destruction driver (documented below, not faked here).
//
// CASCADE ORDER (§3.7, from the package contract): children first so FKs unwind cleanly —
//   eligibility_check → claim_acknowledgment → claim_submission → claim_state_history →
//   validation_override → validation_result → validation_run → sia_calculation → hipps_calculation →
//   claim_line → claim → noe_record → notr_record.
// The append-only tables are deleted in-cascade; the free-text fields in `M23_REDACT_FIELDS` (override
// reason, replacement reason, patient-id refs) are redacted rather than orphaned. NO MBI is ever a field
// (§3.6 — it never persists).
//
// AI-BLOCK (D13): no `@wardenx/ai-platform` import here (the dependency-cruiser boundary enforces it).
import {
  BillingEraseRefused,
  type BillingEraseStore,
  type BillingEraseTableCounts,
  M23_RETENTION_CLASS,
} from "@wardenx/billing";
import { type DbClient, schema } from "@wardenx/db";
import type { DataClass, DataEraser } from "@wardenx/types";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

// IMPORT-BOUNDARY NOTE (differs from M27): M23 `dependsOn = [6,8,22,38,40]` does NOT include M1, so the
// M1-owned `apps/backend/src/bootstrap` M4 destruction registry (`registerEraser`) is forbidden by
// `module-23-boundary` (and `dependsOn` may not be widened). The bootstrap `registerEraser` hook is
// therefore INJECTED by the composition root (the app root may import bootstrap), not imported here.

/** The M4 destruction-registry hook the composition root binds (its bootstrap `registerEraser`). */
export type RegisterEraserHook = (dataClass: DataClass, eraser: DataEraser) => void;

/**
 * The M23 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned) —
 * cast here as the single string literal so the wiring lands in one place (the M27 `cost_report_class` /
 * M30 `quality_class` precedent). The Integrate phase adds `"billing_record"` to that union + to
 * `REQUIRED_ERASERS` (apps/backend/src/bootstrap/erasers/registry.ts) so boot fails closed if M23's real
 * eraser is never registered.
 */
export const BILLING_DATA_CLASS = M23_RETENTION_CLASS satisfies DataClass;

/** Deps for the M23 eraser registration. */
export interface BillingEraserDeps {
  /**
   * The bootstrap `registerEraser` hook, injected by the composition root (M23 cannot import the M1-owned
   * bootstrap registry — see the import-boundary note above). Required: with no hook the eraser cannot be
   * registered.
   */
  readonly registerEraser: RegisterEraserHook;
  /** The Drizzle-backed `BillingEraseStore` in prod (each DELETE / redact under the destruction-cert
   *  tenancy context); the in-memory slice store by default. */
  readonly store?: BillingEraseStore;
}

/** Sum every per-table count in the §3.7 erase-count map (the M4 destruction-cert `tableCounts`). */
function sumCounts(counts: BillingEraseTableCounts): number {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

/**
 * Adapt the package's pure `BillingEraseStore` to the M1 `DataEraser` contract. The registered subject is
 * the PATIENT: the per-patient §3.7 cascade deletes/redacts every owned billing table for that patient in
 * the org. The store enforces the §3.7 in-flight / surveyor-hold guard (it raises `BillingEraseRefused`
 * which propagates to the M4 destruction-cert workflow — fail-closed, never a silent no-op).
 */
export function createBillingEraser(store: BillingEraseStore): DataEraser {
  return {
    // `scope.orgId` is the tenant; `subjectId` is the patient whose billing record the M4 destruction
    // certificate authorizes. The MAC credential cryptographic shred + operational-config rows are NOT
    // reached here — that is the ORG-destruction path (`store.eraseOrgBillingConfig`), bound by the M4
    // org-destruction driver when it lands.
    async erase(scope, subjectId) {
      const counts = await store.erasePatientBillingRecord({
        organizationId: scope.orgId,
        patientId: subjectId,
      });
      return { erased: sumCounts(counts) };
    },
  };
}

/**
 * Default in-memory `BillingEraseStore` (the slice store): zero counts, never deletes. Prod injects the
 * Drizzle-backed store. Mirrors the M27 `createInMemoryCostReportEraseStore` default.
 */
function createInMemoryBillingEraseStore(): BillingEraseStore {
  return {
    async erasePatientBillingRecord(_input) {
      return {};
    },
    async eraseOrgBillingConfig(_input) {
      return {};
    },
  };
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * The redaction sentinel written over the §3.7 free-text redact fields BEFORE the cascade deletes them.
 * ≥40 chars on purpose: the `claim_replacement_reason_floor` CHECK (length ≥ 40 when `replaces_claim_id`
 * is set, migration 0074) and the `validation_override_reason_floor` CHECK (length ≥ 40 unconditionally,
 * migration 0075) both re-validate on UPDATE, so a shorter sentinel would make the shred itself fail.
 */
const M23_REDACT_SENTINEL =
  "[ERASED under M4 destruction certificate — 42 CFR retention satisfied]";

/**
 * The zero-value ciphertext the MAC `client_secret_cipher` is shredded to at org-destruction. Non-empty on
 * purpose: the `mac_submitter_credential_complete` CHECK requires `length(client_secret_cipher) > 0`
 * (migration 0075) and re-validates on UPDATE. The DEK rotation half of the cryptographic shred is the M4
 * org-destruction driver's step; overwriting the ciphertext here makes the secret unrecoverable regardless.
 */
const M23_SHREDDED_CIPHER = "[SHREDDED]";

/** The D4 states in which a claim / NOE / NOTR is still moving through submission or awaiting a MAC ack. */
const M23_IN_FLIGHT_STATES = ["SUBMITTED", "ACK_PENDING"] as const;

/**
 * The surveyor-hold probe (§3.7): M23 owns no hold table — a surveyor hold is an M4 `legal_hold` fact, and
 * M4's lifecycle eraser enforces hold supremacy (§10.6) BEFORE a data-class eraser fires. The composition
 * root MAY additionally bind this probe (from M4's legal-hold reader) so the store itself refuses with
 * `BillingEraseRefused("surveyor_hold")` — defense in depth, never M23 re-owning M4's hold semantics.
 */
export interface BillingSurveyorHoldProbe {
  isPatientBillingHeld(organizationId: string, patientId: string): Promise<boolean>;
}

/** Options for the Drizzle-backed store. */
export interface DrizzleBillingEraseStoreOptions {
  /** Optional surveyor-hold probe (see {@link BillingSurveyorHoldProbe}); absent = M4 upstream enforcement. */
  readonly surveyorHold?: BillingSurveyorHoldProbe;
}

/**
 * The REAL Drizzle-backed `BillingEraseStore` (§3.7). Runs on the PRIVILEGED M4 destruction-cert connection
 * the composition root binds (wardenx_admin — migration 0077 grants `wardenx_app` no DELETE on any M23
 * table, so the app-role `withOrgContext` path cannot destroy; the M24/M26 sibling posture). Every WHERE
 * therefore carries the explicit `organization_id` predicate — a certificate can never reach across tenants.
 *
 * Shape: (guard → shred) commits FIRST in its own transaction — if the delete pass then fails halfway, the
 * §3.7 redact fields are already unreadable (the M16/M19 shred-before-delete discipline) — then the
 * FK-unwind cascade runs in a second transaction in exactly the `M23_PATIENT_CASCADE_ORDER`, counting rows
 * actually deleted via `.returning()`. The §3.7 in-flight guard throws `BillingEraseRefused` (propagates to
 * the M4 destruction-cert workflow — fail-closed, never a silent no-op).
 *
 * COLUMN TRUTH vs the package contract's field names: `M23_REDACT_FIELDS`' `*.patient_id_ref` entries
 * resolve to the real `patient_id` columns (claim / eligibility_check / noe_record / notr_record), which
 * are NOT NULL and are hard-DELETED in-cascade here — deletion subsumes redaction. Likewise
 * `sequestration_policy.set_reason` is subsumed by the org-destruction row delete: an UPDATE on a
 * historical policy row would re-trip the `sequestration_policy_forward_only` CHECK
 * (`effective_from > CURRENT_DATE OR effective_to IS NOT NULL`, migration 0075), so the row is deleted
 * whole instead of redacted in place.
 */
export function createDrizzleBillingEraseStore(
  db: DbClient,
  options: DrizzleBillingEraseStoreOptions = {},
): BillingEraseStore {
  const C = schema.claim;
  const CL = schema.claimLine;
  const CSH = schema.claimStateHistory;
  const CS = schema.claimSubmission;
  const CA = schema.claimAcknowledgment;
  const VRUN = schema.validationRun;
  const VRES = schema.validationResult;
  const VO = schema.validationOverride;
  const HIPPS = schema.hippsCalculation;
  const SIA = schema.siaCalculation;
  const EC = schema.eligibilityCheck;
  const NOE = schema.noeRecord;
  const NOTR = schema.notrRecord;
  const TN = schema.transferNoticeRecord;
  const MAC = schema.macSubmitterCredential;
  const SP = schema.sequestrationPolicy;
  const VRC = schema.validationRuleConfig;

  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

  const claimIdsFor = async (tx: Tx, organizationId: string, patientId: string) =>
    ids(
      await tx
        .select({ id: C.id })
        .from(C)
        .where(and(eq(C.organizationId, organizationId), eq(C.patientId, patientId))),
    );

  const noeIdsFor = async (tx: Tx, organizationId: string, patientId: string) =>
    ids(
      await tx
        .select({ id: NOE.id })
        .from(NOE)
        .where(and(eq(NOE.organizationId, organizationId), eq(NOE.patientId, patientId))),
    );

  const notrIdsFor = async (tx: Tx, organizationId: string, patientId: string) =>
    ids(
      await tx
        .select({ id: NOTR.id })
        .from(NOTR)
        .where(and(eq(NOTR.organizationId, organizationId), eq(NOTR.patientId, patientId))),
    );

  const transferNoticeIdsFor = async (tx: Tx, organizationId: string, patientId: string) =>
    ids(
      await tx
        .select({ id: TN.id })
        .from(TN)
        .where(and(eq(TN.organizationId, organizationId), eq(TN.patientId, patientId))),
    );

  /** validation_run → validation_result id chains for the patient's claims (children of children). */
  const validationIdsFor = async (tx: Tx, organizationId: string, claimIds: string[]) => {
    if (claimIds.length === 0) return { runIds: [] as string[], resultIds: [] as string[] };
    const runIds = ids(
      await tx
        .select({ id: VRUN.id })
        .from(VRUN)
        .where(and(eq(VRUN.organizationId, organizationId), inArray(VRUN.claimId, claimIds))),
    );
    const resultIds =
      runIds.length === 0
        ? []
        : ids(
            await tx
              .select({ id: VRES.id })
              .from(VRES)
              .where(
                and(eq(VRES.organizationId, organizationId), inArray(VRES.validationRunId, runIds)),
              ),
          );
    return { runIds, resultIds };
  };

  return {
    async erasePatientBillingRecord({ organizationId, patientId }) {
      // ── Phase 1: the §3.7 guards, then the redact-field shred. Commits BEFORE any delete. ──────────
      await db.transaction(async (tx) => {
        if (
          options.surveyorHold &&
          (await options.surveyorHold.isPatientBillingHeld(organizationId, patientId))
        ) {
          throw new BillingEraseRefused("surveyor_hold");
        }

        // In-flight guard: a claim/NOE/NOTR still moving through submission or awaiting a MAC ack
        // refuses the whole erase (the M4 cert workflow retries after the lifecycle settles).
        const inFlightClaim = await tx
          .select({ id: C.id })
          .from(C)
          .where(
            and(
              eq(C.organizationId, organizationId),
              eq(C.patientId, patientId),
              inArray(C.state, [...M23_IN_FLIGHT_STATES]),
            ),
          )
          .limit(1);
        if (inFlightClaim.length > 0) throw new BillingEraseRefused("claim_in_flight");

        const inFlightNoe = await tx
          .select({ id: NOE.id })
          .from(NOE)
          .where(
            and(
              eq(NOE.organizationId, organizationId),
              eq(NOE.patientId, patientId),
              inArray(NOE.state, [...M23_IN_FLIGHT_STATES]),
            ),
          )
          .limit(1);
        if (inFlightNoe.length > 0) throw new BillingEraseRefused("noe_in_flight");

        const inFlightNotr = await tx
          .select({ id: NOTR.id })
          .from(NOTR)
          .where(
            and(
              eq(NOTR.organizationId, organizationId),
              eq(NOTR.patientId, patientId),
              inArray(NOTR.state, [...M23_IN_FLIGHT_STATES]),
            ),
          )
          .limit(1);
        if (inFlightNotr.length > 0) throw new BillingEraseRefused("notr_in_flight");

        const inFlightTransferNotice = await tx
          .select({ id: TN.id })
          .from(TN)
          .where(
            and(
              eq(TN.organizationId, organizationId),
              eq(TN.patientId, patientId),
              inArray(TN.state, [...M23_IN_FLIGHT_STATES]),
            ),
          )
          .limit(1);
        if (inFlightTransferNotice.length > 0) {
          throw new BillingEraseRefused("transfer_notice_in_flight");
        }

        // Shred the free-text §3.7 redact fields (M23_REDACT_FIELDS) so a partial delete failure
        // leaves nothing readable: claim.replacement_reason + validation_override.reason, and the corrected
        // NOE / NOTR's correction_reason (migration 0378; the sentinel satisfies its 20..2000 CHECK).
        await tx
          .update(NOE)
          .set({ correctionReason: M23_REDACT_SENTINEL })
          .where(
            and(
              eq(NOE.organizationId, organizationId),
              eq(NOE.patientId, patientId),
              isNotNull(NOE.correctionReason),
            ),
          );
        await tx
          .update(NOTR)
          .set({ correctionReason: M23_REDACT_SENTINEL })
          .where(
            and(
              eq(NOTR.organizationId, organizationId),
              eq(NOTR.patientId, patientId),
              isNotNull(NOTR.correctionReason),
            ),
          );
        await tx
          .update(C)
          .set({ replacementReason: M23_REDACT_SENTINEL })
          .where(
            and(
              eq(C.organizationId, organizationId),
              eq(C.patientId, patientId),
              isNotNull(C.replacementReason),
            ),
          );

        const claimIds = await claimIdsFor(tx, organizationId, patientId);
        const { resultIds } = await validationIdsFor(tx, organizationId, claimIds);
        if (resultIds.length > 0) {
          await tx
            .update(VO)
            .set({ reason: M23_REDACT_SENTINEL })
            .where(and(eq(VO.organizationId, organizationId), inArray(VO.resultId, resultIds)));
        }
      });

      // ── Phase 2: the §3.7 FK-unwind cascade, in exactly M23_PATIENT_CASCADE_ORDER. Ids are ─────────
      // re-resolved (phase 1 committed independently); counts come from rows actually deleted.
      return db.transaction(async (tx): Promise<BillingEraseTableCounts> => {
        const claimIds = await claimIdsFor(tx, organizationId, patientId);
        const noeIds = await noeIdsFor(tx, organizationId, patientId);
        const notrIds = await notrIdsFor(tx, organizationId, patientId);
        const transferNoticeIds = await transferNoticeIdsFor(tx, organizationId, patientId);
        const { runIds, resultIds } = await validationIdsFor(tx, organizationId, claimIds);

        // 1. eligibility_check (patient-keyed directly).
        const eligibilityChecks = (
          await tx
            .delete(EC)
            .where(and(eq(EC.organizationId, organizationId), eq(EC.patientId, patientId)))
            .returning({ id: EC.id })
        ).length;

        // Submissions reachable from any of the patient's claim/NOE/NOTR roots (the
        // `claim_submission_exactly_one_subject` CHECK guarantees each row has exactly one subject).
        const subjectArms = [
          claimIds.length > 0 ? inArray(CS.claimId, claimIds) : undefined,
          noeIds.length > 0 ? inArray(CS.noeId, noeIds) : undefined,
          notrIds.length > 0 ? inArray(CS.notrId, notrIds) : undefined,
          transferNoticeIds.length > 0
            ? inArray(CS.transferNoticeId, transferNoticeIds)
            : undefined,
        ].filter((arm) => arm !== undefined);
        const submissionIds =
          subjectArms.length === 0
            ? []
            : ids(
                await tx
                  .select({ id: CS.id })
                  .from(CS)
                  .where(and(eq(CS.organizationId, organizationId), or(...subjectArms))),
              );

        // 2. claim_acknowledgment (references claim_submission + claim, both `onDelete: restrict` —
        //    every ack row carries a NOT NULL submission_id, so the submission chain reaches them all).
        const acknowledgments =
          submissionIds.length === 0
            ? 0
            : (
                await tx
                  .delete(CA)
                  .where(
                    and(
                      eq(CA.organizationId, organizationId),
                      inArray(CA.submissionId, submissionIds),
                    ),
                  )
                  .returning({ id: CA.id })
              ).length;

        // 3. claim_submission.
        const submissions =
          submissionIds.length === 0
            ? 0
            : (
                await tx
                  .delete(CS)
                  .where(and(eq(CS.organizationId, organizationId), inArray(CS.id, submissionIds)))
                  .returning({ id: CS.id })
              ).length;

        // 4. claim_state_history.
        const stateHistory =
          claimIds.length === 0
            ? 0
            : (
                await tx
                  .delete(CSH)
                  .where(
                    and(eq(CSH.organizationId, organizationId), inArray(CSH.claimId, claimIds)),
                  )
                  .returning({ id: CSH.id })
              ).length;

        // 5-7. validation_override → validation_result → validation_run (real intra-M23 FKs).
        const overrides =
          resultIds.length === 0
            ? 0
            : (
                await tx
                  .delete(VO)
                  .where(
                    and(eq(VO.organizationId, organizationId), inArray(VO.resultId, resultIds)),
                  )
                  .returning({ id: VO.id })
              ).length;
        const results =
          resultIds.length === 0
            ? 0
            : (
                await tx
                  .delete(VRES)
                  .where(and(eq(VRES.organizationId, organizationId), inArray(VRES.id, resultIds)))
                  .returning({ id: VRES.id })
              ).length;
        const runs =
          runIds.length === 0
            ? 0
            : (
                await tx
                  .delete(VRUN)
                  .where(and(eq(VRUN.organizationId, organizationId), inArray(VRUN.id, runIds)))
                  .returning({ id: VRUN.id })
              ).length;

        // 8-10. sia_calculation → hipps_calculation → claim_line.
        const siaCalcs =
          claimIds.length === 0
            ? 0
            : (
                await tx
                  .delete(SIA)
                  .where(
                    and(eq(SIA.organizationId, organizationId), inArray(SIA.claimId, claimIds)),
                  )
                  .returning({ id: SIA.id })
              ).length;
        const hippsCalcs =
          claimIds.length === 0
            ? 0
            : (
                await tx
                  .delete(HIPPS)
                  .where(
                    and(eq(HIPPS.organizationId, organizationId), inArray(HIPPS.claimId, claimIds)),
                  )
                  .returning({ id: HIPPS.id })
              ).length;
        const claimLines =
          claimIds.length === 0
            ? 0
            : (
                await tx
                  .delete(CL)
                  .where(and(eq(CL.organizationId, organizationId), inArray(CL.claimId, claimIds)))
                  .returning({ id: CL.id })
              ).length;

        // 11-13. claim → noe_record → notr_record.
        const claims =
          claimIds.length === 0
            ? 0
            : (
                await tx
                  .delete(C)
                  .where(and(eq(C.organizationId, organizationId), inArray(C.id, claimIds)))
                  .returning({ id: C.id })
              ).length;
        const noes =
          noeIds.length === 0
            ? 0
            : (
                await tx
                  .delete(NOE)
                  .where(and(eq(NOE.organizationId, organizationId), inArray(NOE.id, noeIds)))
                  .returning({ id: NOE.id })
              ).length;
        const notrs =
          notrIds.length === 0
            ? 0
            : (
                await tx
                  .delete(NOTR)
                  .where(and(eq(NOTR.organizationId, organizationId), inArray(NOTR.id, notrIds)))
                  .returning({ id: NOTR.id })
              ).length;

        // 14. transfer_notice_record — corrections / voids first (their `supersedes_notice_id` RESTRICTs
        // the original they act on), then the originals.
        const transferNoticeFollowUps =
          transferNoticeIds.length === 0
            ? 0
            : (
                await tx
                  .delete(TN)
                  .where(
                    and(
                      eq(TN.organizationId, organizationId),
                      inArray(TN.id, transferNoticeIds),
                      isNotNull(TN.supersedesNoticeId),
                    ),
                  )
                  .returning({ id: TN.id })
              ).length;
        const transferNoticeOriginals =
          transferNoticeIds.length === 0
            ? 0
            : (
                await tx
                  .delete(TN)
                  .where(
                    and(eq(TN.organizationId, organizationId), inArray(TN.id, transferNoticeIds)),
                  )
                  .returning({ id: TN.id })
              ).length;

        return {
          eligibility_check: eligibilityChecks,
          claim_acknowledgment: acknowledgments,
          claim_submission: submissions,
          claim_state_history: stateHistory,
          validation_override: overrides,
          validation_result: results,
          validation_run: runs,
          sia_calculation: siaCalcs,
          hipps_calculation: hippsCalcs,
          claim_line: claimLines,
          claim: claims,
          noe_record: noes,
          notr_record: notrs,
          transfer_notice_record: transferNoticeFollowUps + transferNoticeOriginals,
        };
      });
    },

    async eraseOrgBillingConfig({ organizationId }) {
      // Crypto-shred the MAC secret ciphertext FIRST in its own committed transaction (the DEK rotation
      // half is the M4 org-destruction driver's step) — if the delete pass then fails, the secret is
      // already unrecoverable. `sequestration_policy.set_reason` is NOT redacted in place (the
      // forward-only CHECK would refuse the UPDATE on historical rows — see the factory header); its
      // rows are deleted whole below. Platform-shared `wage_index_factor` rows are NEVER touched (D12).
      await db.transaction(async (tx) => {
        await tx
          .update(MAC)
          .set({ clientSecretCipher: M23_SHREDDED_CIPHER })
          .where(eq(MAC.organizationId, organizationId));
      });

      return db.transaction(async (tx): Promise<BillingEraseTableCounts> => {
        const macCredentials = (
          await tx
            .delete(MAC)
            .where(eq(MAC.organizationId, organizationId))
            .returning({ id: MAC.id })
        ).length;
        const sequestrationPolicies = (
          await tx.delete(SP).where(eq(SP.organizationId, organizationId)).returning({ id: SP.id })
        ).length;
        const ruleConfigs = (
          await tx
            .delete(VRC)
            .where(eq(VRC.organizationId, organizationId))
            .returning({ id: VRC.id })
        ).length;
        // F-210 — the tenant-entered rate versions (migration 0279 grants the destruction role SELECT+DELETE).
        const hospiceRateTables = (
          await tx
            .delete(schema.hospiceRateTable)
            .where(eq(schema.hospiceRateTable.organizationId, organizationId))
            .returning({ id: schema.hospiceRateTable.id })
        ).length;
        // F-211 — the tenant-entered wage index (migration 0280 grants the destruction role SELECT+DELETE).
        const tenantWageIndexes = (
          await tx
            .delete(schema.tenantWageIndex)
            .where(eq(schema.tenantWageIndex.organizationId, organizationId))
            .returning({ id: schema.tenantWageIndex.id })
        ).length;
        return {
          tenant_wage_index: tenantWageIndexes,
          hospice_rate_table: hospiceRateTables,
          mac_submitter_credential: macCredentials,
          sequestration_policy: sequestrationPolicies,
          validation_rule_config: ruleConfigs,
        };
      });
    },
  };
}

/**
 * Register the REAL M23 billing eraser over the Phase-0 `billing_record` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M27/M30 use — the composition root passes its bootstrap `registerEraser` as
 * `deps.registerEraser` (M23 cannot import the M1-owned bootstrap registry). The in-memory slice store is
 * the default; prod injects `createDrizzleBillingEraseStore(db)` bound to the PRIVILEGED M4 destruction-cert
 * connection (wardenx_admin — the app role holds no DELETE on any M23 table, migration 0077).
 *
 * TODO(M23 boot-wiring, Integrate phase): (1) add `"billing_record"` to the `@wardenx/types` `DataClass`
 * union + `REQUIRED_ERASERS` so the deny-stub exists to register over; (2) have the M4 org-destruction
 * driver invoke `store.eraseOrgBillingConfig` (MAC `client_secret_cipher` cryptographic shred incl. the DEK
 * rotation + operational config) when it lands — the Drizzle store above already implements both paths.
 */
export function registerBillingErasers(deps: BillingEraserDeps): void {
  const store = deps.store ?? createInMemoryBillingEraseStore();
  deps.registerEraser(BILLING_DATA_CLASS, createBillingEraser(store));
}
