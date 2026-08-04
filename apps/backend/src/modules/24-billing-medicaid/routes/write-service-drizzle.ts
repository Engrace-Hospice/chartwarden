// apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts — the Drizzle-backed M24 WRITE
// service. Each command runs under withOrgContext (RLS), validates the §2.2 transition via the pure
// @wardenx/medicaid-adapters reducers, stamps the acting membership, writes an append-only
// medicaid_claim_state_history row, and emits the §4.11 outbox event on the caller's tx (transactional
// outbox). A bad transition → INVALID_TRANSITION (409); a stale If-Match → VERSION_CONFLICT (409); a missing
// row → NOT_FOUND. Money is INTEGER cents; no MBI/Recipient ID enters an outbox payload (D12 / D13 / §3.6).
//
// DEFERRAL (the M25/M26 posture): commands that need an unbound consumed reader DEGRADE to a structured typed
// error / queued no-op rather than crashing — assembleClaim (M5/M6/M40 readers), refreshEligibility (M5
// unlock + the per-state 270/271 adapter), testCredential + submitClaim adapter wire I/O (the state adapter),
// loadRateSchedule (M40), registerPlatformRule (rules are the frozen code registry). Each is noted at its site.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_MEDICAID_RULES,
  DEFAULT_MEDICAID_RULE_SET_VERSION,
  type MedicaidValidationContext,
  deriveMedicaidControlNumber,
  medicaidClaimMachine,
  parseMedicaidControlNumber,
  rbArrangementMachine,
  replacementTob,
  runMedicaidRules,
  voidTob,
} from "@wardenx/medicaid-adapters";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { CredentialCipherPort } from "../credential-crypto";
import type { M24WriteActor } from "./actor";
import type { ClaimView, RbArrangementView } from "./read-service";
import type {
  ApplyOverrideInput,
  AssembleClaimInput,
  CreateCustomRuleInput,
  CreateRbArrangementInput,
  EditRbArrangementInput,
  EditRuleConfigInput,
  LoadRateScheduleInput,
  M24WriteService,
  OverrideRbDayInput,
  RefreshEligibilityInput,
  RegisterPlatformRuleInput,
  ReplaceClaimInput,
  SubmitClaimInput,
  TerminateRbArrangementInput,
  UpdateDraftClaimInput,
  UpsertCredentialInput,
  VoidClaimInput,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

class ConflictError extends WardenXError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "ConflictError";
  }
}
class DegradedError extends WardenXError {
  constructor(code: string, message: string) {
    super(code, message, 503);
    this.name = "DegradedError";
  }
}

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const day = (d: Date | string | null): string => iso(d).slice(0, 10);
const dayN = (d: Date | string | null): string | null => (d === null ? null : day(d));

/**
 * Refuse to store a secret when no cipher port is bound, rather than dropping it. The pre-crypto placeholder
 * accepted the secret and wrote a sentinel — the caller believed it was saved. Failing loudly is the only
 * honest option when the KEK is absent.
 */
