// apps/backend/src/modules/19-oncall/seams/store-drizzle.ts — M19-T06, the Drizzle-backed
// {@link OncallSeamStore} the five §4.3 published seams read through.
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S
// ambient request context. That is the whole tenancy story: the providers never switch tenants — M14
// asking for a packet slice gets M14's caller's org because RLS scoped the statement, not because this
// file compared anything (the `orgId` seam argument is asserted against the same scope, never used to
// select). Called outside a request scope it THROWS rather than reading unscoped, which is the correct
// direction for a surface that publishes a patient's after-hours clinical record.
//
// NOTHING HERE IS PARTITIONED. `triage_call` and its three children are plain tables (M19-T02's read:
// a partition key inside `triage_call_source_dedupe_uq` would have destroyed the D10 redelivery guard),
// so an id-keyed lookup is a single index probe and the window scans use the §3.4 indexes directly.
//
// NEITHER CIPHER COLUMN IS SELECTED, ANYWHERE IN THIS FILE. `caller_quote_cipher` and
// `transcript_cipher` ride the per-tenant DEK envelope (D14) and the DEK does not leave M19's boundary;
// `caller_phone_e164` and `caller_display_name` are caller identity M14's packet does not need. The one
// free-text column that DOES cross is `chief_complaint_text`, on the packet slice only, because §4.3 is
// explicit that M14 renders it and does its own minimization — and it is absent from the M32 feature DTO
// and the M31 portal projection for exactly the reason it is present here.
//
// ── TWO COLUMNS §4.3 ASSUMES AND §3.3 DOES NOT HAVE ────────────────────────────────────────────────────
//
//  1. `minutesToDisposition` (on the M32 feature DTO) needs a disposition-selected instant. §7.1's prose
//     names a `triage_call.disposition_selected_at` column; §3.3 has no such column and M19-T02 did not
//     invent one. It is derivable and derived HERE, from `triage_call_state_history`: the first
//     transition INTO a post-disposition state. That is the same instant, read off the ledger that
//     already had to record it — strictly better than a denormalized column that a §2.2 transition could
//     forget to stamp.
//  2. `redFlagAnswerCount` counts `triage_call_answer.red_flag_hit` rows, and counts CORRECTIONS as
//     distinct rows on purpose. §2.2.3 is amend-by-append: if a caregiver first said "no suicidal
//     ideation" and the RN corrected it to "yes" a minute later, the call HAD a red flag, and a feature
//     that showed 0 because a later row superseded an earlier one would hide the most clinically
//     significant thing about the call from the risk model.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  IsoInstant,
  MeasureCounts,
  OnCallShiftDto,
  TriageCallAnswerSlice,
  TriageCallDigest,
  TriageCallFeatureDto,
  TriageCallPacketSlice,
  TriageDisposition,
  TriageEscalationSlice,
  TriageEscalationTier,
  TriageMetricsWindow,
  TriageProtocolAnswerType,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type {
  ChiefComplaintTally,
  EscalationTierTally,
  OncallSeamStore,
  PortalTriageCallRow,
  RnCoverageRead,
} from "./store";

type OnCallShiftRow = typeof schema.onCallShift.$inferSelect;

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;
const isoN = (d: Date | string | null): IsoInstant | null => (d === null ? null : iso(d));

/**
 * §2.2.1 — the states a call is in ONCE A DISPOSITION HAS BEEN SELECTED. Derived from the same three
 * branches §3.3's `m19_triage_call_disposition_state` CHECK allows a disposition in, minus `documented`
 * and `closed` (which are reached FROM `documented_pending_encounter`, so the first entry into the set
 * is what dates the selection).
 */
const POST_DISPOSITION_STATES = [
  "documented_pending_encounter",
  "escalated_unresolved",
  "abandoned",
] as const;

/**
 * The D7 ladder order, used ONLY to pick `highestEscalationTier` for the M32 feature DTO.
 *
 * `tier_5_external` ranks last because that is the order §11 D7 declares the ladder in. It is worth being
 * explicit that this is a LADDER POSITION and not a severity claim: a tier-5 vendor handoff is a routing
 * fact, not "worse than" a Compliance Officer page. The model reads the number as ordinal, which is what
 * the declared order gives it.
 */
