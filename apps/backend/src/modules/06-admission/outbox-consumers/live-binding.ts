import { type AuditContext, audit } from "@wardenx/audit";
// apps/backend/src/modules/06-admission/outbox-consumers/live-binding.ts — the REAL
// `m6.admission-event-applier` outbox consumer (§4.8.3, W-M6-31..35). Composes the pure decision core
// ({@link decideAdmissionEvent}) with a Drizzle execution gateway: facts are resolved from M6's OWN
// tables under an explicit `withOrgContext` (a consumer runs OUTSIDE a request scope — event org +
// `userId: ""`), and each returned {@link ApplierAction} executes through M6's existing service layer
// (`createDbAdmissionRouteService(...).discharge` drives the §2.3.1 death cascade — the state machines
// stay the ONLY path to active-state mutations; the applier never re-implements a transition).
//
// IDEMPOTENCY (W-M6-35). `ApplierFacts.alreadyProcessed` is resolved from DURABLE, proposal-keyed
// markers on M6's own rows — each written ATOMICALLY with the apply it marks, so a re-delivered event
// (crash before finalize, or a sibling consumer's failure retrying the whole event) converges to
// `idempotent_skip` instead of double-applying:
//   · open_window   → the `compliance_window.payload->>'proposalId'` the window insert carries;
//   · external death → the `[m29 proposal <id>]` marker inside the discharge_event narrative
//     (written by the SAME `service.discharge` tx that moves the admission);
//   · withdrawal    → `referral.external_message_ref->>'proposalId'` set by the withdraw UPDATE.
// Refusals / idempotent skips leave only append-only records (audit row + info event) — re-executing
// them on a re-delivery is harmless by construction, so they carry no marker.
//
// REFUSALS are SUCCESS to the dispatcher: the event was handled and the refusal (audit
// `m6.applier.contract_violation_refused` + the `m6.applier.refused` emit, same tx) is the durable
// answer. Only infrastructure/state errors throw (→ retry → DLQ, visible and replayable).
//
// KNOWN SEAM (documented, not hidden): the death path runs TWO transactions — `service.discharge`
// opens its own `withOrgContext` tx (state transition + LOC/EP cascade + discharge_event row + the
// idempotency marker, atomic), then a second tx publishes the catalog-CONFORMANT events + the
// `m6.applier.processed` audit row. The service's own state-machine emissions are captured and
// re-published conformantly because `runEffects` emits `{ aggregateId }`-only payloads that the
// strict catalog publisher (Value.Check) would reject — and `m6.discharge.death` needs the
// dischargeEventId that only exists AFTER the service returns. A crash between the two txs loses the
// emissions but never the discharge; the replay lands on the marker and skips.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  ActiveElectionPeriod,
  AdmissionSummary,
  LevelOfCare,
  LocalDate,
} from "@wardenx/types";
import { and, desc, eq, inArray, isNotNull, like, ne, sql } from "drizzle-orm";
import {
  type AdmissionWriteOutboxPort,
  createDbAdmissionRouteService,
} from "../admission-route-service-db";
import type {
  ApplierAction,
  ApplierFacts,
  ProposalAcceptedPayload,
  ProposalResourceKind,
} from "../consumers/admission-event-applier";
import { decideAdmissionEvent } from "../consumers/admission-event-applier";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const LOC = schema.levelOfCarePeriods;
const REF = schema.referrals;
const DE = schema.dischargeEvents;
const CW = schema.complianceWindows;

/** External-signal (D15, severity `info`) windows give human triage 48h before overdue escalation. */
const EXTERNAL_SIGNAL_WINDOW_HOURS = 48;

/** Consumer-scope actor: no acting user (audit trigger maps `""` → NULL actor). */
const APPLIER_SYSTEM_USER_ID = "";

/** The durable death-path idempotency marker embedded in the discharge narrative (W-M6-35). */
export function m29ProposalMarker(proposalId: string): string {
  return `[m29 proposal ${proposalId}]`;
}