const UNBOUND_CIPHER: CredentialCipherPort = {
  seal() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be stored — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
  open() {
    throw new DegradedError(
      "CREDENTIAL_CRYPTO_UNBOUND",
      "credential secrets cannot be read — M24_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  },
};

/**
 * How the write path resolves a patient's Medicaid coverage. Bound at the composition root to M5's §3.4
 * `PatientCoverageReader` seam (via getSeam); left undefined in a slice/test, where the paths that need it
 * degrade with a precise message instead of a blanket "readers unbound".
 */
export interface CoverageResolverPort {
  activeMedicaidCoverage(input: {
    organizationId: string;
    patientId: string;
    onDate: string;
  }): Promise<{ id: string; payerId: string; subscriberId: string } | null>;
}

export function buildDrizzleM24WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
  cipher: CredentialCipherPort = UNBOUND_CIPHER,
  coverage?: CoverageResolverPort,
): M24WriteService {
  const C = schema.medicaidClaim;
  const SUB = schema.medicaidSubmission;
  const VR = schema.medicaidValidationRun;
  const VRES = schema.medicaidValidationResult;
  const VOV = schema.medicaidValidationOverride;
  const RC = schema.medicaidValidationRuleConfig;
  const A = schema.rbArrangement;
  const RD = schema.rbDay;
  const TP = schema.stateMedicaidTradingPartnerCredential;
  const SH = schema.medicaidClaimStateHistory;
  const RULES_BY_KEY = new Map(DEFAULT_MEDICAID_RULES.map((r) => [r.key, r]));

  async function loadClaim(tx: Tx, claimId: string) {
    const rows = await tx.select().from(C).where(eq(C.id, claimId)).limit(1);
    if (!rows[0]) throw new NotFoundError("medicaid claim not found");
    return rows[0];
  }
  function assertVersion(row: { version: number }, expected: number | null): void {
    if (expected !== null && row.version !== expected) {
      throw new ConflictError(
        "VERSION_CONFLICT",
        "the If-Match version is stale; reload and retry",
      );
    }
  }
  async function recordHistory(
    tx: Tx,
    orgId: string,
    claimId: string,
    fromState: (typeof C.state.enumValues)[number] | null,
    toState: (typeof C.state.enumValues)[number],
    actorMembershipId: string,
    reason: string | null,
  ): Promise<void> {
    await tx.insert(SH).values({
      organizationId: orgId,
      medicaidClaimId: claimId,
      fromState,
      toState,
      reason,
      triggerSource: "user",
      actorMembershipId,
    });
  }

  function toClaimView(r: typeof C.$inferSelect): ClaimView {
    return {
      id: r.id,
      providerEntityId: r.providerEntityId,
      patientId: r.patientId,
      admissionId: r.admissionId,
      serviceState: r.serviceState,
      kind: r.kind,
      tob: r.tob,
      serviceFrom: day(r.serviceFrom),
      serviceTo: day(r.serviceTo),
      mcoId: r.mcoId ?? null,
      medicareClaimId: r.medicareClaimId ?? null,
      rbArrangementId: r.rbArrangementId ?? null,
      medicaidClaimControlNumber: r.medicaidClaimControlNumber,
      state: r.state,
      version: r.version,
      validationRunIdLatest: r.validationRunIdLatest ?? null,
      eligibilityOutcomeSnapshot: r.eligibilityOutcomeSnapshot ?? null,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }
  function toArrangementView(r: typeof A.$inferSelect): RbArrangementView {
    return {
      id: r.id,
      patientId: r.patientId,
      providerEntityId: r.providerEntityId,
      nfFacilityMdmId: r.nfFacilityMdmId,
      nfFacilityNameSnapshot: r.nfFacilityNameSnapshot,
      effectiveFrom: day(r.effectiveFrom),
      effectiveTo: dayN(r.effectiveTo),
      nfPerDiemRoutineCents: r.nfPerDiemRoutineCents,
      nfPerDiemRespCents: r.nfPerDiemRespCents,
      nfPerDiemGipCents: r.nfPerDiemGipCents,
      passThroughPct: r.passThroughPct,
      retentionPct: r.retentionPct,
      state: r.state,
      version: r.version,
      createdAt: iso(r.createdAt),
    };
  }

  return {
    // ── route 1 — assemble. The claim row needs three externally-owned values: `patient_payer_id` (M5),
    // `service_state` (the state whose Medicaid program is billed) and `state_plan_code_id` (M40). The
    // first two now RESOLVE — M5's §3.4 PatientCoverageReader gives the coverage, and the service state is
    // read from the provider entity's own active trading-partner credential (an M24-owned row: you cannot
    // bill a state you hold no credential for, which makes it the authoritative source, not a guess).
    //
    // The THIRD has no owner anywhere in the repo: no module declares a state-plan-code or state-rate-
    // schedule table (M40 has no such entity kind, M38 no such code system), so `state_plan_code_id` —
    // NOT NULL on `medicaid_claim` — cannot be populated with a real value by anyone today. Assembly
    // therefore still stops, but it now stops with the ONE missing input named, after proving the rest
    // resolves, instead of a blanket "the M5/M6/M40 readers are unbound".
    async assembleClaim(actor: M24WriteActor, input: AssembleClaimInput): Promise<ClaimView> {
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "claim assembly requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const resolved = await coverage.activeMedicaidCoverage({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        onDate: input.serviceFrom,
      });
      if (!resolved) {
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "this patient holds no Medicaid coverage in force on the claim's first service date",
        );
      }
      const serviceState = await withOrgContext(db, actor, async (tx) => {
        const creds = await tx
          .select({ serviceState: TP.serviceState, activeTo: TP.activeTo })
          .from(TP)
          .where(
            and(
              eq(TP.organizationId, actor.organizationId),
              eq(TP.providerEntityId, input.providerEntityId),
            ),
          );
        const from = new Date(input.serviceFrom);
        return creds.find((c) => c.activeTo === null || c.activeTo >= from)?.serviceState ?? null;
      });
      if (!serviceState) {
        throw new ConflictError(
          "MEDICAID_NO_ACTIVE_TRADING_PARTNER",
          "this provider entity has no active state trading-partner credential — configure one before assembling a Medicaid claim",
        );
      }
      // Everything M24 and M5 own has resolved (coverage `resolved.id`, `serviceState`). The remaining
      // blocker is upstream reference data, so name it precisely rather than implying M24 is unwired.
      throw new DegradedError(
        "MEDICAID_STATE_PLAN_CODE_CATALOG_MISSING",
        `medicaid_claim.state_plan_code_id has no source: no module owns a state-plan-code catalog for ${serviceState} (M40 declares no such entity kind). Patient coverage and service state resolved; assembly is blocked only on that catalog.`,
      );
    },

    async updateDraftClaim(actor, claimId, input: UpdateDraftClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is editable");
        assertVersion(claim, input.expectedVersion);
        const updated = await tx
          .update(C)
          .set({
            mcoId: input.mcoId === undefined ? claim.mcoId : input.mcoId,
            version: claim.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        return toClaimView(updated[0]!);
      });
    },

    async deleteDraftClaim(actor, claimId, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        if (claim.state !== "DRAFT")
          throw new ConflictError("CLAIM_NOT_DRAFT", "only a DRAFT claim is deletable");
        assertVersion(claim, expectedVersion);
        await tx.delete(C).where(eq(C.id, claimId));
      });
    },

    async validateClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        const lineRows = await tx
          .select()
          .from(schema.medicaidClaimLine)
          .where(eq(schema.medicaidClaimLine.medicaidClaimId, claimId))
          .orderBy(schema.medicaidClaimLine.lineNumber);

        // Build the minimal, PHI-free aggregate context. Every reader seam is UNBOUND (deferred), so the
        // seam-gated rules SKIP `seam_not_bound` (non-blocking). The run is honest about its degraded inputs.
        const ctx: MedicaidValidationContext = {
          orgId: actor.organizationId,
          asOfDate: day(claim.serviceFrom),
          serviceState: claim.serviceState,
          claim: {
            claimId: claim.id,
            providerEntityId: claim.providerEntityId,
            patientId: claim.patientId,
            serviceState: claim.serviceState,
            kind: claim.kind,
            tob: claim.tob as MedicaidValidationContext["claim"]["tob"],
            serviceFrom: day(claim.serviceFrom),
            serviceTo: day(claim.serviceTo),
            replacesClaimId: claim.replacesClaimId ?? null,
            medicareClaimId: claim.medicareClaimId ?? null,
            rbArrangementId: claim.rbArrangementId ?? null,
            isDualEligible: claim.medicareClaimId != null,
          },
          lines: lineRows.map((l) => ({
            claimLineId: l.id,
            serviceDate: day(l.serviceDate),
            levelOfCare: l.levelOfCare,
            revenueCode: l.revenueCode,
            qCode: l.qCode,
            modifiers: [
              l.hcpcsModifier1,
              l.hcpcsModifier2,
              l.hcpcsModifier3,
              l.hcpcsModifier4,
            ].filter((m): m is string => typeof m === "string" && m.length > 0),
            rateAtAssemblyCents: l.rateAtAssemblyCents,
            isRb: l.isRb,
            backingEncounterIds: [],
          })),
          eligibility: null,
          recipientIdFormatValid: null,
          mcoRouting: null,
          nfResidentDays: [],
          rbArrangement: null,
          rbDays: [],
          rateLookups: [],
          medicareSecondary: null,
          evvBrackets: [],
          capProjection: null,
          modifiersSatisfied: null,
          documentationSatisfied: null,
          adapterMetadata: {
            acceptsDocumentedMissingEvv: false,
            combinesHospiceAndRb: claim.kind === "combined_hospice_rb",
            supportedTobs: [claim.tob],
          },
          seams: {
            eligibilityBound: false,
            rbBound: false,
            rateScheduleBound: false,
            medicareClaimBound: false,
            capProjectionBound: false,
            mdmBound: false,
            adapterBound: false,
          },
        };

        const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, ctx);
        const runId = randomUUID();
        const now = new Date();
        await tx.insert(VR).values({
          id: runId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          ruleRegistryVersion: DEFAULT_MEDICAID_RULE_SET_VERSION,
          triggeredBy: "manual",
          claimStateAtTrigger: claim.state,
          idempotencyKey: `${claimId}:${now.getTime()}`,
          actorMembershipId: actor.userId,
          completedAt: now,
          totalResults: summary.results.length,
          failedResults: summary.failedCount,
          warnedResults: summary.warningCount,
        });
        const failedRuleKeys: string[] = [];
        for (const r of summary.results) {
          const skipReason = r.annotations?.skipReason;
          const outcome = skipReason
            ? ("skip_not_applicable" as const)
            : r.passed
              ? ("pass" as const)
              : r.severity === "warn"
                ? ("warn" as const)
                : r.severity === "info"
                  ? ("info" as const)
                  : ("fail" as const);
          if (outcome === "fail") failedRuleKeys.push(r.ruleKey);
          await tx.insert(VRES).values({
            organizationId: actor.organizationId,
            medicaidValidationRunId: runId,
            ruleKey: r.ruleKey,
            ruleVersion: RULES_BY_KEY.get(r.ruleKey)?.version ?? 1,
            outcome,
            remediationSummary: r.message.length > 0 ? r.message : null,
          });
        }

        const nextState = summary.blockingFailures === 0 ? "READY" : "FAILED_VALIDATION";
        await tx
          .update(C)
          .set({
            state: nextState,
            validationRunIdLatest: runId,
            updatedAt: now,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId));
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "VALIDATING",
          actor.userId,
          "validate",
        );
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          "VALIDATING",
          nextState,
          actor.userId,
          null,
        );

        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.validation_started",
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: runId,
            trigger: "manual",
          },
        });
        await outbox.publish(
          tx,
          nextState === "READY"
            ? {
                eventName: "m24.medicaid_claim.ready_for_submission",
                payload: { organizationId: actor.organizationId, claimId, validationRunId: runId },
              }
            : {
                eventName: "m24.medicaid_claim.validation_failed",
                payload: {
                  organizationId: actor.organizationId,
                  claimId,
                  validationRunId: runId,
                  failedRuleKeys,
                },
              },
        );
        return { validationRunId: runId };
      });
    },

    async submitClaim(actor, claimId, input: SubmitClaimInput) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        assertVersion(claim, input.expectedVersion);
        const reduced = medicaidClaimMachine.reduce(claim.state, "submit", {
          unresolvedBlockingFailures: 0,
        });
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot submit from ${claim.state}`);
        const submissionId = randomUUID();
        const submittedAt = new Date();
        const channel = input.channelHint ?? "direct_mmis";
        // Adapter wire I/O is DEFERRED — the submission row is created in `pending` and the per-state submit
        // worker drives the real envelope when the adapter binds (§4.5/§4.9). The state advances to SUBMITTED.
        await tx.insert(SUB).values({
          id: submissionId,
          organizationId: actor.organizationId,
          medicaidClaimId: claimId,
          providerEntityId: claim.providerEntityId,
          serviceState: claim.serviceState,
          channel,
          mcoIdSnapshot: claim.mcoId ?? null,
          medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
          attemptIndex: 0,
          adapterVendor: "deferred",
          adapterVersion: "0",
          result: "pending",
          createdByMembershipId: actor.userId,
        });
        const updated = await tx
          .update(C)
          .set({
            state: "SUBMITTED",
            version: claim.version + 1,
            updatedAt: submittedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "SUBMITTED",
          actor.userId,
          "submit",
        );
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submit_requested",
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            attemptIndex: 0,
            channel,
            mcoId: claim.mcoId ?? null,
          },
        });
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.submitted",
          payload: {
            organizationId: actor.organizationId,
            claimId,
            submissionId,
            medicaidClaimControlNumber: claim.medicaidClaimControlNumber,
            state: "SUBMITTED",
            channel,
            mcoId: claim.mcoId ?? null,
            submittedAt: submittedAt.toISOString(),
          },
        });
        return toClaimView(updated[0]!);
      });
    },

    async replaceClaim(actor, claimId, input: ReplaceClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "817", input.reason);
    },
    async voidClaim(actor, claimId, input: VoidClaimInput) {
      return buildSuccessorClaim(actor, claimId, input.expectedVersion, "818", input.reason);
    },

    async abandonClaim(actor, claimId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await loadClaim(tx, claimId);
        assertVersion(claim, expectedVersion);
        const reduced = medicaidClaimMachine.reduce(claim.state, "abandon");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot abandon from ${claim.state}`);
        const updated = await tx
          .update(C)
          .set({
            state: "ABANDONED",
            version: claim.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(C.id, claimId))
          .returning();
        await recordHistory(
          tx,
          actor.organizationId,
          claimId,
          claim.state,
          "ABANDONED",
          actor.userId,
          "abandon",
        );
        return toClaimView(updated[0]!);
      });
    },

    async applyOverride(actor, resultId, input: ApplyOverrideInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(VRES).where(eq(VRES.id, resultId)).limit(1);
        const result = rows[0];
        if (!result) throw new NotFoundError("validation result not found");
        const runRows = await tx
          .select({ claimId: VR.medicaidClaimId })
          .from(VR)
          .where(eq(VR.id, result.medicaidValidationRunId))
          .limit(1);
        const claimId = runRows[0]?.claimId ?? "";
        const overrideId = randomUUID();
        await tx.insert(VOV).values({
          id: overrideId,
          organizationId: actor.organizationId,
          medicaidValidationResultId: resultId,
          medicaidClaimId: claimId,
          ruleKey: result.ruleKey,
          overrideRoleApplied: input.overrideRoleClaimed,
          reason: input.reason,
          stepUpAuthTokenAt: new Date(),
          actorMembershipId: actor.userId,
        });
        await outbox.publish(tx, {
          eventName: "m24.medicaid_claim.override_applied",
          payload: {
            organizationId: actor.organizationId,
            claimId,
            validationRunId: result.medicaidValidationRunId,
            resultId,
            overrideId,
            ruleKey: result.ruleKey,
            overrideRoleApplied: input.overrideRoleClaimed,
          },
        });
        return { overrideId };
      });
    },

    async editRuleConfig(actor, ruleKey, input: EditRuleConfigInput) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(and(eq(RC.ruleKey, ruleKey), eq(RC.organizationId, actor.organizationId)))
          .limit(1);
        const regReq = RULES_BY_KEY.get(ruleKey)?.regulatoryRequired ?? false;
        if (existing[0]) {
          assertVersion(existing[0], input.expectedVersion);
          await tx
            .update(RC)
            .set({
              enabled: input.enabled ?? existing[0].enabled,
              parametersOverlay: input.parametersOverlay ?? existing[0].parametersOverlay,
              version: existing[0].version + 1,
              updatedAt: new Date(),
              updatedByMembershipId: actor.userId,
            })
            .where(eq(RC.id, existing[0].id));
        } else {
          await tx.insert(RC).values({
            organizationId: actor.organizationId,
            ruleKey,
            enabled: input.enabled ?? true,
            parametersOverlay: input.parametersOverlay ?? null,
            isCustom: false,
            regulatoryRequiredSnapshot: regReq,
            updatedByMembershipId: actor.userId,
          });
        }
      });
    },

    async createCustomRule(actor, input: CreateCustomRuleInput) {
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(RC).values({
          organizationId: actor.organizationId,
          ruleKey: input.ruleKey,
          enabled: true,
          isCustom: true,
          customPredicateDsl: input.customPredicateDsl,
          customSeverity: input.customSeverity,
          customOverrideRole: input.customOverrideRole ?? null,
          regulatoryRequiredSnapshot: false,
          updatedByMembershipId: actor.userId,
        });
      });
      return { ruleKey: input.ruleKey };
    },

    async deleteCustomRule(actor, ruleKey, expectedVersion) {
      await withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(RC)
          .where(
            and(
              eq(RC.ruleKey, ruleKey),
              eq(RC.organizationId, actor.organizationId),
              eq(RC.isCustom, true),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new NotFoundError("custom rule not found");
        assertVersion(existing[0], expectedVersion);
        await tx.delete(RC).where(eq(RC.id, existing[0].id));
      });
    },

    // ── route 22 — refresh eligibility (DEFERRED: the M5 MedicaidIdUnlockReader + the per-state 270/271
    // adapter are unbound; the row's service_state comes from M5. Degrades to a typed 503; the route exists). ──
    // The per-state 270/271 adapter is still unbound (no live MMIS to ask), but that is no reason to
    // refuse to record a check. M5's §3.4 coverage read supplies the payer + the masked recipient-id tail,
    // so the row is written with outcome `unknown` — an honest "we could not confirm", which the §11
    // freshness rule then treats as a finding. Previously this 503'd and no row existed at all, so the
    // eligibility history and MCO timeline could never populate.
    async refreshEligibility(actor, input: RefreshEligibilityInput) {
      if (!coverage) {
        throw new DegradedError(
          "MEDICAID_COVERAGE_READER_UNBOUND",
          "eligibility refresh requires M5's PatientCoverageReader seam (not bound in this environment)",
        );
      }
      const resolved = await coverage.activeMedicaidCoverage({
        organizationId: actor.organizationId,
        patientId: input.patientId,
        onDate: input.asOfServiceDate,
      });
      if (!resolved) {
        throw new ConflictError(
          "MEDICAID_COVERAGE_NOT_IN_FORCE",
          "this patient holds no Medicaid coverage in force on the requested service date",
        );
      }
      const serviceState = await withOrgContext(db, actor, async (tx) => {
        const creds = await tx
          .select({ serviceState: TP.serviceState })
          .from(TP)
          .where(eq(TP.organizationId, actor.organizationId))
          .limit(1);
        return creds[0]?.serviceState ?? null;
      });
      if (!serviceState) {
        throw new ConflictError(
          "MEDICAID_NO_ACTIVE_TRADING_PARTNER",
          "no state trading-partner credential is configured — the service state cannot be determined",
        );
      }
      // Only the last 4 of the member id is ever persisted (D12 / §3.6) — the full recipient id is read
      // from the seam, used to derive the tail, and dropped on this line.
      const maskedTail = resolved.subscriberId.slice(-4);
      const checkedAt = new Date();
      const staleAt = new Date(checkedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      const checkId = randomUUID();
      await withOrgContext(db, actor, async (tx) => {
        await tx.insert(schema.medicaidEligibilityCheck).values({
          id: checkId,
          organizationId: actor.organizationId,
          patientId: input.patientId,
          patientPayerId: resolved.id,
          serviceState,
          asOfServiceDate: new Date(input.asOfServiceDate),
          outcome: "unknown",
          recipientIdMaskedAtCheck: maskedTail,
          checkedAt,
          staleAt,
          errorMessage:
            "no state eligibility adapter is wired for this service state — coverage was resolved from the record, not confirmed with the state",
        });
        // The payload must match the REGISTERED §4.11 payloadSchema exactly — the catalog-validating
        // publisher throws on a mismatch and rolls this insert back with it.
        await outbox.publish(tx, {
          eventName: "m24.medicaid_eligibility.checked",
          payload: {
            organizationId: actor.organizationId,
            checkId,
            patientId: input.patientId,
            asOfServiceDate: new Date(input.asOfServiceDate).toISOString(),
            outcome: "unknown",
            mcoId: null,
            checkedAt: checkedAt.toISOString(),
            staleAt: staleAt.toISOString(),
          },
        });
      });
      return { checkId, outcome: "unknown" };
    },

    async createRbArrangement(actor, input: CreateRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        // The NF facility display name is normally snapshotted from M40; the resolver is unbound (deferred),
        // so the snapshot is a placeholder backfilled when M40 binds. The contract data is tenant-authored.
        const inserted = await tx
          .insert(A)
          .values({
            organizationId: actor.organizationId,
            patientId: input.patientId,
            providerEntityId: input.providerEntityId,
            nfFacilityMdmId: input.nfFacilityMdmId,
            nfFacilityNameSnapshot: "[unresolved — M40 facility resolver deferred]",
            effectiveFrom: new Date(input.effectiveFrom),
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents,
            passThroughPct: input.passThroughPct,
            retentionPct: input.retentionPct,
            contractDocumentId: input.contractDocumentId ?? null,
            state: "DRAFT",
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          })
          .returning();
        return toArrangementView(inserted[0]!);
      });
    },

    async editRbArrangement(actor, arrangementId, input: EditRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        if (arr.state !== "DRAFT")
          throw new ConflictError("ARRANGEMENT_NOT_DRAFT", "only a DRAFT arrangement is editable");
        assertVersion(arr, input.expectedVersion);
        const updated = await tx
          .update(A)
          .set({
            effectiveTo:
              input.effectiveTo === undefined ? arr.effectiveTo : new Date(input.effectiveTo),
            nfPerDiemRoutineCents: input.nfPerDiemRoutineCents ?? arr.nfPerDiemRoutineCents,
            nfPerDiemRespCents: input.nfPerDiemRespCents ?? arr.nfPerDiemRespCents,
            nfPerDiemGipCents: input.nfPerDiemGipCents ?? arr.nfPerDiemGipCents,
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        return toArrangementView(updated[0]!);
      });
    },

    async activateRbArrangement(actor, arrangementId, expectedVersion) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "activate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot activate from ${arr.state}`);
        const updated = await tx
          .update(A)
          .set({
            state: "ACTIVE",
            contractStartedAt: new Date(),
            version: arr.version + 1,
            updatedAt: new Date(),
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.activated",
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            patientId: row.patientId,
            nfFacilityMdmId: row.nfFacilityMdmId,
            effectiveFrom: day(row.effectiveFrom),
            effectiveTo: dayN(row.effectiveTo),
          },
        });
        return toArrangementView(row);
      });
    },

    async terminateRbArrangement(actor, arrangementId, input: TerminateRbArrangementInput) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, arrangementId)).limit(1);
        const arr = rows[0];
        if (!arr) throw new NotFoundError("R&B arrangement not found");
        assertVersion(arr, input.expectedVersion);
        const reduced = rbArrangementMachine.reduce(arr.state, "terminate");
        if (reduced.error)
          throw new ConflictError("INVALID_TRANSITION", `cannot terminate from ${arr.state}`);
        const terminatedAt = new Date();
        const updated = await tx
          .update(A)
          .set({
            state: "TERMINATED",
            contractTerminatedAt: terminatedAt,
            terminationReason: input.reason,
            version: arr.version + 1,
            updatedAt: terminatedAt,
            updatedByMembershipId: actor.userId,
          })
          .where(eq(A.id, arrangementId))
          .returning();
        const row = updated[0]!;
        await outbox.publish(tx, {
          eventName: "m24.rb_arrangement.ended",
          payload: {
            organizationId: actor.organizationId,
            rbArrangementId: row.id,
            endedState: "TERMINATED",
            endedAt: terminatedAt.toISOString(),
            reason: input.reason,
          },
        });
        return toArrangementView(row);
      });
    },

    async overrideRbDay(actor, rbDayId, input: OverrideRbDayInput) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(RD).where(eq(RD.id, rbDayId)).limit(1);
        const rbDay = rows[0];
        if (!rbDay) throw new NotFoundError("R&B day not found");
        assertVersion(rbDay, input.expectedVersion);
        const updated = await tx
          .update(RD)
          .set({
            status: input.status,
            exclusionReason: input.exclusionReason ?? rbDay.exclusionReason,
            version: rbDay.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(RD.id, rbDayId))
          .returning({ id: RD.id });
        if (!updated[0]) throw new NotFoundError("R&B day not found");
      });
    },

    async upsertCredential(actor, input: UpsertCredentialInput) {
      return withOrgContext(db, actor, async (tx) => {
        const existing = await tx
          .select()
          .from(TP)
          .where(
            and(
              eq(TP.organizationId, actor.organizationId),
              eq(TP.providerEntityId, input.providerEntityId),
              eq(TP.serviceState, input.serviceState),
              eq(TP.channel, input.channel),
            ),
          )
          .limit(1);
        // §8.7 envelope encryption under the per-tenant HKDF DEK. A submitted secret is SEALED (never
        // stored plaintext, never returned by any read); an omitted secret leaves the existing cipher
        // untouched, so a PATCH-shaped upsert cannot silently blank a credential. With no KEK bound the
        // seal THROWS — storing a sentinel and reporting success is what the placeholder did wrong.
        const clientSecretCipher =
          input.clientSecret != null
            ? cipher.seal(actor.organizationId, input.clientSecret)
            : (existing[0]?.clientSecretCipher ?? null);
        const sftpKeyCipher =
          input.sftpKey != null
            ? cipher.seal(actor.organizationId, input.sftpKey)
            : (existing[0]?.sftpKeyCipher ?? null);
        let id: string;
        let version: number;
        if (existing[0]) {
          id = existing[0].id;
          version = existing[0].version + 1;
          await tx
            .update(TP)
            .set({
              mcoId: input.mcoId ?? null,
              tradingPartnerId: input.tradingPartnerId,
              clientId: input.clientId ?? null,
              clientSecretCipher,
              sftpHost: input.sftpHost ?? null,
              sftpUser: input.sftpUser ?? null,
              sftpKeyCipher,
              portalUrl: input.portalUrl ?? null,
              activeFrom: new Date(input.activeFrom),
              activeTo: input.activeTo ? new Date(input.activeTo) : null,
              version,
              updatedAt: new Date(),
              updatedByMembershipId: actor.userId,
            })
            .where(eq(TP.id, id));
        } else {
          id = randomUUID();
          version = 1;
          await tx.insert(TP).values({
            id,
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            serviceState: input.serviceState,
            channel: input.channel,
            mcoId: input.mcoId ?? null,
            tradingPartnerId: input.tradingPartnerId,
            clientId: input.clientId ?? null,
            clientSecretCipher,
            sftpHost: input.sftpHost ?? null,
            sftpUser: input.sftpUser ?? null,
            sftpKeyCipher,
            portalUrl: input.portalUrl ?? null,
            activeFrom: new Date(input.activeFrom),
            activeTo: input.activeTo ? new Date(input.activeTo) : null,
            createdByMembershipId: actor.userId,
            updatedByMembershipId: actor.userId,
          });
        }
        await outbox.publish(tx, {
          eventName: "m24.medicaid_trading_partner.updated",
          payload: {
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            state: input.serviceState,
            channel: input.channel,
            mcoId: input.mcoId ?? null,
            version,
          },
        });
        return { id };
      });
    },

    // ── route 34 — test credential (DEFERRED: the per-state sandbox adapter is unbound; records the attempt
    // result as deferred, never throws). ──
    async testCredential(actor, credentialId) {
      return withOrgContext(db, actor, async (tx) => {
        const updated = await tx
          .update(TP)
          .set({
            lastSandboxTestAt: new Date(),
            lastSandboxTestResult: "deferred",
            lastSandboxTestError: "state sandbox adapter not wired (deferred, §4.5)",
          })
          .where(eq(TP.id, credentialId))
          .returning({ id: TP.id });
        if (!updated[0]) throw new NotFoundError("credential not found");
        return { ok: false, errorMessage: "state sandbox adapter not wired (deferred)" };
      });
    },

    // ── route 37 — register platform rule (the §4.6 rule registry is the FROZEN code-defined
    // DEFAULT_MEDICAID_RULES; there is no platform-rule table. Accepted as a no-op until a dynamic
    // platform-rule store lands — the M26 platform-constant posture). ──
    async registerPlatformRule(_actor, _input: RegisterPlatformRuleInput) {
      return;
    },

    // ── route 38 — load rate schedule (platform-only; delegates to the M40 loader, which is unbound.
    // Accepted as a queued no-op — the M40 delegation binds later). ──
    async loadRateSchedule(_actor, _input: LoadRateScheduleInput) {
      return { queued: true };
    },
  };

  /** Build a TOB 817 replacement / 818 void successor DRAFT claim by copying the original (D13 §2.5). */
  async function buildSuccessorClaim(
    actor: M24WriteActor,
    originalClaimId: string,
    expectedVersion: number | null,
    tob: "817" | "818",
    reason: string,
  ): Promise<ClaimView> {
    return withOrgContext(db, actor, async (tx) => {
      const original = await loadClaim(tx, originalClaimId);
      assertVersion(original, expectedVersion);
      if (!["ACK_ACCEPTED", "ACK_PARTIAL", "PAID"].includes(original.state)) {
        throw new ConflictError(
          "CLAIM_NOT_REPLACEABLE",
          `cannot build a ${tob} from state ${original.state}`,
        );
      }
      const newId = randomUUID();
      const parsed = parseMedicaidControlNumber(original.medicaidClaimControlNumber);
      const ccn = parsed?.ccn ?? "000000";
      const controlNumber = deriveMedicaidControlNumber({
        ccn,
        serviceState: original.serviceState,
        serviceFrom: day(original.serviceFrom),
        claimId: newId,
        attemptIndex: 0,
      });
      const successorTob = tob === "817" ? replacementTob(original.tob) : voidTob(original.tob);
      const inserted = await tx
        .insert(C)
        .values({
          id: newId,
          organizationId: actor.organizationId,
          providerEntityId: original.providerEntityId,
          locationId: original.locationId ?? null,
          patientId: original.patientId,
          patientPayerId: original.patientPayerId,
          admissionId: original.admissionId,
          serviceState: original.serviceState,
          kind: original.kind,
          tob: successorTob,
          serviceFrom: original.serviceFrom,
          serviceTo: original.serviceTo,
          statePlanCodeId: original.statePlanCodeId,
          statePlanCodeSnapshot: original.statePlanCodeSnapshot,
          mcoId: original.mcoId ?? null,
          mcoSnapshot: original.mcoSnapshot ?? null,
          medicareClaimId: original.medicareClaimId ?? null,
          medicareSecondaryContextSnapshot: original.medicareSecondaryContextSnapshot ?? null,
          rbArrangementId: original.rbArrangementId ?? null,
          medicaidClaimControlNumber: controlNumber,
          state: "DRAFT",
          replacesClaimId: original.id,
          createdByMembershipId: actor.userId,
          updatedByMembershipId: actor.userId,
        })
        .returning();
      await tx
        .update(C)
        .set({ replacedByClaimId: newId, updatedAt: new Date() })
        .where(eq(C.id, originalClaimId));
      await recordHistory(
        tx,
        actor.organizationId,
        newId,
        null,
        "DRAFT",
        actor.userId,
        `${tob}:${reason}`,
      );
      return toClaimView(inserted[0]!);
    });
  }
}