const TIER_RANK: { readonly [K in TriageEscalationTier]: number } = {
  tier_1_rn_supervisor: 1,
  tier_2_clinical_manager: 2,
  tier_3_medical_director: 3,
  tier_4_compliance_officer: 4,
  tier_5_external: 5,
};

/** §4.3 — the disposition set the hospitalization-avoidance NUMERATOR excludes (the call did not avoid
 *  an acute-care episode). Everything else that reached a disposition counts as avoided. */
const NON_AVOIDANCE_DISPOSITIONS = [
  "ed_transfer_acknowledged",
  "gip_admission_proposed",
] as const satisfies readonly TriageDisposition[];

/** §4.3 — the disposition set that converted the call into a visit. */
const VISIT_CONVERSION_DISPOSITIONS = [
  "visit_dispatched_now",
  "visit_scheduled_first_light",
] as const satisfies readonly TriageDisposition[];

function shiftDtoOf(row: OnCallShiftRow): OnCallShiftDto {
  return {
    shiftId: row.id,
    providerEntityId: row.providerEntityId,
    discipline: row.discipline,
    status: row.status,
    shiftStartsAt: iso(row.shiftStartsAt),
    shiftEndsAt: iso(row.shiftEndsAt),
    primaryOnCallMembershipId: row.primaryOnCallMembershipId,
    backupMembershipId: row.backupMembershipId,
    externalActorId: row.externalActorId,
    externalActorLabel: row.externalActorLabel,
    openedAt: isoN(row.openedAt),
    closedAt: isoN(row.closedAt),
  };
}

