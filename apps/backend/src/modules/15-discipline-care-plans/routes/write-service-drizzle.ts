// apps/backend/src/modules/15-discipline-care-plans/routes/write-service-drizzle.ts — the Drizzle-backed
// M15 WRITE service (§4.1 routes 6–18, 20–22, 24).
//
// Shape of EVERY command: open `withOrgContext` (RLS pins app.org_id) → load the aggregate row → run the
// PURE §2.2/§2.3 decision (`../lifecycle`, `../volunteer`) over already-resolved cross-module facts
// (`../consumers` resolves M7/M8 through the seam registry) → apply the row change with the §2.5
// optimistic-concurrency guard → emit the §2.4 outbox event on the SAME tx. No business rule lives in SQL,
// and no event can outlive a rolled-back write.
//
// The M4 write-audit triggers (migration 0099) record every mutation with the per-table denylist, so this
// layer never hand-writes an audit row — the denylisted narrative columns (`supervisory_narrative`,
// `corrective_actions`, `discontinuation_reason`, `amendment_reason`, `revoked_reason`, `notes`,
// `spiritual_care_declined`, the assessment `data` payload) are scrubbed at the trigger, which is why they
// may be written here in full.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import type {
  DisciplineAssessmentKind,
  DisciplineAuthorRole,
  DisciplineGoalSource,
  DisciplinePlanKind,
  DisciplineRequiredSignerSet,
  DisciplineSignerRole,
  IsoInstant,
  MembershipId,
  VolunteerGateKind,
} from "@wardenx/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import {
  assertParentElements,
  isAssessmentEncounterValid,
  isSupervisoryEncounterValid,
} from "../consumers/index";
import {
  DisciplinePlanStateError,
  checkAuthoringDiscipline,
  checkDpoaGoalConsent,
  checkGoalTextVerbatim,
  checkInterventionFrequency,
  checkOptimisticConcurrency,
  checkPlanWritable,
  computeNextSupervisoryDueAt,
  decideRecordSignature,
  decideRecordSupervisoryVisit,
  resolveRequiredSignerSet,
  transitionDisciplineAssessment,
  transitionDisciplineGoal,
  transitionDisciplineIntervention,
  transitionDisciplinePlanVersion,
} from "../lifecycle/index";
import {
  type VolunteerGateFacts,
  checkVolunteerHourEntry,
  decideCreateVolunteerAssignment,
  decideReactivateAssignment,
  decideRecordGate,
  decideRevokeGate,
  deriveGateStatus,
} from "../volunteer/index";
import type { M15WriteActor } from "./actor";
import type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanVersionDetail,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
} from "./read-service";
import type {
  AmendAssessmentInput,
  CreateAssessmentInput,
  CreateGoalInput,
  CreateHourEntryInput,
  CreateInterventionInput,
  CreateSupervisoryVisitInput,
  CreateVolunteerAssignmentInput,
  CreateVolunteerGateInput,
  FinalizeVersionInput,
  M15WriteService,
  OutboxEmission,
  RevokeVolunteerGateInput,
  SignAssessmentInput,
  SignSupervisoryVisitInput,
  SignVersionInput,
  UpdateGoalInput,
  UpdateInterventionInput,
  UpdateVolunteerAssignmentInput,
  UpdateVolunteerGateInput,
  VolunteerHourEntryView,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Deps the composition root binds (outbox publisher + clock; the consent probe is seam-resolved). */
export interface M15WriteDeps {
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => IsoInstant;
  /** §2.3 — is an active `dpoa_healthcare` consent on file for this patient (the agent-stated goal gate)? */
  readonly dpoaConsentActive?: (input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
  }) => Promise<boolean>;
}

