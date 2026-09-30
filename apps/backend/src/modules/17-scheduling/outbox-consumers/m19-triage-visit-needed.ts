// apps/backend/src/modules/17-scheduling/outbox-consumers/m19-triage-visit-needed.ts — the §2.2.4 D5
// after-hours-triage proposal source (F-166, #248).
//
// F-133/F-152 (#248) scoped this pair blocked on three concrete gaps, each re-checked directly against
// the current schema/code before this build, not re-asserted:
//
//   1. `visit_proposal_source` had no member for M19 — migration 0258 adds `triage_dispatch_m19`,
//      additive-only, the `document_aggregate_type`/migration-0239 precedent.
//   2. `visit_proposal`'s `admissionId`/`providerEntityId`/`locationId` are all NOT NULL and the
//      catalogued payload carries only a nullable `patientId` — resolved via a NEW, narrow M6 seam,
//      `activeAdmissionSitingForPatientForOrg` (`06-admission/seams/drizzle-store.ts`), deliberately NOT
//      the existing `activeAdmissionDraftContextForPatient` M11/M12 already use: that function THROWS
//      when no attending/admitting physician is on file (correct for an M11/M12 clinical order, which
//      needs an ordering physician), which would make a triage-driven visit proposal fail on a fact it
//      never reads. The new function answers the narrower "where does this admission live" question and
//      returns `null` (never throws) when the active admission is genuinely unsited.
//   3. M17's manifest `dependsOn` excludes 6 (Admission) — irrelevant to whether this binds: the
//      established org-explicit `...ForOrg` seam-function pattern (M13's draft-order consumer,
//      F-162; M14's since-last-IDG cache, F-164) injects the OWNING module's seam as a PORT with a
//      locally-declared structural type here, never a cross-module import — `arch:tables`/
//      `arch:boundaries` legal without a `dependsOn` edge.
//
// DISCRIMINATOR WIDENING: the payload's own non-null fields cannot tell `visit_dispatched_now` apart from
// `pronouncement_scheduled` — both set `requestedArrivalBy` and leave `proposedForDate` null. Matching on
// `reason`'s free text would be fragile (a hardcoded string comparison against prose meant for humans), so
// `visitKind` is a new, honest payload field (`events-by-m19.ts`, `packages/types/src/oncall.ts`,
// `write-service-drizzle.ts`'s `dispositionPayloads`) carrying the fact M19 already has at the emit site
// rather than a fact this consumer would have to guess.
//
// VISIT PURPOSE MAPPING: `dispatch_now`/`first_light` → `prn` (an unscheduled, as-needed visit driven by a
// triage call — the closest fit in `visitPurpose`'s real vocabulary, which has no "triage dispatch" value
// of its own); `pronouncement` → `pronouncement` (the enum's own dedicated value, used correctly now that
// the discriminator resolves it rather than being conflated with the other two).
//
// A NULL `patientId` (a call with no linked patient) or a missing `requestedDiscipline` is a genuine no-op,
// never a thrown/DLQ'd delivery: neither is fabricatable, and both are legitimate real-world states (a
// collateral/informational call carries no patient; `requestedDiscipline` is required by
// `TriageDispositionData`'s type but the catalog schema is defensively nullable).
//
// IDEMPOTENT BY CONSTRUCTION: `sourceIdempotencyKey` is the delivered outbox event's own id — `visit_
// proposal`'s own schema header states "one proposal per source event" — enforced by the real
// `vp_idempotency_uidx` unique index via `.onConflictDoNothing()` (the `generateCarePlanVisitProposals`
// precedent), so a redelivery (retry or at-least-once re-delivery) inserts nothing a second time and emits
// no second `m17.visit.proposed`.
import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { withOrgContext } from "@wardenx/tenancy";

const VP = schema.visitProposal;

/** M6's org-explicit "active admission siting for patient" seam, injected as a port — `arch:tables`
 *  (F-166, #248): M17's manifest carries no `dependsOn` edge to 6, so this file must not import M6's
 *  schema or even a TYPE from its `seams/` directory directly; the port shape is declared structurally
 *  here, the `m16-bereavement-plan-opened.ts` (M31) precedent. */
export interface TriageVisitAdmissionSiting {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
}

export type TriageVisitAdmissionSitingReader = (
  db: DbClient,
  organizationId: string,
  patientId: string,
) => Promise<TriageVisitAdmissionSiting | null>;

export interface M19TriageVisitNeededOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export const M17_TRIAGE_VISIT_NEEDED_CONSUMER = {
  eventName: "m19.triage_call.visit_needed",
  consumerName: "m17.m19-triage-visit-needed",
} as const;