/** Build the Drizzle-backed §4.3 store. Every method opens its own org-context transaction. */
export function buildDrizzleOncallSeamStore(db: DbClient): OncallSeamStore {
  const t = schema;

  return {
    async shiftsCoveringForProviderEntity(providerEntityId, asOfIso) {
      const asOf = new Date(asOfIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(t.onCallShift)
          .where(
            and(
              eq(t.onCallShift.providerEntityId, providerEntityId),
              lte(t.onCallShift.shiftStartsAt, asOf),
              sql`${t.onCallShift.shiftEndsAt} > ${asOf}`,
              // `scheduled` is INCLUDED deliberately: §2.2.2's open transition is a cron tick, so a
              // shift whose window has begun but whose tick has not fired is still the nurse the agency
              // expects to answer. `completed` and `cancelled` are excluded — both mean not on call.
              inArray(t.onCallShift.status, ["scheduled", "active"]),
            ),
          )
          // `active` first, then `scheduled` — an explicit CASE rather than ordering on the enum, whose
          // declaration order is an implementation detail of `packages/db/src/enums.ts`.
          .orderBy(
            sql`case when ${t.onCallShift.status} = 'active' then 0 else 1 end`,
            asc(t.onCallShift.shiftStartsAt),
          );
        return rows.map(shiftDtoOf);
      });
    },

    async activeShiftsAt(asOfIso) {
      const asOf = new Date(asOfIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(t.onCallShift)
          .where(
            and(
              eq(t.onCallShift.status, "active"),
              lte(t.onCallShift.shiftStartsAt, asOf),
              sql`${t.onCallShift.shiftEndsAt} > ${asOf}`,
            ),
          )
          .orderBy(asc(t.onCallShift.shiftStartsAt));
        return rows.map(shiftDtoOf);
      });
    },

    async userIdsForMemberships(membershipIds) {
      if (membershipIds.length === 0) return new Map();
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ id: t.memberships.id, userId: t.memberships.userId })
          .from(t.memberships)
          .where(inArray(t.memberships.id, [...membershipIds]));
        return new Map(rows.map((r) => [r.id, r.userId]));
      });
    },

    async callFeaturesForPatientSince(patientId, sinceIso) {
      const since = new Date(sinceIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const calls = await tx
          .select({
            id: t.triageCall.id,
            openedAt: t.triageCall.openedAt,
            source: t.triageCall.source,
            callerKind: t.triageCall.callerKind,
            protocolKey: t.triageProtocol.key,
            chiefComplaintSnomed: t.triageCall.chiefComplaintSnomed,
            disposition: t.triageCall.disposition,
          })
          .from(t.triageCall)
          .leftJoin(t.triageProtocol, eq(t.triageProtocol.id, t.triageCall.selectedProtocolId))
          .where(and(eq(t.triageCall.patientId, patientId), gte(t.triageCall.openedAt, since)))
          .orderBy(desc(t.triageCall.openedAt));
        if (calls.length === 0) return [];
        const callIds = calls.map((c) => c.id);

        const redFlags = await tx
          .select({
            triageCallId: t.triageCallAnswer.triageCallId,
            count: sql<number>`count(*)::int`,
          })
          .from(t.triageCallAnswer)
          .where(
            and(
              inArray(t.triageCallAnswer.triageCallId, callIds),
              eq(t.triageCallAnswer.redFlagHit, true),
            ),
          )
          .groupBy(t.triageCallAnswer.triageCallId);
        const redFlagByCall = new Map(redFlags.map((r) => [r.triageCallId, Number(r.count)]));

        const escalations = await tx
          .select({ triageCallId: t.triageEscalation.triageCallId, tier: t.triageEscalation.tier })
          .from(t.triageEscalation)
          .where(inArray(t.triageEscalation.triageCallId, callIds));
        const tierByCall = new Map<string, TriageEscalationTier>();
        for (const e of escalations) {
          const current = tierByCall.get(e.triageCallId);
          if (current === undefined || TIER_RANK[e.tier] > TIER_RANK[current]) {
            tierByCall.set(e.triageCallId, e.tier);
          }
        }

        // See the header: the disposition instant is read off the state ledger, not a column.
        const dispositionMarks = await tx
          .select({
            triageCallId: t.triageCallStateHistory.triageCallId,
            at: sql<Date>`min(${t.triageCallStateHistory.transitionedAt})`,
          })
          .from(t.triageCallStateHistory)
          .where(
            and(
              inArray(t.triageCallStateHistory.triageCallId, callIds),
              inArray(t.triageCallStateHistory.toState, [...POST_DISPOSITION_STATES]),
            ),
          )
          .groupBy(t.triageCallStateHistory.triageCallId);
        const dispositionAtByCall = new Map(
          dispositionMarks.map((d) => [d.triageCallId, new Date(d.at)]),
        );

        return calls.map((c): TriageCallFeatureDto => {
          const dispositionAt = dispositionAtByCall.get(c.id);
          return {
            triageCallId: c.id,
            openedAt: iso(c.openedAt),
            source: c.source,
            callerKind: c.callerKind,
            selectedProtocolKey: c.protocolKey ?? null,
            chiefComplaintSnomed: c.chiefComplaintSnomed,
            disposition: c.disposition,
            redFlagAnswerCount: redFlagByCall.get(c.id) ?? 0,
            highestEscalationTier: tierByCall.get(c.id) ?? null,
            minutesToDisposition:
              dispositionAt === undefined
                ? null
                : Math.max(
                    0,
                    Math.round(
                      (dispositionAt.getTime() - new Date(c.openedAt).getTime()) / 60_000,
                    ),
                  ),
          };
        });
      });
    },

    async callDigestsForPatientSince(patientId, sinceIso) {
      const since = new Date(sinceIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            id: t.triageCall.id,
            openedAt: t.triageCall.openedAt,
            chiefComplaintLabel: t.triageProtocol.chiefComplaintLabel,
            chiefComplaintSnomed: t.triageCall.chiefComplaintSnomed,
            disposition: t.triageCall.disposition,
            linkedEncounterId: t.triageCall.linkedEncounterId,
            escalationCount: sql<number>`(
              select count(*)::int from ${t.triageEscalation}
              where ${t.triageEscalation.triageCallId} = ${t.triageCall.id}
            )`,
          })
          .from(t.triageCall)
          .leftJoin(t.triageProtocol, eq(t.triageProtocol.id, t.triageCall.selectedProtocolId))
          .where(and(eq(t.triageCall.patientId, patientId), gte(t.triageCall.openedAt, since)))
          .orderBy(desc(t.triageCall.openedAt));
        return rows.map(
          (r): TriageCallDigest => ({
            triageCallId: r.id,
            openedAt: iso(r.openedAt),
            chiefComplaintLabel: r.chiefComplaintLabel ?? null,
            chiefComplaintSnomed: r.chiefComplaintSnomed,
            disposition: r.disposition,
            escalated: Number(r.escalationCount) > 0,
            linkedEncounterId: r.linkedEncounterId,
          }),
        );
      });
    },

    async packetSlice(triageCallId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [call] = await tx
          .select({
            id: t.triageCall.id,
            patientId: t.triageCall.patientId,
            admissionId: t.triageCall.admissionId,
            onCallShiftId: t.triageCall.onCallShiftId,
            state: t.triageCall.state,
            source: t.triageCall.source,
            callerKind: t.triageCall.callerKind,
            callerRelationshipLabel: t.triageCall.callerRelationshipLabel,
            chiefComplaintText: t.triageCall.chiefComplaintText,
            chiefComplaintSnomed: t.triageCall.chiefComplaintSnomed,
            selectedProtocolId: t.triageCall.selectedProtocolId,
            selectedProtocolVersion: t.triageCall.selectedProtocolVersion,
            disposition: t.triageCall.disposition,
            dispositionData: t.triageCall.dispositionData,
            linkedEncounterId: t.triageCall.linkedEncounterId,
            linkedVerbalOrderIds: t.triageCall.linkedVerbalOrderIds,
            linkedVisitProposalId: t.triageCall.linkedVisitProposalId,
            openedAt: t.triageCall.openedAt,
            documentedAt: t.triageCall.documentedAt,
            closedAt: t.triageCall.closedAt,
          })
          .from(t.triageCall)
          .where(eq(t.triageCall.id, triageCallId))
          .limit(1);
        if (call === undefined) return null;

        const answers = await tx
          .select({
            id: t.triageCallAnswer.id,
            questionId: t.triageCallAnswer.triageProtocolQuestionId,
            questionOrder: t.triageProtocolQuestion.questionOrder,
            prompt: t.triageProtocolQuestion.prompt,
            answerType: t.triageProtocolQuestion.answerType,
            answerValueText: t.triageCallAnswer.answerValueText,
            answerValueInt: t.triageCallAnswer.answerValueInt,
            answerValueBool: t.triageCallAnswer.answerValueBool,
            redFlagHit: t.triageCallAnswer.redFlagHit,
            answeredAt: t.triageCallAnswer.answeredAt,
            answeredByMembershipId: t.triageCallAnswer.answeredByMembershipId,
            correctionOfAnswerId: t.triageCallAnswer.correctionOfAnswerId,
          })
          .from(t.triageCallAnswer)
          .innerJoin(
            t.triageProtocolQuestion,
            eq(t.triageProtocolQuestion.id, t.triageCallAnswer.triageProtocolQuestionId),
          )
          .where(eq(t.triageCallAnswer.triageCallId, triageCallId))
          .orderBy(asc(t.triageProtocolQuestion.questionOrder), asc(t.triageCallAnswer.answeredAt));

        const escalations = await tx
          .select()
          .from(t.triageEscalation)
          .where(eq(t.triageEscalation.triageCallId, triageCallId))
          .orderBy(asc(t.triageEscalation.escalatedAt));

        return {
          triageCallId: call.id,
          patientId: call.patientId,
          admissionId: call.admissionId,
          onCallShiftId: call.onCallShiftId,
          state: call.state,
          source: call.source,
          callerKind: call.callerKind,
          callerRelationshipLabel: call.callerRelationshipLabel,
          chiefComplaintText: call.chiefComplaintText,
          chiefComplaintSnomed: call.chiefComplaintSnomed,
          selectedProtocolId: call.selectedProtocolId,
          selectedProtocolVersion: call.selectedProtocolVersion,
          disposition: call.disposition,
          dispositionData: (call.dispositionData ??
            null) as TriageCallPacketSlice["dispositionData"],
          linkedEncounterId: call.linkedEncounterId,
          linkedVerbalOrderIds: Array.isArray(call.linkedVerbalOrderIds)
            ? (call.linkedVerbalOrderIds as string[])
            : [],
          linkedVisitProposalId: call.linkedVisitProposalId,
          openedAt: iso(call.openedAt),
          documentedAt: isoN(call.documentedAt),
          closedAt: isoN(call.closedAt),
          answers: answers.map(
            (a): TriageCallAnswerSlice => ({
              answerId: a.id,
              questionId: a.questionId,
              questionOrder: a.questionOrder,
              prompt: a.prompt,
              answerType: a.answerType as TriageProtocolAnswerType,
              answerValueText: a.answerValueText,
              answerValueInt: a.answerValueInt,
              answerValueBool: a.answerValueBool,
              redFlagHit: a.redFlagHit,
              answeredAt: iso(a.answeredAt),
              answeredByMembershipId: a.answeredByMembershipId,
              correctionOfAnswerId: a.correctionOfAnswerId,
            }),
          ),
          escalations: escalations.map(
            (e): TriageEscalationSlice => ({
              escalationId: e.id,
              tier: e.tier,
              triggerKind: e.triggerKind,
              escalatedAt: iso(e.escalatedAt),
              acknowledgedAt: isoN(e.acknowledgedAt),
              resolvedAt: isoN(e.resolvedAt),
              escalatedToMembershipId: e.escalatedToMembershipId,
              escalatedToExternalActorId: e.escalatedToExternalActorId,
            }),
          ),
        } satisfies TriageCallPacketSlice;
      });
    },

    async triageContextForVerbalOrder(verbalOrderId) {
      return withOrgContextFromRequest(db, async (tx) => {
        // `linked_verbal_order_ids` is a jsonb ARRAY of M11 order ids (§3.3 / D9), so the lookup is a
        // containment test, not an equality. It is the only reverse direction available: M11's order row
        // carries no triage-call column, which is why this seam method exists at all.
        const [row] = await tx
          .select({
            triageCallId: t.triageCall.id,
            onCallShiftId: t.triageCall.onCallShiftId,
          })
          .from(t.triageCall)
          .where(sql`${t.triageCall.linkedVerbalOrderIds} @> ${JSON.stringify([verbalOrderId])}::jsonb`)
          .orderBy(desc(t.triageCall.openedAt))
          .limit(1);
        return row ?? null;
      });
    },

    async portalCallRows(patientId, sinceIso) {
      const since = new Date(sinceIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            id: t.triageCall.id,
            openedAt: t.triageCall.openedAt,
            callerKind: t.triageCall.callerKind,
            callerRelationshipLabel: t.triageCall.callerRelationshipLabel,
            disposition: t.triageCall.disposition,
          })
          .from(t.triageCall)
          .where(and(eq(t.triageCall.patientId, patientId), gte(t.triageCall.openedAt, since)))
          .orderBy(desc(t.triageCall.openedAt));
        return rows.map(
          (r): PortalTriageCallRow => ({
            triageCallId: r.id,
            occurredAt: iso(r.openedAt),
            callerKind: r.callerKind,
            callerRelationshipLabel: r.callerRelationshipLabel,
            disposition: r.disposition,
          }),
        );
      });
    },

    async responseLatencySeconds(window) {
      const { from, to } = windowBounds(window);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            seconds: sql<number>`extract(epoch from (${t.triageCall.firstResponseAt} - ${t.triageCall.openedAt}))::float8`,
          })
          .from(t.triageCall)
          .where(
            and(
              gte(t.triageCall.openedAt, from),
              lt(t.triageCall.openedAt, to),
              isNotNull(t.triageCall.firstResponseAt),
            ),
          );
        return rows.map((r) => Number(r.seconds)).filter((s) => Number.isFinite(s) && s >= 0);
      });
    },

    async hospitalizationAvoidanceCounts(window) {
      return dispositionCounts(db, window, NON_AVOIDANCE_DISPOSITIONS, "exclude");
    },

    async afterHoursVisitConversionCounts(window) {
      return dispositionCounts(db, window, VISIT_CONVERSION_DISPOSITIONS, "include");
    },

    async escalationTierTallies(window) {
      const { from, to } = windowBounds(window);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ tier: t.triageEscalation.tier, count: sql<number>`count(*)::int` })
          .from(t.triageEscalation)
          .where(
            and(
              gte(t.triageEscalation.escalatedAt, from),
              lt(t.triageEscalation.escalatedAt, to),
            ),
          )
          .groupBy(t.triageEscalation.tier);
        return rows.map((r): EscalationTierTally => ({ tier: r.tier, count: Number(r.count) }));
      });
    },

    async chiefComplaintTallies(window) {
      const { from, to } = windowBounds(window);
      return withOrgContextFromRequest(db, async (tx) => {
        // Keyed on the protocol CATALOG entry, never on `chief_complaint_text`: the bar chart is then
        // aggregatable across tenants without any tenant's free text leaving its org (§4.3's own note).
        // A call with no selected protocol contributes to no bucket rather than to an "unknown" one —
        // an unprotocolled call is not a complaint category.
        const rows = await tx
          .select({
            protocolKey: t.triageProtocol.key,
            chiefComplaintLabel: t.triageProtocol.chiefComplaintLabel,
            count: sql<number>`count(*)::int`,
          })
          .from(t.triageCall)
          .innerJoin(t.triageProtocol, eq(t.triageProtocol.id, t.triageCall.selectedProtocolId))
          .where(and(gte(t.triageCall.openedAt, from), lt(t.triageCall.openedAt, to)))
          .groupBy(t.triageProtocol.key, t.triageProtocol.chiefComplaintLabel);
        return rows.map(
          (r): ChiefComplaintTally => ({
            protocolKey: r.protocolKey,
            chiefComplaintLabel: r.chiefComplaintLabel,
            count: Number(r.count),
          }),
        );
      });
    },

    async rnCoverage(window) {
      const { from, to } = windowBounds(window);
      return withOrgContextFromRequest(db, async (tx) => {
        // The DENOMINATOR is the org's ProviderEntities, read through the SAME RLS-scoped tx. A PE with
        // no rows in `on_call_shift` contributes the whole window as a gap, which is the point.
        const entities = await tx
          .select({ id: t.providerEntities.id })
          .from(t.providerEntities)
          .orderBy(asc(t.providerEntities.createdAt));
        const shifts = await tx
          .select({
            providerEntityId: t.onCallShift.providerEntityId,
            shiftStartsAt: t.onCallShift.shiftStartsAt,
            shiftEndsAt: t.onCallShift.shiftEndsAt,
          })
          .from(t.onCallShift)
          .where(
            and(
              eq(t.onCallShift.discipline, "clinical_rn"),
              // A CANCELLED shift never covered anything and a SCHEDULED one that has already ended
              // was never opened — neither is evidence a nurse was reachable, which is what CoP
              // 418.100(c)(2) asks for. `active` and `completed` are.
              inArray(t.onCallShift.status, ["active", "completed"]),
              lt(t.onCallShift.shiftStartsAt, to),
              sql`${t.onCallShift.shiftEndsAt} > ${from}`,
            ),
          );
        return {
          providerEntityIds: entities.map((e) => e.id),
          windows: shifts.map((s) => ({
            providerEntityId: s.providerEntityId,
            fromIso: iso(s.shiftStartsAt),
            toIso: iso(s.shiftEndsAt),
          })),
        } satisfies RnCoverageRead;
      });
    },
  };
}