export function buildDrizzleM15WriteService(
  db: DbClient,
  deps: M15WriteDeps = {},
): M15WriteService {
  const P = schema.disciplineCarePlan;
  const V = schema.disciplineCarePlanVersion;
  const SIG = schema.disciplineCarePlanSignature;
  const G = schema.disciplineGoal;
  const I = schema.disciplineIntervention;
  const A = schema.disciplineAssessment;
  const SV = schema.aideSupervisoryVisit;
  const VA = schema.volunteerAssignment;
  const GATE = schema.volunteerComplianceGate;
  const LEDGER = schema.volunteerHourLedger;
  const ENTRY = schema.volunteerHourEntry;

  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  // §2.3 — the agent-stated-goal gate resolves M39 the same way the §7.8 disclosure port does: lazily,
  // per call, and fail-CLOSED (an unbound or erroring evaluator refuses the goal rather than attributing
  // it to an agent nobody authorized).
  const dpoaActive = deps.dpoaConsentActive ?? dpoaViaSeam;

  const scope = (actor: M15WriteActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

  /** Load the plan aggregate root, or 404 (an absent/cross-tenant plan is invisible under RLS). */
  async function planOr404(tx: Tx, planId: string): Promise<typeof P.$inferSelect> {
    const [row] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
    if (!row) throw new NotFoundError("discipline plan not found");
    return row;
  }

  /** §2.5 — bump a row's optimistic-concurrency `version` after the guard passed. */
  const nextVersion = (current: number): number => current + 1;

  const emit = async (tx: Tx, emission: OutboxEmission): Promise<void> => {
    await outbox.publish(tx, emission);
  };

  const toGoal = (r: typeof G.$inferSelect): DisciplineGoalView => ({
    goalId: r.id,
    parentProblemId: r.parentProblemId ?? null,
    parentGoalId: r.parentGoalId ?? null,
    source: r.source,
    status: r.status,
    originalText: r.originalText,
    revisedText: r.revisedText ?? null,
    measurableOutcome: r.measurableOutcome ?? null,
    targetAt: isoN(r.targetAt),
    frequencyText: r.frequencyText ?? null,
    frequencyValue: r.frequencyValue ?? null,
    modalityText: r.modalityText ?? null,
    sudRelated: r.sudRelated,
    addedByDiscipline: r.addedByDiscipline,
    addedAt: iso(r.addedAt),
    version: r.version,
  });

  const toIntervention = (r: typeof I.$inferSelect): DisciplineInterventionView => ({
    interventionId: r.id,
    parentInterventionId: r.parentInterventionId ?? null,
    goalRefs: strArray(r.goalRefs),
    scopeText: r.scopeText,
    frequencyText: r.frequencyText,
    frequencyValue: r.frequencyValue,
    discipline: r.discipline,
    responsibleRoles: strArray(r.responsibleRoles),
    status: r.status,
    discontinuationReason: r.discontinuationReason ?? null,
    addedByDiscipline: r.addedByDiscipline,
    addedAt: iso(r.addedAt),
    version: r.version,
  });

  const toAssessment = (r: typeof A.$inferSelect): DisciplineAssessmentView => ({
    assessmentId: r.id,
    kind: r.kind,
    status: r.status,
    capturedAt: iso(r.capturedAt),
    isInitial: r.isInitial,
    sudFlag: r.sudFlag,
    familyViolenceFlag: r.familyViolenceFlag,
    sourceEncounterId: r.sourceEncounterId ?? null,
    data: r.data,
    amendsAssessmentId: r.amendsAssessmentId ?? null,
    amendmentReason: r.amendmentReason ?? null,
    capturedByMembershipId: r.capturedByMembershipId,
    signedAt: isoN(r.signedAt),
    signedByMembershipId: r.signedByMembershipId ?? null,
    version: r.version,
  });

  const toSupervisoryVisit = (r: typeof SV.$inferSelect): AideSupervisoryVisitView => ({
    supervisoryVisitId: r.id,
    aideMembershipId: r.aideMembershipId,
    supervisingRnMembershipId: r.supervisingRnMembershipId,
    sourceEncounterId: r.sourceEncounterId ?? null,
    supervisoryAt: iso(r.supervisoryAt),
    attestationMode: r.attestationMode,
    aidePerformanceSatisfactory: r.aidePerformanceSatisfactory,
    correctiveActions: r.correctiveActions ?? null,
    supervisoryNarrative: r.supervisoryNarrative,
    nextDueAt: iso(r.nextDueAt),
    cadenceDaysAtInsert: r.cadenceDaysAtInsert,
    signedAt: isoN(r.signedAt),
    version: r.version,
  });

  const toAssignment = (r: typeof VA.$inferSelect): VolunteerAssignmentView => ({
    assignmentId: r.id,
    volunteerMembershipId: r.volunteerMembershipId,
    coordinatorMembershipId: r.coordinatorMembershipId,
    activities: strArray(r.activities),
    startsAt: iso(r.startsAt),
    endsAt: isoN(r.endsAt),
    coordinatorAcknowledgedAt: isoN(r.coordinatorAcknowledgedAt),
    inactivatedAt: isoN(r.inactivatedAt),
    inactivationReason: r.inactivationReason ?? null,
    version: r.version,
  });

  const toGateFacts = (r: typeof GATE.$inferSelect): VolunteerGateFacts => ({
    gateId: r.id,
    volunteerMembershipId: r.volunteerMembershipId as MembershipId,
    gateKind: r.gateKind,
    status: r.status,
    validFrom: iso(r.validFrom) as IsoInstant,
    validUntil: isoN(r.validUntil) as IsoInstant | null,
    revokedAt: isoN(r.revokedAt) as IsoInstant | null,
  });

  const toGateView = (r: typeof GATE.$inferSelect): VolunteerComplianceGateView => ({
    gateId: r.id,
    volunteerMembershipId: r.volunteerMembershipId,
    gateKind: r.gateKind,
    storedStatus: r.status,
    effectiveStatus: deriveGateStatus(toGateFacts(r), now()),
    validFrom: iso(r.validFrom),
    validUntil: isoN(r.validUntil),
    revokedAt: isoN(r.revokedAt),
    sourceDocumentId: r.sourceDocumentId ?? null,
    version: r.version,
  });

  const toVersionDetail = (
    r: typeof V.$inferSelect,
    signatures: (typeof SIG.$inferSelect)[],
  ): DisciplinePlanVersionDetail => ({
    versionId: r.id,
    planId: r.planId,
    sequence: r.sequence,
    status: r.status,
    kind: r.kind,
    idgMeetingId: r.idgMeetingId ?? null,
    finalizedAt: isoN(r.finalizedAt),
    signedAt: isoN(r.signedAt),
    supersededAt: isoN(r.supersededAt),
    version: r.version,
    stateSnapshot: r.stateSnapshot,
    requiredSignerSet: r.requiredSignerSet,
    signatures: signatures.map((s) => ({
      signatureId: s.id,
      signerMembershipId: s.signerMembershipId,
      signerRole: s.signerRole,
      isAcknowledgment: s.isAcknowledgment,
      signedAt: iso(s.signedAt),
    })),
  });

  /** The tenancy columns every child row inherits from the plan root (M15-F05 denormalization). */
  const inherit = (plan: typeof P.$inferSelect) => ({
    organizationId: plan.organizationId,
    providerEntityId: plan.providerEntityId,
    locationId: plan.locationId,
  });

  return {
    // ── 6 — finalize (`draft → in_review`; seals the snapshot + the D11 quorum) ──────────────────────
    async finalizeVersion(actor, planId, versionId, input: FinalizeVersionInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [version] = await tx
          .select()
          .from(V)
          .where(and(eq(V.id, versionId), eq(V.planId, planId)))
          .limit(1);
        if (!version) throw new NotFoundError("plan version not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, version.version);
        }

        // §2.3 readiness facts, resolved from the aggregate (the pure machine decides over them).
        const activeAssignments = await tx
          .select()
          .from(VA)
          .where(and(eq(VA.planId, planId), isNull(VA.inactivatedAt)));
        const goals = await tx.select().from(G).where(eq(G.planId, planId));
        const interventions = await tx.select().from(I).where(eq(I.planId, planId));
        const acknowledged = strArray(
          ((version.stateSnapshot ?? {}) as { volunteerOutOfScopeAcknowledged?: unknown })
            .volunteerOutOfScopeAcknowledged,
        );

        const transition = transitionDisciplinePlanVersion(
          version.status as "draft" | "in_review" | "signed" | "superseded",
          {
            type: "finalize",
            planKind: plan.kind as DisciplinePlanKind,
            versionKind: version.kind as never,
            at: now(),
            readiness: {
              hasAideAssigned: plan.aideMembershipId !== null,
              hasSupervisingRn: plan.supervisingRnMembershipId !== null,
              hasActiveVolunteerAssignment: activeAssignments.length > 0,
              volunteerOutOfScopeAcknowledged: acknowledged,
            },
            requiredSignerSet: input.requiredSignerSet as DisciplineRequiredSignerSet | undefined,
          },
        );
        const sealedSet =
          (input.requiredSignerSet as DisciplineRequiredSignerSet | undefined) ??
          resolveRequiredSignerSet(plan.kind as DisciplinePlanKind, version.kind as never);

        // §2.2.2 — the snapshot is SEALED here: the working goal/intervention rows as they stand now.
        const snapshot = {
          sealedAt: now(),
          planKind: plan.kind,
          versionKind: version.kind,
          volunteerOutOfScopeAcknowledged: acknowledged,
          goals: goals.map(toGoal),
          interventions: interventions.map(toIntervention),
        };
        const [updated] = await tx
          .update(V)
          .set({
            status: transition.to as typeof V.$inferSelect.status,
            stateSnapshot: snapshot,
            requiredSignerSet: sealedSet,
            finalizedAt: new Date(now()),
            updatedAt: new Date(now()),
            version: nextVersion(version.version),
          })
          .where(and(eq(V.id, versionId), eq(V.version, version.version)))
          .returning();
        if (!updated)
          throw new DisciplinePlanStateError("STALE_VERSION", "the version changed concurrently");
        return toVersionDetail(updated, []);
      });
    },

    // ── 7 — sign one slot of the SEALED quorum (step-up route) ───────────────────────────────────────
    async signVersion(actor, planId, versionId, input: SignVersionInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [version] = await tx
          .select()
          .from(V)
          .where(and(eq(V.id, versionId), eq(V.planId, planId)))
          .limit(1);
        if (!version) throw new NotFoundError("plan version not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, version.version);
        }
        const collected = await tx
          .select()
          .from(SIG)
          .where(eq(SIG.versionId, versionId))
          .orderBy(asc(SIG.signedAt));
        const sealedSet = (version.requiredSignerSet ?? []) as DisciplineRequiredSignerSet;

        // The pure machine validates the slot (SIGNER_ROLE_MISMATCH / DUPLICATE_SIGNER_ROLE) and reports
        // whether this signature completes the quorum; the transition below applies its effects.
        const decision = decideRecordSignature(
          sealedSet,
          collected.map((s) => s.signerRole as DisciplineSignerRole),
          input.signerRole as DisciplineSignerRole,
        );
        const transition = transitionDisciplinePlanVersion(
          version.status as "draft" | "in_review" | "signed" | "superseded",
          {
            type: "recordSignature",
            signerRole: input.signerRole as DisciplineSignerRole,
            alreadySigned: collected.map((s) => s.signerRole as DisciplineSignerRole),
            requiredSignerSet: sealedSet,
            signedAt: now(),
          },
        );

        await tx.insert(SIG).values({
          ...inherit(plan),
          versionId,
          // The signer is the SERVER-assembled acting membership — never a body field (§8.6 spoofing).
          signerMembershipId: actor.membershipId,
          signerRole: input.signerRole,
          isAcknowledgment: input.isAcknowledgment ?? decision.isAcknowledgment,
          signedAt: new Date(now()),
          attestationText: input.attestationText,
          sessionClass: actor.sessionClass,
        });

        const quorumMet = transition.to === "signed";
        const [updated] = await tx
          .update(V)
          .set({
            status: transition.to as typeof V.$inferSelect.status,
            signedAt: quorumMet ? new Date(now()) : version.signedAt,
            updatedAt: new Date(now()),
            version: nextVersion(version.version),
          })
          .where(and(eq(V.id, versionId), eq(V.version, version.version)))
          .returning();
        if (!updated)
          throw new DisciplinePlanStateError("STALE_VERSION", "the version changed concurrently");

        const signatures = await tx
          .select()
          .from(SIG)
          .where(eq(SIG.versionId, versionId))
          .orderBy(asc(SIG.signedAt));

        if (quorumMet) {
          // §2.2.1 — the first signed version promotes the plan root to `active`; a revision keeps it.
          if (plan.status === "draft" || plan.status === "draft_revising") {
            await tx
              .update(P)
              .set({
                status: "active",
                updatedAt: new Date(now()),
                version: nextVersion(plan.version),
                // §7.1 — the Aide POC's 14-day supervisory clock ARMS at the first signature.
                nextSupervisoryDueAt:
                  plan.kind === "aide_poc" && plan.nextSupervisoryDueAt === null
                    ? new Date(
                        computeNextSupervisoryDueAt(
                          now(),
                          plan.supervisoryCadenceDaysOverride ?? null,
                        ),
                      )
                    : plan.nextSupervisoryDueAt,
              })
              .where(and(eq(P.id, planId), eq(P.version, plan.version)));
          }
          // §2.4 / D12 — the M22 discipline-plan PDF render handshake + the M28/M14/M30/M33 fan-out.
          await emit(tx, {
            organizationId: actor.organizationId,
            eventName: "m15.plan.version_signed",
            aggregateKind: "discipline_care_plan_version",
            aggregateId: versionId,
            payload: {
              planId,
              versionId,
              // F-166 (#248) — the M22 render-request chart target; already in scope on `plan`.
              patientId: plan.patientId,
              kind: plan.kind,
              versionKind: updated.kind,
              snapshot: updated.stateSnapshot,
              signers: signatures.map((s) => ({
                membershipId: s.signerMembershipId,
                role: s.signerRole,
                signedAt: iso(s.signedAt),
                isAcknowledgment: s.isAcknowledgment,
              })),
            },
          });
        }
        return toVersionDetail(updated, signatures);
      });
    },

    // ── 8 — author a discipline goal (parent IPOC problem + DPOA consent resolved through seams) ─────
    async createGoal(actor, planId, input: CreateGoalInput) {
      const plan = await withOrgContext(db, scope(actor), (tx) => planOr404(tx, planId));
      checkPlanWritable(plan.status);
      checkAuthoringDiscipline(
        plan.kind as DisciplinePlanKind,
        input.addedByDiscipline as DisciplineAuthorRole,
      );
      checkGoalTextVerbatim({
        source: input.source as DisciplineGoalSource,
        originalText: input.originalText,
        isUpdate: false,
        mutatingOriginalText: false,
      });
      // §2.1 / §2.3 — resolved through M7's CarePlanReader; an unbound seam throws and nothing is written.
      await assertParentElements(
        plan.kind as DisciplinePlanKind,
        plan.patientId as never,
        { parentProblemId: input.parentProblemId, parentGoalId: input.parentGoalId },
        true,
      );
      checkDpoaGoalConsent(
        input.source as DisciplineGoalSource,
        input.source === "agent_stated"
          ? await dpoaActive({
              organizationId: actor.organizationId,
              patientId: plan.patientId,
              sessionClass: actor.sessionClass,
            })
          : false,
        input.actingConsentId ?? null,
      );

      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .insert(G)
          .values({
            ...inherit(plan),
            planId,
            parentGoalId: input.parentGoalId ?? null,
            parentProblemId: input.parentProblemId,
            source: input.source as typeof G.$inferInsert.source,
            originalText: input.originalText,
            measurableOutcome: input.measurableOutcome ?? null,
            targetAt: input.targetAt ? new Date(input.targetAt) : null,
            frequencyText: input.frequencyText ?? null,
            frequencyValue: input.frequencyValue ?? null,
            modalityText: input.modalityText ?? null,
            sudRelated: input.sudRelated ?? false,
            actingConsentId: input.actingConsentId ?? null,
            addedByMembershipId: actor.membershipId,
            addedByDiscipline: input.addedByDiscipline,
          })
          .returning();
        if (!row) throw new NotFoundError("discipline goal insert failed");
        return toGoal(row);
      });
    },

    // ── 9 — edit a goal (status transition and/or the §2.3 revision fields) ──────────────────────────
    async updateGoal(actor, planId, goalId, input: UpdateGoalInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [row] = await tx
          .select()
          .from(G)
          .where(and(eq(G.id, goalId), eq(G.planId, planId)))
          .limit(1);
        if (!row) throw new NotFoundError("discipline goal not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }
        // §2.3 — a patient/family/agent-stated goal's original_text is immutable; only revised_text moves.
        checkGoalTextVerbatim({
          source: row.source as DisciplineGoalSource,
          originalText: row.originalText,
          isUpdate: true,
          mutatingOriginalText: false,
        });

        let status = row.status;
        let revisedText = row.revisedText ?? null;
        if (input.event) {
          const transition = transitionDisciplineGoal(
            row.status as never,
            {
              type: input.event.type as never,
              revisedText: input.event.revisedText ?? "",
              reason: input.event.reason ?? "",
            } as never,
          );
          status = transition.to as typeof row.status;
          if (input.event.type === "revise") revisedText = input.event.revisedText ?? revisedText;
        }

        const [updated] = await tx
          .update(G)
          .set({
            status: status as typeof G.$inferSelect.status,
            revisedText,
            measurableOutcome:
              input.measurableOutcome === undefined
                ? row.measurableOutcome
                : input.measurableOutcome,
            targetAt:
              input.targetAt === undefined
                ? row.targetAt
                : input.targetAt === null
                  ? null
                  : new Date(input.targetAt),
            frequencyText:
              input.frequencyText === undefined ? row.frequencyText : input.frequencyText,
            frequencyValue:
              input.frequencyValue === undefined ? row.frequencyValue : input.frequencyValue,
            modalityText: input.modalityText === undefined ? row.modalityText : input.modalityText,
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(G.id, goalId), eq(G.version, row.version)))
          .returning();
        if (!updated)
          throw new DisciplinePlanStateError("STALE_VERSION", "the goal changed concurrently");
        return toGoal(updated);
      });
    },

    // ── 10 — author a discipline intervention ────────────────────────────────────────────────────────
    async createIntervention(actor, planId, input: CreateInterventionInput) {
      const plan = await withOrgContext(db, scope(actor), (tx) => planOr404(tx, planId));
      checkPlanWritable(plan.status);
      checkAuthoringDiscipline(
        plan.kind as DisciplinePlanKind,
        input.addedByDiscipline as DisciplineAuthorRole,
      );
      checkInterventionFrequency(input.frequencyValue);
      await assertParentElements(
        plan.kind as DisciplinePlanKind,
        plan.patientId as never,
        { parentInterventionId: input.parentInterventionId },
        false,
      );
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .insert(I)
          .values({
            ...inherit(plan),
            planId,
            parentInterventionId: input.parentInterventionId ?? null,
            goalRefs: [...(input.goalRefs ?? [])],
            scopeText: input.scopeText,
            frequencyText: input.frequencyText,
            frequencyValue: input.frequencyValue,
            discipline: input.discipline,
            responsibleRoles: [...(input.responsibleRoles ?? [])],
            addedByMembershipId: actor.membershipId,
            addedByDiscipline: input.addedByDiscipline,
          })
          .returning();
        if (!row) throw new NotFoundError("discipline intervention insert failed");
        return toIntervention(row);
      });
    },

    // ── 11 — edit an intervention ────────────────────────────────────────────────────────────────────
    async updateIntervention(actor, planId, interventionId, input: UpdateInterventionInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [row] = await tx
          .select()
          .from(I)
          .where(and(eq(I.id, interventionId), eq(I.planId, planId)))
          .limit(1);
        if (!row) throw new NotFoundError("discipline intervention not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }
        if (input.frequencyValue !== undefined) checkInterventionFrequency(input.frequencyValue);

        let status = row.status;
        let discontinuationReason = row.discontinuationReason ?? null;
        if (input.event) {
          const transition = transitionDisciplineIntervention(
            row.status as never,
            {
              type: input.event.type as never,
              reason: input.event.reason ?? "",
            } as never,
          );
          status = transition.to as typeof row.status;
          if (input.event.type === "discontinue") {
            discontinuationReason = input.event.reason ?? discontinuationReason;
          }
        }

        const [updated] = await tx
          .update(I)
          .set({
            status: status as typeof I.$inferSelect.status,
            discontinuationReason,
            scopeText: input.scopeText ?? row.scopeText,
            frequencyText: input.frequencyText ?? row.frequencyText,
            frequencyValue: input.frequencyValue ?? row.frequencyValue,
            responsibleRoles: input.responsibleRoles
              ? [...input.responsibleRoles]
              : (row.responsibleRoles as never),
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(I.id, interventionId), eq(I.version, row.version)))
          .returning();
        if (!updated) {
          throw new DisciplinePlanStateError(
            "STALE_VERSION",
            "the intervention changed concurrently",
          );
        }
        return toIntervention(updated);
      });
    },

    // ── 12 — capture a discipline assessment (draft) ─────────────────────────────────────────────────
    async createAssessment(actor, planId, input: CreateAssessmentInput) {
      const plan = await withOrgContext(db, scope(actor), (tx) => planOr404(tx, planId));
      checkPlanWritable(plan.status);
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .insert(A)
          .values({
            ...inherit(plan),
            planId,
            kind: input.kind as typeof A.$inferInsert.kind,
            capturedAt: new Date(input.capturedAt),
            isInitial: input.isInitial ?? false,
            sudFlag: input.sudFlag ?? false,
            familyViolenceFlag: input.familyViolenceFlag ?? false,
            sourceEncounterId: input.sourceEncounterId ?? null,
            data: input.data,
            capturedByMembershipId: actor.membershipId,
          })
          .returning();
        if (!row) throw new NotFoundError("discipline assessment insert failed");
        return toAssessment(row);
      });
    },

    // ── 13 — sign an assessment (step-up; a signed INITIAL closes the D10 clock) ─────────────────────
    async signAssessment(actor, planId, assessmentId, input: SignAssessmentInput) {
      const plan = await withOrgContext(db, scope(actor), (tx) => planOr404(tx, planId));
      checkPlanWritable(plan.status);
      const existing = await withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(A)
          .where(and(eq(A.id, assessmentId), eq(A.planId, planId)))
          .limit(1);
        return row ?? null;
      });
      if (!existing) throw new NotFoundError("discipline assessment not found");
      if (input.expectedVersion !== null) {
        checkOptimisticConcurrency(input.expectedVersion, existing.version);
      }
      // §2.3 — the referenced encounter must be a signed M8 encounter on this patient (seam-resolved).
      const encounterValid =
        existing.sourceEncounterId === null
          ? null
          : await isAssessmentEncounterValid({
              orgId: actor.organizationId,
              patientId: plan.patientId as never,
              encounterId: existing.sourceEncounterId as never,
              capturedAt: iso(existing.capturedAt) as IsoInstant,
            });
      const transition = transitionDisciplineAssessment(existing.status as never, {
        type: "sign",
        at: now(),
        isInitial: existing.isInitial,
        kind: existing.kind as DisciplineAssessmentKind,
        sourceEncounterValid: encounterValid,
      });

      return withOrgContext(db, scope(actor), async (tx) => {
        const [updated] = await tx
          .update(A)
          .set({
            status: transition.to as typeof A.$inferSelect.status,
            signedAt: new Date(now()),
            signedByMembershipId: actor.membershipId,
            updatedAt: new Date(now()),
            version: nextVersion(existing.version),
          })
          .where(and(eq(A.id, assessmentId), eq(A.version, existing.version)))
          .returning();
        if (!updated) {
          throw new DisciplinePlanStateError(
            "STALE_VERSION",
            "the assessment changed concurrently",
          );
        }
        // §7.2 / §7.3 — a signed INITIAL assessment is what satisfies the D10 5-day clock on the plan.
        if (existing.isInitial && plan.initialAssessmentSignedAt === null) {
          await tx
            .update(P)
            .set({
              initialAssessmentSignedAt: new Date(now()),
              updatedAt: new Date(now()),
              version: nextVersion(plan.version),
            })
            .where(and(eq(P.id, planId), eq(P.version, plan.version)));
        }
        return toAssessment(updated);
      });
    },

    // ── 14 — amend a signed assessment (append-only correction of record, M9 D9) ─────────────────────
    async amendAssessment(actor, planId, assessmentId, input: AmendAssessmentInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [original] = await tx
          .select()
          .from(A)
          .where(and(eq(A.id, assessmentId), eq(A.planId, planId)))
          .limit(1);
        if (!original) throw new NotFoundError("discipline assessment not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, original.version);
        }
        if (original.status !== "signed" && original.status !== "amended") {
          throw new DisciplinePlanStateError(
            "AMENDMENT_TARGET_NOT_SIGNED",
            "only a signed assessment may be amended",
          );
        }
        // The machine validates the reason floor and declares the m15.discipline_assessment.amended event.
        transitionDisciplineAssessment(original.status as never, {
          type: "amend",
          reason: input.amendmentReason,
          at: now(),
        });

        // Append-only: the signed row is NEVER rewritten — the amendment is a NEW row pointing at it.
        const [amendment] = await tx
          .insert(A)
          .values({
            ...inherit(plan),
            planId,
            kind: original.kind,
            status: "signed",
            capturedAt: new Date(now()),
            isInitial: false,
            sudFlag: original.sudFlag,
            familyViolenceFlag: original.familyViolenceFlag,
            sourceEncounterId: original.sourceEncounterId,
            data: input.data,
            amendsAssessmentId: original.id,
            amendmentReason: input.amendmentReason,
            capturedByMembershipId: actor.membershipId,
            signedAt: new Date(now()),
            signedByMembershipId: actor.membershipId,
          })
          .returning();
        if (!amendment) throw new NotFoundError("assessment amendment insert failed");
        await tx
          .update(A)
          .set({
            status: "amended",
            updatedAt: new Date(now()),
            version: nextVersion(original.version),
          })
          .where(and(eq(A.id, assessmentId), eq(A.version, original.version)));

        await emit(tx, {
          organizationId: actor.organizationId,
          eventName: "m15.discipline_assessment.amended",
          aggregateKind: "discipline_assessment",
          aggregateId: amendment.id,
          payload: {
            planId,
            assessmentId: amendment.id,
            kind: amendment.kind,
            amendedFields: [...(input.amendedFields ?? [])],
            // The attestation names WHO amended and WHEN — never the amendment narrative (§8.1).
            attestation: `amended_by:${actor.membershipId}`,
          },
        });
        return toAssessment(amendment);
      });
    },

    // ── 15 — record a 418.76(h) supervisory attestation ──────────────────────────────────────────────
    async createSupervisoryVisit(actor, planId, input: CreateSupervisoryVisitInput) {
      const plan = await withOrgContext(db, scope(actor), (tx) => planOr404(tx, planId));
      checkPlanWritable(plan.status);
      // §2.3 — the referenced encounter must be the SUPERVISING RN's own signed visit on this patient.
      const encounterValid =
        input.sourceEncounterId === null
          ? false
          : await isSupervisoryEncounterValid({
              orgId: actor.organizationId,
              patientId: plan.patientId as never,
              encounterId: input.sourceEncounterId as never,
              supervisingRnMembershipId: input.supervisingRnMembershipId as MembershipId,
              supervisoryAt: input.supervisoryAt as IsoInstant,
            });

      const decision = decideRecordSupervisoryVisit({
        planStatus: plan.status,
        planAideMembershipId: plan.aideMembershipId as MembershipId | null,
        planSupervisingRnMembershipId: plan.supervisingRnMembershipId as MembershipId | null,
        aideMembershipId: input.aideMembershipId as MembershipId,
        supervisingRnMembershipId: input.supervisingRnMembershipId as MembershipId,
        sourceEncounterId: input.sourceEncounterId,
        sourceEncounterValid: encounterValid,
        supervisoryAt: input.supervisoryAt as IsoInstant,
        attestationMode: input.attestationMode as never,
        aidePerformanceSatisfactory: input.aidePerformanceSatisfactory,
        correctiveActions: input.correctiveActions,
        cadenceDaysOverride: plan.supervisoryCadenceDaysOverride ?? null,
      });

      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .insert(SV)
          .values({
            ...inherit(plan),
            planId,
            aideMembershipId: input.aideMembershipId,
            supervisingRnMembershipId: input.supervisingRnMembershipId,
            sourceEncounterId: input.sourceEncounterId,
            supervisoryAt: new Date(input.supervisoryAt),
            attestationMode: input.attestationMode as typeof SV.$inferInsert.attestationMode,
            aidePerformanceSatisfactory: input.aidePerformanceSatisfactory,
            correctiveActions: input.correctiveActions,
            supervisoryNarrative: input.supervisoryNarrative,
            nextDueAt: new Date(decision.nextDueAt),
            cadenceDaysAtInsert: decision.cadenceDaysAtInsert,
            capturedByMembershipId: actor.membershipId,
          })
          .returning();
        if (!row) throw new NotFoundError("supervisory visit insert failed");

        // §2.2.4 D3 — a documented PHONE-only supervision does NOT re-arm the 14-day clock.
        if (decision.advancesClock) {
          await tx
            .update(P)
            .set({
              nextSupervisoryDueAt: new Date(decision.nextDueAt),
              updatedAt: new Date(now()),
              version: nextVersion(plan.version),
            })
            .where(and(eq(P.id, planId), eq(P.version, plan.version)));
        }
        await emit(tx, {
          organizationId: actor.organizationId,
          eventName: "m15.aide_supervisory.completed",
          aggregateKind: "aide_supervisory_visit",
          aggregateId: row.id,
          payload: {
            planId,
            supervisoryVisitId: row.id,
            aideMembershipId: row.aideMembershipId,
            supervisingRnMembershipId: row.supervisingRnMembershipId,
            attestationMode: row.attestationMode,
            performanceSatisfactory: row.aidePerformanceSatisfactory,
            nextDueAt: iso(row.nextDueAt),
          },
        });
        return toSupervisoryVisit(row);
      });
    },

    // ── 16 — sign a supervisory attestation (step-up) ────────────────────────────────────────────────
    async signSupervisoryVisit(actor, planId, visitId, input: SignSupervisoryVisitInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        await planOr404(tx, planId);
        const [row] = await tx
          .select()
          .from(SV)
          .where(and(eq(SV.id, visitId), eq(SV.planId, planId)))
          .limit(1);
        if (!row) throw new NotFoundError("supervisory visit not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }
        if (row.signedAt !== null) {
          throw new DisciplinePlanStateError(
            "ILLEGAL_TRANSITION",
            "this supervisory attestation is already signed",
          );
        }
        const [updated] = await tx
          .update(SV)
          .set({
            signedAt: new Date(now()),
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(SV.id, visitId), eq(SV.version, row.version)))
          .returning();
        if (!updated) {
          throw new DisciplinePlanStateError(
            "STALE_VERSION",
            "the attestation changed concurrently",
          );
        }
        return toSupervisoryVisit(updated);
      });
    },

    // ── 17 — create a volunteer assignment (the §7.4 418.78 gate check decides first) ────────────────
    async createVolunteerAssignment(actor, planId, input: CreateVolunteerAssignmentInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        let gates: readonly VolunteerGateFacts[] | null = null;
        try {
          const rows = await tx
            .select()
            .from(GATE)
            .where(eq(GATE.volunteerMembershipId, input.volunteerMembershipId));
          gates = rows.map(toGateFacts);
        } catch {
          gates = null; // §8.7 — an unreadable gate store DENIES the booking.
        }
        const decision = decideCreateVolunteerAssignment(
          {
            planId: planId as never,
            planKind: plan.kind as DisciplinePlanKind,
            volunteerMembershipId: input.volunteerMembershipId as MembershipId,
            coordinatorMembershipId: actor.membershipId as MembershipId,
            gates,
            override: input.overrideReason ? { reason: input.overrideReason } : undefined,
          },
          now(),
        );

        const [row] = await tx
          .insert(VA)
          .values({
            ...inherit(plan),
            planId,
            volunteerMembershipId: input.volunteerMembershipId,
            coordinatorMembershipId: actor.membershipId,
            activities: [...input.activities],
            startsAt: new Date(input.startsAt),
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
          })
          .returning();
        if (!row) throw new NotFoundError("volunteer assignment insert failed");
        // §8.6 — a documented override is a survey artifact: it rides the audit trail (the M4 trigger on
        // this insert) plus the failing-gate list the coordinator knowingly accepted.
        if (decision.overridden) {
          await emit(tx, {
            organizationId: actor.organizationId,
            eventName: "m15.volunteer.assignment_inactivated",
            aggregateKind: "volunteer_assignment",
            aggregateId: row.id,
            payload: {
              volunteerMembershipId: input.volunteerMembershipId,
              affectedPlanIds: [planId],
              reason: `gate_override:${decision.failingGates.join("|")}`,
            },
          });
        }
        return toAssignment(row);
      });
    },

    // ── 18 — edit / inactivate / reactivate a volunteer assignment ───────────────────────────────────
    async updateVolunteerAssignment(
      actor,
      planId,
      assignmentId,
      input: UpdateVolunteerAssignmentInput,
    ) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkPlanWritable(plan.status);
        const [row] = await tx
          .select()
          .from(VA)
          .where(and(eq(VA.id, assignmentId), eq(VA.planId, planId)))
          .limit(1);
        if (!row) throw new NotFoundError("volunteer assignment not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }

        let inactivatedAt = row.inactivatedAt;
        let inactivationReason = row.inactivationReason ?? null;
        let coordinatorAcknowledgedAt = row.coordinatorAcknowledgedAt;

        if (input.reactivate === true) {
          const gateRows = await tx
            .select()
            .from(GATE)
            .where(eq(GATE.volunteerMembershipId, row.volunteerMembershipId));
          // §7.5 — a renewal alone does NOT bring the assignment back; the coordinator re-acknowledges
          // and the volunteer must clear every gate at that moment.
          decideReactivateAssignment({
            assignment: {
              assignmentId: row.id as never,
              planId: row.planId as never,
              volunteerMembershipId: row.volunteerMembershipId as MembershipId,
              inactivatedAt: isoN(row.inactivatedAt) as IsoInstant | null,
            },
            gates: gateRows.map(toGateFacts),
            coordinatorAcknowledged: input.coordinatorAcknowledged === true,
            now: now(),
          });
          inactivatedAt = null;
          inactivationReason = null;
          coordinatorAcknowledgedAt = new Date(now());
        } else if (input.inactivate) {
          inactivatedAt = new Date(now());
          inactivationReason = input.inactivate.reason;
        } else if (input.coordinatorAcknowledged === true) {
          coordinatorAcknowledgedAt = new Date(now());
        }

        const [updated] = await tx
          .update(VA)
          .set({
            activities: input.activities ? [...input.activities] : (row.activities as never),
            endsAt:
              input.endsAt === undefined
                ? row.endsAt
                : input.endsAt === null
                  ? null
                  : new Date(input.endsAt),
            coordinatorAcknowledgedAt,
            inactivatedAt,
            inactivationReason,
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(VA.id, assignmentId), eq(VA.version, row.version)))
          .returning();
        if (!updated) {
          throw new DisciplinePlanStateError(
            "STALE_VERSION",
            "the assignment changed concurrently",
          );
        }
        if (input.inactivate) {
          await emit(tx, {
            organizationId: actor.organizationId,
            eventName: "m15.volunteer.assignment_inactivated",
            aggregateKind: "volunteer_assignment",
            aggregateId: updated.id,
            payload: {
              volunteerMembershipId: updated.volunteerMembershipId,
              affectedPlanIds: [planId],
              reason: input.inactivate.reason,
            },
          });
        }
        return toAssignment(updated);
      });
    },

    // ── 20 — record a 418.78 compliance gate ─────────────────────────────────────────────────────────
    async createVolunteerGate(actor, input: CreateVolunteerGateInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const existing = await tx
          .select()
          .from(GATE)
          .where(eq(GATE.volunteerMembershipId, input.volunteerMembershipId));
        const decision = decideRecordGate(
          {
            volunteerMembershipId: input.volunteerMembershipId as MembershipId,
            gateKind: input.gateKind as VolunteerGateKind,
            validFrom: input.validFrom as IsoInstant,
            validUntil: (input.validUntil ?? null) as IsoInstant | null,
            existingGates: existing.map(toGateFacts),
          },
          now(),
        );
        const [row] = await tx
          .insert(GATE)
          .values({
            organizationId: actor.organizationId,
            volunteerMembershipId: input.volunteerMembershipId,
            gateKind: input.gateKind as typeof GATE.$inferInsert.gateKind,
            status: decision.status as typeof GATE.$inferInsert.status,
            validFrom: new Date(input.validFrom),
            validUntil: input.validUntil ? new Date(input.validUntil) : null,
            sourceDocumentId: input.sourceDocumentId ?? null,
            recordedByMembershipId: actor.membershipId,
            notes: input.notes ?? null,
          })
          .returning();
        if (!row) throw new NotFoundError("volunteer compliance gate insert failed");
        return toGateView(row);
      });
    },

    // ── 21 — correct a recorded gate's window / evidence ─────────────────────────────────────────────
    async updateVolunteerGate(actor, gateId, input: UpdateVolunteerGateInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx.select().from(GATE).where(eq(GATE.id, gateId)).limit(1);
        if (!row) throw new NotFoundError("volunteer compliance gate not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }
        const validUntil =
          input.validUntil === undefined
            ? row.validUntil
            : input.validUntil === null
              ? null
              : new Date(input.validUntil);
        // Re-derive the materialized status over the CORRECTED window, so a shortened window flips the
        // gate immediately rather than waiting for the nightly watcher (§2.2.6).
        const status = deriveGateStatus(
          { ...toGateFacts(row), validUntil: (validUntil ? iso(validUntil) : null) as never },
          now(),
        );
        const [updated] = await tx
          .update(GATE)
          .set({
            validUntil,
            status: status as typeof GATE.$inferSelect.status,
            sourceDocumentId:
              input.sourceDocumentId === undefined ? row.sourceDocumentId : input.sourceDocumentId,
            notes: input.notes === undefined ? row.notes : input.notes,
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(GATE.id, gateId), eq(GATE.version, row.version)))
          .returning();
        if (!updated)
          throw new DisciplinePlanStateError("STALE_VERSION", "the gate changed concurrently");
        return toGateView(updated);
      });
    },

    // ── 22 — revoke a satisfied gate (deliberate act; §7.5 cascade over the open assignments) ────────
    async revokeVolunteerGate(actor, gateId, input: RevokeVolunteerGateInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx.select().from(GATE).where(eq(GATE.id, gateId)).limit(1);
        if (!row) throw new NotFoundError("volunteer compliance gate not found");
        if (input.expectedVersion !== null) {
          checkOptimisticConcurrency(input.expectedVersion, row.version);
        }
        decideRevokeGate(toGateFacts(row), input.revokedReason, now());

        const [updated] = await tx
          .update(GATE)
          .set({
            status: "revoked",
            revokedAt: new Date(now()),
            revokedReason: input.revokedReason,
            updatedAt: new Date(now()),
            version: nextVersion(row.version),
          })
          .where(and(eq(GATE.id, gateId), eq(GATE.version, row.version)))
          .returning();
        if (!updated)
          throw new DisciplinePlanStateError("STALE_VERSION", "the gate changed concurrently");

        // §7.5 — a revocation removes the volunteer's clearance, so their OPEN assignments close with the
        // gate-attributed reason and M17 is told to drop them from the schedule.
        const open = await tx
          .select()
          .from(VA)
          .where(
            and(eq(VA.volunteerMembershipId, row.volunteerMembershipId), isNull(VA.inactivatedAt)),
          );
        if (open.length > 0) {
          const reason = `gate_revoked:${row.gateKind}`;
          await tx
            .update(VA)
            .set({
              inactivatedAt: new Date(now()),
              inactivationReason: reason,
              updatedAt: new Date(now()),
              version: sql`${VA.version} + 1`,
            })
            .where(
              and(
                eq(VA.volunteerMembershipId, row.volunteerMembershipId),
                isNull(VA.inactivatedAt),
              ),
            );
          await emit(tx, {
            organizationId: actor.organizationId,
            eventName: "m15.volunteer.assignment_inactivated",
            aggregateKind: "volunteer_compliance_gate",
            aggregateId: updated.id,
            payload: {
              volunteerMembershipId: updated.volunteerMembershipId,
              affectedPlanIds: [...new Set(open.map((a) => a.planId))],
              reason,
            },
          });
        }
        return toGateView(updated);
      });
    },

    // ── 24 — a manual hour adjustment on the 418.78(e) ledger ────────────────────────────────────────
    async createHourEntry(actor, input: CreateHourEntryInput) {
      checkVolunteerHourEntry({
        volunteerMembershipId: input.volunteerMembershipId as MembershipId,
        source: "manual_adjustment",
        durationMinutes: input.durationMinutes,
        occurredAt: input.occurredAt as IsoInstant,
        sourceEncounterId: null,
        adjustmentReason: input.adjustmentReason,
        adjustedByMembershipId: actor.membershipId as MembershipId,
      });
      return withOrgContext(db, scope(actor), async (tx) => {
        const [ledger] = await tx
          .insert(LEDGER)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: input.providerEntityId,
            fiscalYear: input.fiscalYear,
            totalVolunteerHourMinutes: 0,
          })
          .onConflictDoNothing()
          .returning();
        const resolved =
          ledger ??
          (
            await tx
              .select()
              .from(LEDGER)
              .where(
                and(
                  eq(LEDGER.providerEntityId, input.providerEntityId),
                  eq(LEDGER.fiscalYear, input.fiscalYear),
                ),
              )
              .limit(1)
          )[0];
        if (!resolved) throw new NotFoundError("volunteer hour ledger not found");

        const [entry] = await tx
          .insert(ENTRY)
          .values({
            organizationId: actor.organizationId,
            ledgerId: resolved.id,
            sourceEncounterId: null,
            volunteerMembershipId: input.volunteerMembershipId,
            source: "manual_adjustment",
            durationMinutes: input.durationMinutes,
            occurredAt: new Date(input.occurredAt),
            adjustmentReason: input.adjustmentReason,
            adjustedByMembershipId: actor.membershipId,
          })
          .returning();
        if (!entry) throw new NotFoundError("volunteer hour entry insert failed");

        const [ledgerAfter] = await tx
          .update(LEDGER)
          .set({
            totalVolunteerHourMinutes: sql`${LEDGER.totalVolunteerHourMinutes} + ${input.durationMinutes}`,
            asOfAt: new Date(now()),
            updatedAt: new Date(now()),
            version: sql`${LEDGER.version} + 1`,
          })
          .where(eq(LEDGER.id, resolved.id))
          .returning();

        const view: VolunteerHourEntryView = {
          hourEntryId: entry.id,
          ledgerId: resolved.id,
          volunteerMembershipId: entry.volunteerMembershipId,
          source: entry.source,
          durationMinutes: entry.durationMinutes,
          occurredAt: iso(entry.occurredAt),
          ledgerTotalMinutes:
            ledgerAfter?.totalVolunteerHourMinutes ??
            resolved.totalVolunteerHourMinutes + input.durationMinutes,
        };
        return view;
      });
    },
  };
}

/** The M39 `dpoa_healthcare` verdict (§2.3) — lazy `getSeam`, fail-CLOSED on an unbound/erroring seam. */
async function dpoaViaSeam(input: {
  organizationId: string;
  patientId: string;
  sessionClass: string;
}): Promise<boolean> {
  try {
    const evaluator = getSeam("ConsentEvaluator") as {
      evaluate(args: {
        organizationId: string;
        patientId: string;
        consentType: string;
        sessionContext: { sessionClass: string };
        callerModule: string;
      }): Promise<{ allowed: boolean }>;
    };
    const verdict = await evaluator.evaluate({
      organizationId: input.organizationId,
      patientId: input.patientId,
      consentType: "dpoa_healthcare",
      sessionContext: { sessionClass: input.sessionClass },
      callerModule: "m15",
    });
    return verdict.allowed === true;
  } catch {
    return false;
  }
}