/** The discharge narrative the applier records (≥10 chars — passes the §6.3 death narrative gate). */
export function externalDeathNarrative(proposalId: string, sendingFacility: string): string {
  return `External death notification from ${sendingFacility} via HL7 ADT ${m29ProposalMarker(proposalId)}`;
}

/** {@link ApplierFacts} plus the admission the execution layer anchors compliance windows on
 *  (`compliance_window.admission_id` is NOT NULL): the matched patient's newest admission (any
 *  status), or null when the patient has none — an unanchorable window becomes a refusal. */
export interface ResolvedApplierFacts extends ApplierFacts {
  readonly anchorAdmissionId: string | null;
}

type DeathAction = Extract<ApplierAction, { kind: "record_external_death" }>;
type WithdrawAction = Extract<ApplierAction, { kind: "withdraw_referral" }>;
type WindowAction = Extract<ApplierAction, { kind: "open_window" }>;

/**
 * The applier's execution port: facts resolution + one transactional unit per {@link ApplierAction}
 * arm. Production = {@link createDrizzleM6ApplierGateway}; unit tests inject an in-memory fake.
 */
export interface M6ApplierGateway {
  resolveFacts(
    organizationId: string,
    payload: ProposalAcceptedPayload,
  ): Promise<ResolvedApplierFacts>;
  /** §2.4.1 R-EXT-01 — the narrow D14 happy path through `service.discharge` (death cascade). */
  recordExternalDeath(
    organizationId: string,
    payload: ProposalAcceptedPayload,
    action: DeathAction,
  ): Promise<void>;
  /** `markWithdrawnFromHl7` — status guard `IN ('received','evaluated')` backstops the accept race. */
  withdrawReferral(
    organizationId: string,
    payload: ProposalAcceptedPayload,
    action: WithdrawAction,
  ): Promise<void>;
  /** Open (or merge into) the informational compliance window + `m6.compliance.window.opened`. */
  openWindow(
    organizationId: string,
    payload: ProposalAcceptedPayload,
    anchorAdmissionId: string,
    action: WindowAction,
  ): Promise<void>;
  /** Audit `m6.applier.idempotent_skip` (W-M6-35 replay). */
  recordIdempotentSkip(organizationId: string, payload: ProposalAcceptedPayload): Promise<void>;
  /** Audit `m6.applier.contract_violation_refused` + emit `m6.applier.refused` (same tx). */
  recordRefusal(
    organizationId: string,
    payload: ProposalAcceptedPayload,
    reason: string,
  ): Promise<void>;
}

/** The applier's audit envelope: an integration actor executing a reviewer's accept decision. The
 *  membership id is context (audit_event.actor_user_id FKs `users`, not memberships). */
function auditCtx(organizationId: string, payload: ProposalAcceptedPayload): AuditContext {
  return {
    organizationId,
    userId: null,
    actorKind: "integration",
    correlationId: `m29-proposal:${payload.proposalId}`,
  };
}