export interface TriageVisitNeededConsumerDeps {
  readonly db: DbClient;
  readonly outbox: M19TriageVisitNeededOutboxPort;
  readonly admissionSitingForPatient: TriageVisitAdmissionSitingReader;
}

interface TriageVisitNeededFacts {
  readonly triageCallId: string;
  readonly patientId: string | null;
  readonly requestedDiscipline: string | null;
  readonly requestedArrivalBy: string | null;
  readonly proposedForDate: string | null;
  readonly reason: string | null;
  readonly visitKind: "dispatch_now" | "first_light" | "pronouncement";
}

function factsOf(payload: unknown): TriageVisitNeededFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const triageCallId = p.triageCallId;
  if (typeof triageCallId !== "string" || triageCallId.length === 0) {
    throw new Error(`${M17_TRIAGE_VISIT_NEEDED_CONSUMER.consumerName}: payload has no triageCallId`);
  }
  const visitKind = p.visitKind;
  if (
    visitKind !== "dispatch_now" &&
    visitKind !== "first_light" &&
    visitKind !== "pronouncement"
  ) {
    throw new Error(`${M17_TRIAGE_VISIT_NEEDED_CONSUMER.consumerName}: payload has no valid visitKind`);
  }
  const strOrNull = (key: string): string | null => {
    const value = p[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  return {
    triageCallId,
    patientId: strOrNull("patientId"),
    requestedDiscipline: strOrNull("requestedDiscipline"),
    requestedArrivalBy: strOrNull("requestedArrivalBy"),
    proposedForDate: strOrNull("proposedForDate"),
    reason: strOrNull("reason"),
    visitKind,
  };
}

/**
 * M17's live `m19.triage_call.visit_needed` binding — seeds a §2.2.4 `visit_proposal` (source
 * `triage_dispatch_m19`) for the scheduler's inbox, from an after-hours disposition that decided a visit
 * is required. Never auto-publishes or auto-assigns: like every other proposal source, the scheduler picks
 * a clinician and publishes through the ordinary D8-gated route — this consumer only ever gets the request
 * onto the inbox.
 */
export function buildM17TriageVisitNeededConsumer(deps: TriageVisitNeededConsumerDeps) {
  return {
    consumerName: M17_TRIAGE_VISIT_NEEDED_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_TRIAGE_VISIT_NEEDED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // Neither a missing patient nor a missing discipline is fabricatable — both are legitimate no-ops.
      if (!facts.patientId || !facts.requestedDiscipline) return;
      const patientId = facts.patientId;
      const requestedDiscipline = facts.requestedDiscipline;

      const siting = await deps.admissionSitingForPatient(deps.db, organizationId, patientId);
      if (!siting) return; // no active, sited admission to hang the proposal on — a real, honest no-op

      const proposedVisitPurpose = facts.visitKind === "pronouncement" ? "pronouncement" : "prn";

      // `proposed_for_date` is NOT NULL. `first_light` carries a real target date; the other two carry
      // an arrival INSTANT (dated by its own local day) or, absent even that, the call's own moment.
      const timezone = await organizationTimezone(deps.db, organizationId);
      const proposedForDate =
        facts.visitKind === "first_light" && facts.proposedForDate
          ? facts.proposedForDate
          : localDateInTimeZone(
              new Date(facts.requestedArrivalBy ?? Date.now()),
              timezone,
            );

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const inserted = await tx
          .insert(VP)
          .values({
            organizationId,
            providerEntityId: siting.providerEntityId,
            locationId: siting.locationId,
            patientId,
            admissionId: siting.admissionId,
            source: "triage_dispatch_m19",
            sourcePayload: {
              triageCallId: facts.triageCallId,
              visitKind: facts.visitKind,
              requestedArrivalBy: facts.requestedArrivalBy,
              reason: facts.reason,
            },
            sourceIdempotencyKey: event.id,
            proposedForDate,
            proposedVisitPurpose,
            proposedDiscipline: requestedDiscipline,
            proposedDurationMinutes: 60,
            status: "pending",
          })
          .onConflictDoNothing({
            target: [VP.organizationId, VP.source, VP.sourceIdempotencyKey],
          })
          .returning({ id: VP.id });

        const proposal = inserted[0];
        if (!proposal) return; // already created by a prior delivery of this exact event

        await deps.outbox.publish(tx, {
          eventName: "m17.visit.proposed",
          organizationId,
          aggregateKind: "visit_proposal",
          aggregateId: proposal.id,
          payload: {
            proposalId: proposal.id,
            patientId,
            admissionId: siting.admissionId,
            source: "triage_dispatch_m19",
            proposedForDate,
            proposedVisitPurpose,
            proposedDiscipline: requestedDiscipline,
          },
        });
      });
    },
  };
}