/** Half-open `[from, to)` — the same convention every M19 metrics read uses. */
function windowBounds(window: TriageMetricsWindow): { from: Date; to: Date } {
  return { from: new Date(window.from), to: new Date(window.to) };
}

/**
 * The shared measure-population read: DENOMINATOR = every call opened in the window that reached a
 * disposition; NUMERATOR = those whose disposition is in (or, for avoidance, NOT in) the given set.
 *
 * A call with no disposition is in NEITHER, deliberately. An abandoned-before-disposition call is not an
 * avoided hospitalization and not a failed one; counting it in the denominator would depress every rate
 * by the abandonment rate, which is a different measure with its own §4.9 alert.
 */
async function dispositionCounts(
  db: DbClient,
  window: TriageMetricsWindow,
  dispositions: readonly TriageDisposition[],
  mode: "include" | "exclude",
): Promise<MeasureCounts> {
  const { from, to } = windowBounds(window);
  const t = schema;
  return withOrgContextFromRequest(db, async (tx) => {
    const [row] = await tx
      .select({
        denominator: sql<number>`count(*)::int`,
        matching: sql<number>`count(*) filter (where ${inArray(t.triageCall.disposition, [...dispositions])})::int`,
      })
      .from(t.triageCall)
      .where(
        and(
          gte(t.triageCall.openedAt, from),
          lt(t.triageCall.openedAt, to),
          isNotNull(t.triageCall.disposition),
        ),
      );
    const denominator = Number(row?.denominator ?? 0);
    const matching = Number(row?.matching ?? 0);
    return {
      numerator: mode === "include" ? matching : denominator - matching,
      denominator,
    };
  });
}