/** Build the production Drizzle-backed {@link M6ApplierGateway} over `(db, m6 outbox publisher)`. */
export function createDrizzleM6ApplierGateway(
  db: DbClient,
  outbox: AdmissionWriteOutboxPort,
): M6ApplierGateway {
  const now = () => new Date();

  return {
    async resolveFacts(organizationId, payload) {
      return withOrgContext(
        db,
        { organizationId, userId: APPLIER_SYSTEM_USER_ID },
        async (tx): Promise<ResolvedApplierFacts> => {
          const proposalId = payload.proposalId;

          // ── alreadyProcessed: any of the three durable proposal-keyed markers (header). ──────────
          const [cwMark] = await tx
            .select({ id: CW.id })
            .from(CW)
            .where(sql`${CW.payload} ->> 'proposalId' = ${proposalId}`)
            .limit(1);
          const [deMark] = await tx
            .select({ id: DE.id })
            .from(DE)
            .where(like(DE.narrative, `%${m29ProposalMarker(proposalId)}%`))
            .limit(1);
          const [refMark] = await tx
            .select({ id: REF.id })
            .from(REF)
            .where(
              and(
                eq(REF.status, "withdrawn"),
                sql`${REF.externalMessageRef} ->> 'proposalId' = ${proposalId}`,
              ),
            )
            .limit(1);
          const alreadyProcessed = Boolean(cwMark ?? deMark ?? refMark);

          // ── the matched patient's newest admission (the getPatientElectionCertification pick). ────
          let admissionSummary: AdmissionSummary | null = null;
          let anchorAdmissionId: string | null = null;
          let activePeriodOnDeathDate: ActiveElectionPeriod | null = null;
          if (payload.matchedPatientId) {
            const [adm] = await tx
              .select({
                id: ADM.id,
                patientId: ADM.patientId,
                organizationId: ADM.organizationId,
                providerEntityId: ADM.providerEntityId,
                locationId: ADM.locationId,
                status: ADM.status,
                admissionAt: ADM.admissionAt,
                activatedAt: ADM.activatedAt,
                dischargedAt: ADM.dischargedAt,
                createdAt: ADM.createdAt,
              })
              .from(ADM)
              .where(eq(ADM.patientId, payload.matchedPatientId))
              .orderBy(desc(ADM.admissionAt), desc(ADM.createdAt))
              .limit(1);
            if (adm) {
              anchorAdmissionId = adm.id;
              // LENIENT projection (unlike the seam store): the decider reads ONLY status/dischargedAt/
              // admissionId — a draft-shaped row must still be able to fail preconditions into a
              // triage window rather than dead-letter the death notice on a projection gap.
              const admissionAt = adm.admissionAt ?? adm.activatedAt ?? adm.createdAt;
              admissionSummary = {
                admissionId: adm.id,
                patientId: adm.patientId,
                organizationId: adm.organizationId,
                providerEntityId: adm.providerEntityId,
                locationId: adm.locationId,
                status: adm.status,
                admissionAt: admissionAt.toISOString().slice(0, 10),
                activatedAt: adm.activatedAt ? adm.activatedAt.toISOString().slice(0, 10) : null,
                dischargedAt: adm.dischargedAt ? adm.dischargedAt.toISOString().slice(0, 10) : null,
                currentElectionPeriodId: null,
                currentLevelOfCare: null,
              } as AdmissionSummary;
            }

            // ── the election period covering the death date (the findActivePeriodForPatient rule). ──
            const deathDate = payload.proposedEventContext?.eventTimestamp?.slice(0, 10);
            if (deathDate && payload.resourceKind === "discharge_event") {
              const periods = await tx
                .select({
                  id: EP.id,
                  admissionId: EP.admissionId,
                  sequenceNumber: EP.sequenceNumber,
                  effectiveAt: EP.effectiveAt,
                  scheduledEndAt: EP.scheduledEndAt,
                  actualEndAt: EP.actualEndAt,
                })
                .from(EP)
                .innerJoin(ADM, eq(EP.admissionId, ADM.id))
                .where(
                  and(
                    eq(ADM.patientId, payload.matchedPatientId),
                    isNotNull(EP.effectiveAt),
                    isNotNull(EP.scheduledEndAt),
                  ),
                );
              const covering = periods
                .filter((p) => {
                  const start = p.effectiveAt as string;
                  const end = (p.actualEndAt ?? p.scheduledEndAt) as string;
                  return start <= deathDate && deathDate <= end;
                })
                .sort((a, b) => Number(b.sequenceNumber) - Number(a.sequenceNumber))[0];
              if (covering) {
                // Current LOC (open period, else latest by effective_at) — the decider never reads
                // it (containment only); the RHC fallback is type-satisfaction, not a clinical fact.
                const locRows = await tx
                  .select({ levelOfCare: LOC.levelOfCare, endedAt: LOC.endedAt })
                  .from(LOC)
                  .where(eq(LOC.admissionId, covering.admissionId))
                  .orderBy(LOC.effectiveAt);
                const loc: LevelOfCare =
                  locRows.find((r) => r.endedAt === null)?.levelOfCare ??
                  locRows.at(-1)?.levelOfCare ??
                  "routine_home_care";
                activePeriodOnDeathDate = {
                  periodId: covering.id,
                  sequence: Number(covering.sequenceNumber),
                  levelOfCare: loc,
                  startDate: covering.effectiveAt as string,
                  endDate: (covering.actualEndAt ?? covering.scheduledEndAt) as string,
                } as ActiveElectionPeriod;
              }
            }
          }

          // ── pending referral matched on the cancel-admit's referenced control id. ─────────────────
          let pendingReferralId: string | null = null;
          const controlId = payload.proposedEventContext?.messageControlId;
          if (payload.resourceKind === "cancel_admission" && controlId) {
            const [ref] = await tx
              .select({ id: REF.id })
              .from(REF)
              .where(
                and(
                  inArray(REF.status, ["received", "under_review", "pending_information", "qualified"]),
                  sql`${REF.externalMessageRef} ->> 'messageControlId' = ${controlId}`,
                ),
              )
              .limit(1);
            pendingReferralId = ref?.id ?? null;
          }

          return {
            alreadyProcessed,
            admissionSummary,
            activePeriodOnDeathDate,
            pendingReferralId,
            anchorAdmissionId,
          };
        },
      );
    },

    async recordExternalDeath(organizationId, payload, action) {
      // Tx 1 — the standard §2.3.1 death cascade through the service layer (state machine + LOC/EP
      // cascades + the discharge_event row whose narrative carries the idempotency marker). The
      // state-machine emissions are CAPTURED (not published): their `{ aggregateId }` payloads would
      // fail the catalog publisher's Value.Check and roll the death back (see header).
      const captured: string[] = [];
      const capture: AdmissionWriteOutboxPort = {
        async publish(_tx, emission) {
          captured.push(emission.eventName);
        },
      };
      const service = createDbAdmissionRouteService(db, capture);
      const result = await service.discharge(
        organizationId,
        action.admissionId,
        {
          reason: "death",
          dischargeDate: action.dischargeDate,
          narrative: externalDeathNarrative(payload.proposalId, action.sendingFacility),
        },
        payload.decidedByMembershipId,
      );

      // Tx 2 — catalog-conformant emissions for what the machine fired + the processed audit row.
      await withOrgContext(db, { organizationId, userId: APPLIER_SYSTEM_USER_ID }, async (tx) => {
        if (captured.includes("m6.admission.discharged")) {
          await outbox.publish(tx, {
            eventName: "m6.admission.discharged",
            payload: {
              admissionId: action.admissionId,
              reason: "death",
              dischargeDate: action.dischargeDate,
            },
            organizationId,
            aggregateKind: "admission",
            aggregateId: action.admissionId,
          });
        }
        if (captured.includes("m6.discharge.death")) {
          await outbox.publish(tx, {
            eventName: "m6.discharge.death",
            payload: {
              dischargeEventId: result.id,
              admissionId: action.admissionId,
              dischargeDate: action.dischargeDate,
              source: "m29_proposal_accept",
            },
            organizationId,
            aggregateKind: "discharge_event",
            aggregateId: result.id,
          });
        }
        if (captured.includes("m6.bereavement.eligible") && payload.matchedPatientId) {
          await outbox.publish(tx, {
            eventName: "m6.bereavement.eligible",
            payload: {
              admissionId: action.admissionId,
              patientId: payload.matchedPatientId,
              eligibleAt: action.dischargeDate,
            },
            organizationId,
            aggregateKind: "admission",
            aggregateId: action.admissionId,
          });
        }
        await audit(tx, auditCtx(organizationId, payload), {
          eventType: "m6.applier.processed",
          resourceKind: "hl7_inbound_proposal",
          resourceId: payload.proposalId,
          outcome: "success",
          context: {
            proposalId: payload.proposalId,
            resourceKind: payload.resourceKind,
            outcome: action.outcome,
            admissionId: action.admissionId,
            dischargeEventId: result.id,
            decidedByMembershipId: payload.decidedByMembershipId,
          },
        });
      });
    },

    async withdrawReferral(organizationId, payload, action) {
      await withOrgContext(db, { organizationId, userId: APPLIER_SYSTEM_USER_ID }, async (tx) => {
        // Guarded UPDATE — only a still-pending referral withdraws (the accept race backstop the
        // decision core documents). The external_message_ref merge preserves the ingest provenance
        // and adds THIS proposal's id as the durable idempotency marker.
        const [existing] = await tx
          .select({ receivedAt: REF.receivedAt, externalMessageRef: REF.externalMessageRef })
          .from(REF)
          .where(and(eq(REF.id, action.referralId), inArray(REF.status, ["received", "under_review", "pending_information", "qualified"])))
          .limit(1);
        const at = now();
        if (!existing) {
          // Race lost between facts and execute (accepted/declined meanwhile) — durable answer is
          // the audit row; a re-delivery re-resolves facts and converges on the no-referral window.
          await audit(tx, auditCtx(organizationId, payload), {
            eventType: "m6.applier.processed",
            resourceKind: "hl7_inbound_proposal",
            resourceId: payload.proposalId,
            outcome: "success",
            context: {
              proposalId: payload.proposalId,
              resourceKind: payload.resourceKind,
              outcome: "cancel_admit_no_matching_referral",
              referralId: action.referralId,
              raceLost: true,
            },
          });
          return;
        }
        await tx
          .update(REF)
          .set({
            status: "withdrawn",
            decidedAt: at,
            updatedAt: at,
            version: sql`${REF.version} + 1`,
            externalMessageRef: {
              ...(existing.externalMessageRef ?? {}),
              source: "m29",
              proposalId: payload.proposalId,
              messageControlId: payload.proposedEventContext?.messageControlId ?? "",
              sendingFacility: action.sendingFacility,
            },
          })
          .where(
            and(eq(REF.id, action.referralId), inArray(REF.status, ["received", "under_review", "pending_information", "qualified"])),
          );
        await outbox.publish(tx, {
          eventName: "m6.referral.withdrawn",
          payload: {
            referralId: action.referralId,
            organizationId,
            withdrawnVia: action.withdrawnVia,
            originalReferralReceivedAt: existing.receivedAt.toISOString(),
            withdrawnAt: at.toISOString(),
          },
          organizationId,
          aggregateKind: "referral",
          aggregateId: action.referralId,
        });
        await audit(tx, auditCtx(organizationId, payload), {
          eventType: "m6.applier.processed",
          resourceKind: "hl7_inbound_proposal",
          resourceId: payload.proposalId,
          outcome: "success",
          context: {
            proposalId: payload.proposalId,
            resourceKind: payload.resourceKind,
            outcome: action.outcome,
            referralId: action.referralId,
            withdrawnVia: action.withdrawnVia,
          },
        });
      });
    },

    async openWindow(organizationId, payload, anchorAdmissionId, action) {
      await withOrgContext(db, { organizationId, userId: APPLIER_SYSTEM_USER_ID }, async (tx) => {
        const { window, outcome } = action;
        // The partial unique `cw_adm_kind_open_idx` admits ONE open window per (admission, kind): a
        // second signal of the same kind merges into the already-open triage window (audited, no
        // duplicate insert → no constraint blow-up → no spurious DLQ).
        const [open] = await tx
          .select({ id: CW.id })
          .from(CW)
          .where(
            and(
              eq(CW.admissionId, anchorAdmissionId),
              eq(CW.windowKind, window.type),
              ne(CW.status, "closed"),
            ),
          )
          .limit(1);
        if (open) {
          await audit(tx, auditCtx(organizationId, payload), {
            eventType: "m6.applier.processed",
            resourceKind: "hl7_inbound_proposal",
            resourceId: payload.proposalId,
            outcome: "success",
            context: {
              proposalId: payload.proposalId,
              resourceKind: payload.resourceKind,
              outcome,
              mergedIntoComplianceWindowId: open.id,
              windowType: window.type,
            },
          });
          return;
        }
        const at = now();
        const mustCompleteBy = new Date(at.getTime() + EXTERNAL_SIGNAL_WINDOW_HOURS * 3600_000);
        const [row] = await tx
          .insert(CW)
          .values({
            organizationId,
            admissionId: anchorAdmissionId,
            windowKind: window.type,
            severity: window.severity,
            autoAcknowledge: window.autoAcknowledge,
            payload: { ...window.payload, patientId: window.patientId },
            startsAt: at,
            mustCompleteBy,
          })
          .returning({ id: CW.id });
        if (!row)
          throw new Error("m6.admission-event-applier: compliance window insert returned no row");
        await outbox.publish(tx, {
          eventName: "m6.compliance.window.opened",
          payload: {
            complianceWindowId: row.id,
            admissionId: anchorAdmissionId,
            windowType: window.type,
            dueAt: mustCompleteBy.toISOString(),
            severity: window.severity,
            source: "m29_proposal_accept",
          },
          organizationId,
          aggregateKind: "compliance_window",
          aggregateId: row.id,
        });
        await audit(tx, auditCtx(organizationId, payload), {
          eventType: "m6.applier.processed",
          resourceKind: "hl7_inbound_proposal",
          resourceId: payload.proposalId,
          outcome: "success",
          context: {
            proposalId: payload.proposalId,
            resourceKind: payload.resourceKind,
            outcome,
            complianceWindowId: row.id,
            windowType: window.type,
          },
        });
      });
    },

    async recordIdempotentSkip(organizationId, payload) {
      await withOrgContext(db, { organizationId, userId: APPLIER_SYSTEM_USER_ID }, async (tx) => {
        await audit(tx, auditCtx(organizationId, payload), {
          eventType: "m6.applier.idempotent_skip",
          resourceKind: "hl7_inbound_proposal",
          resourceId: payload.proposalId,
          outcome: "success",
          context: { proposalId: payload.proposalId, resourceKind: payload.resourceKind },
        });
      });
    },

    async recordRefusal(organizationId, payload, reason) {
      await withOrgContext(db, { organizationId, userId: APPLIER_SYSTEM_USER_ID }, async (tx) => {
        const refusedAt = now().toISOString();
        await audit(tx, auditCtx(organizationId, payload), {
          eventType: "m6.applier.contract_violation_refused",
          resourceKind: "hl7_inbound_proposal",
          resourceId: payload.proposalId,
          outcome: "denied",
          context: { proposalId: payload.proposalId, resourceKind: payload.resourceKind, reason },
        });
        await outbox.publish(tx, {
          eventName: "m6.applier.refused",
          payload: { proposalId: payload.proposalId, organizationId, reason, refusedAt },
          organizationId,
          aggregateKind: "hl7_inbound_proposal",
          aggregateId: payload.proposalId,
        });
      });
    },
  };
}

// ── the dispatcher binding ────────────────────────────────────────────────────────────────────────────

/** Structural binding (matches the dispatcher's OutboxConsumerBinding without importing it). */
export interface M6AdmissionEventApplierBinding {
  readonly consumerName: "m6.admission-event-applier";
  readonly consumerModule: "m6";
  readonly eventTypes: readonly ["m29.hl7_inbound_proposal.accepted"];
  handle(event: { readonly payload: unknown; readonly organizationId: string }): Promise<void>;
}

/** What the composition root constructs: `{ db: dbHandle.db, outbox: m6OutboxPublisher }` (the same
 *  `bindCallerModule(txOutboxPublisher, "m6")` port `mountAdmissionRoutes` receives). A pre-built
 *  gateway may substitute both (tests). */
export type M6ApplierDeps =
  | {
      readonly db: DbClient;
      readonly outbox: AdmissionWriteOutboxPort;
      readonly gateway?: M6ApplierGateway;
    }
  | { readonly gateway: M6ApplierGateway; readonly db?: undefined; readonly outbox?: undefined };

const RESOURCE_KINDS: readonly ProposalResourceKind[] = [
  "patient_demographic_update",
  "new_patient",
  "admission_event",
  "discharge_event",
  "cancel_admission",
];

/** Envelope parse (the M5 posture: a malformed accepted-proposal event is an integration defect to
 *  surface — THROW → retry → DLQ, never drop). Semantic gaps (missing context/patient) are NOT
 *  malformed — the decision core turns them into auditable refusals. */
function parsePayload(raw: unknown, organizationId: string): ProposalAcceptedPayload {
  const p = raw as Partial<ProposalAcceptedPayload> | null;
  if (
    !p ||
    typeof p.proposalId !== "string" ||
    p.proposalId.length === 0 ||
    typeof p.organizationId !== "string" ||
    typeof p.sourceMessageId !== "string" ||
    !RESOURCE_KINDS.includes(p.resourceKind as ProposalResourceKind) ||
    (p.ownerModule !== "m5" && p.ownerModule !== "m6") ||
    typeof p.decidedByMembershipId !== "string" ||
    (p.matchedPatientId !== null && typeof p.matchedPatientId !== "string")
  ) {
    throw new Error(
      `m6.admission-event-applier: malformed m29.hl7_inbound_proposal.accepted payload (proposal ${String(
        p?.proposalId,
      )}) — refusing to guess`,
    );
  }
  const ctx = p.proposedEventContext;
  if (
    ctx !== undefined &&
    (typeof ctx !== "object" ||
      ctx === null ||
      typeof ctx.eventType !== "string" ||
      typeof ctx.eventTimestamp !== "string" ||
      typeof ctx.messageControlId !== "string" ||
      typeof ctx.sendingFacility !== "string")
  ) {
    throw new Error(
      `m6.admission-event-applier: malformed proposedEventContext on proposal ${p.proposalId} — refusing to guess`,
    );
  }
  if (p.organizationId !== organizationId) {
    throw new Error(
      `m6.admission-event-applier: payload org ${p.organizationId} != outbox row org ${organizationId} — refusing a cross-tenant apply`,
    );
  }
  return p as ProposalAcceptedPayload;
}

/**
 * Build the LIVE consumer the composition root registers with the outbox dispatcher. Without deps
 * it preserves the interim fail-visible posture (m6-owned → throw → DLQ) so an unwired boot can
 * never silently complete an accepted external event.
 */
export function buildM6ProposalAcceptedConsumer(
  deps?: M6ApplierDeps,
): M6AdmissionEventApplierBinding {
  const gateway: M6ApplierGateway | null = deps
    ? (deps.gateway ??
      createDrizzleM6ApplierGateway(deps.db as DbClient, deps.outbox as AdmissionWriteOutboxPort))
    : null;
  return {
    consumerName: "m6.admission-event-applier",
    consumerModule: "m6",
    eventTypes: ["m29.hl7_inbound_proposal.accepted"],
    async handle(event) {
      // Owner sniff BEFORE the strict parse (the M5 precedent): m5-owned acceptances are M5's
      // consumer's business — M6 skips everything it does not own without judging its shape.
      const owner = (event.payload as { ownerModule?: unknown } | null)?.ownerModule;
      if (owner !== "m6") return;
      if (!gateway) {
        throw new Error(
          "m6.admission-event-applier: constructed without deps — the §4.8.3 applier cannot execute; dead-lettering so the accepted external event stays visible and replayable",
        );
      }
      const payload = parsePayload(event.payload, event.organizationId);
      const facts = await gateway.resolveFacts(event.organizationId, payload);
      const action = decideAdmissionEvent(payload, facts);
      switch (action.kind) {
        case "ignore":
          return; // no effect, no refusal (decision-core contract)
        case "idempotent_skip":
          return gateway.recordIdempotentSkip(event.organizationId, payload);
        case "refuse":
          return gateway.recordRefusal(event.organizationId, payload, action.reason);
        case "record_external_death":
          return gateway.recordExternalDeath(event.organizationId, payload, action);
        case "withdraw_referral":
          return gateway.withdrawReferral(event.organizationId, payload, action);
        case "open_window": {
          if (!facts.anchorAdmissionId) {
            // compliance_window.admission_id is NOT NULL — a signal with no admission to anchor on
            // cannot open a window; the refusal (audit + emit) is the visible, durable answer.
            return gateway.recordRefusal(
              event.organizationId,
              payload,
              `no_admission_anchor_for_window:${action.window.type}`,
            );
          }
          return gateway.openWindow(event.organizationId, payload, facts.anchorAdmissionId, action);
        }
      }
    },
  };
}
