// apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts — the Drizzle-backed M25 WRITE
// service. Each command runs under `withOrgContext` (RLS), validates the §2.2 transition via the pure
// domain machines, version-checks the PATCH surfaces (§2.5 — `WHERE id = ? AND version = ?` with a
// distinguishing re-read), stamps the acting membership, and emits the §4.5 outbox event through the
// injected {@link WriteOutboxPort}. A failed transition → INVALID_TRANSITION; a stale version →
// VERSION_CONFLICT; a missing row → NOT_FOUND. Free-text reason/narrative is stored in the audit-denylisted
// columns (override_payload / appeal_narrative / assignment.reason), NEVER in an outbox payload.
import { repositories } from "@chartwarden/billing";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import {
  type AppealTier,
  DEFAULT_DEADLINE_ZONE,
  type DenialState,
  canTransitionAppeal,
  canTransitionDenial,
  computeTierDeadline,
  deriveTierDeadline,
  isKnownZone,
  nextTier,
  noticeDayOf,
} from "../domain";
import type { M25WriteActor } from "./actor";
import { loadAppealPacketPayload } from "./appeal-packet-payload";
import { type AppealSourcePorts, UNBOUND_APPEAL_SOURCES } from "./appeal-packet-sources";
import { VersionConflictError } from "./concurrency";
import { resolveDenialRoute } from "./denial-route-service";
import { type RemittanceCommandDeps, buildRemittanceCommands } from "./remittance-commands-drizzle";
import { recordAppealFilingAttempt } from "./submission-service";
import type {
  AppealCreateInput,
  AppealDecideInput,
  AppealLateGoodCauseInput,
  AppealSubmitInput,
  DenialAssignInput,
  M25WriteService,
  ReasonInput,
  TaxonomyOverlayInput,
  VersionedResult,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

/** The real Drizzle transaction handle (has .select/.update/.insert), inferred from the db client. */
type M25Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The appeal tiers CMS lets a provider file late with good cause (42 CFR §405.942(b)). */
const GOOD_CAUSE_TIERS: ReadonlySet<string> = new Set(["redetermination", "reconsideration"]);

class InvalidTransitionError extends ChartWardenError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `cannot transition from '${from}' to '${to}'`, 409);
    this.name = "InvalidTransitionError";
  }
}

export function buildDrizzleM25WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
  ports: Pick<RemittanceCommandDeps, "claims" | "audit"> & {
    /** The timezones of a provider entity's locations (M1's published reader); absent → the default zone. */
    readonly providerZones?: (tx: DbClient, providerEntityId: string) => Promise<readonly string[]>;
    /** GAP-036 - where the appeal packet reads the claim copy and the enclosure facts (default: refuse). */
    readonly appealSources?: AppealSourcePorts;
  } = {},
): M25WriteService {
  const appealSources = ports.appealSources ?? UNBOUND_APPEAL_SOURCES;
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const DC = schema.denialCase;
  const AC = schema.appealCase;
  const AE = schema.appealCaseEvent;
  const TO = schema.denialTaxonomyOverlay;

  /** Read a denial's current (state, version) or throw NOT_FOUND. */
  async function denialState(tx: M25Tx, id: string) {
    const rows = await tx
      .select({
        state: DC.state,
        version: DC.version,
        providerEntityId: DC.providerEntityId,
        claimId: DC.claimId,
      })
      .from(DC)
      .where(eq(DC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("denial case not found");
    return rows[0];
  }

  /**
   * The zones in which a provider's last filing day may end: every known zone of its locations (the deadline
   * uses whichever ends earliest), or the conservative default when none is known.
   */
  async function providerZone(tx: M25Tx, providerEntityId: string): Promise<readonly string[]> {
    const zones = (
      ports.providerZones
        ? await ports.providerZones(tx as unknown as DbClient, providerEntityId)
        : []
    ).filter(isKnownZone);
    return zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  }

  /**
   * The date printed on the notice a new appeal tier's clock runs from (CMS: the window runs from receipt,
   * presumed 5 days after this date). An explicit `noticeDate` wins. A redetermination uses the remittance
   * advice date of the denied line (the date ChartWarden ingested the file is NOT the notice date), falling back
   * to the denial's open date when no 835 is linked (e.g. a 277CA-seeded denial). A later tier uses the prior
   * tier's decision-letter date, and refuses to guess when no prior tier was decided here.
   */
  async function resolveNoticeDay(
    tx: M25Tx,
    denialCaseId: string,
    tier: AppealTier,
    explicit: string | undefined,
  ): Promise<string> {
    const given = explicit === undefined ? undefined : checkedNoticeDay(explicit);
    // A later tier is opened automatically on an unfavorable decision (see decideAppeal), so a manual one
    // cannot be inferred: the printed date of the prior notice must be supplied, never guessed.
    if (tier !== "redetermination") {
      if (!given) {
        throw new ChartWardenError(
          "NOTICE_DATE_REQUIRED",
          `a ${tier} appeal needs the date printed on the prior tier's decision notice (noticeDate)`,
          422,
        );
      }
      await assertTierOpenable(tx, denialCaseId, tier, given);
      return given;
    }
    const denial = await tx
      .select({ remittanceLineId: DC.remittanceLineId, openedAt: DC.openedAt })
      .from(DC)
      .where(eq(DC.id, denialCaseId))
      .limit(1);
    const lineId = denial[0]?.remittanceLineId;
    const advice = lineId
      ? await tx
          .select({ productionDate: RA.productionDate })
          .from(RL)
          .innerJoin(RA, eq(RA.id, RL.remittanceAdviceId))
          .where(eq(RL.id, lineId))
          .limit(1)
      : [];
    const adviceDay = advice[0]?.productionDate ? noticeDayOf(advice[0].productionDate) : null;
    if (given) {
      // The remittance is the notice; a later date cannot lengthen the window it set. With no 835, the
      // denial's open date is the latest the notice can be.
      const latest = adviceDay ?? (denial[0] ? noticeDayOf(denial[0].openedAt) : null);
      if (latest && given > latest) {
        throw new ChartWardenError(
          "NOTICE_DATE_AFTER_REMITTANCE",
          `notice date ${given} is later than the ${adviceDay ? "remittance advice" : "denial open"} date ${latest}`,
          422,
        );
      }
      return given;
    }
    if (adviceDay) return adviceDay;
    // No 835 is linked (e.g. a 277CA-seeded denial): the denial's open date is later than the real notice, so
    // it would silently lengthen the deadline. Ask for the printed date instead.
    throw new ChartWardenError(
      "NOTICE_DATE_REQUIRED",
      "this denial has no remittance advice; supply the date printed on the notice (noticeDate)",
      422,
    );
  }

  /**
   * A manual later tier must not restart a window the prior decision already started: no live appeal of the
   * same tier may exist on the denial, and the date cannot be later than the prior tier's decision day.
   */
  async function assertTierOpenable(
    tx: M25Tx,
    denialCaseId: string,
    tier: AppealTier,
    given: string,
  ): Promise<void> {
    const rows = await tx
      .select({
        tier: AC.tier,
        state: AC.state,
        decidedAt: AC.decidedAt,
        outcome: AC.decisionOutcome,
      })
      .from(AC)
      .where(eq(AC.denialCaseId, denialCaseId));
    if (rows.some((r) => r.tier === tier && r.state !== "withdrawn" && r.state !== "closed")) {
      throw new ChartWardenError(
        "APPEAL_TIER_EXISTS",
        `a ${tier} appeal is already open on this denial`,
        409,
      );
    }
    // Only a recorded, not-fully-favorable decision of the previous tier opens the next one; without it
    // nothing bounds the supplied date and a lapsed window could be reopened.
    const prior = rows.find(
      (r) => r.decidedAt && r.outcome !== "favorable" && nextTier(r.tier) === tier,
    );
    if (!prior?.decidedAt) {
      throw new ChartWardenError(
        "PRIOR_TIER_REQUIRED",
        `a ${tier} appeal needs a recorded unfavorable or partial decision of the prior tier on this denial`,
        422,
      );
    }
    if (given > noticeDayOf(prior.decidedAt)) {
      throw new ChartWardenError(
        "NOTICE_DATE_AFTER_DECISION",
        `notice date ${given} is later than the prior tier's decision date`,
        422,
      );
    }
  }

  /** A notice date must be a real calendar day and cannot be in the future (allowing for time zones). */
  function checkedNoticeDay(day: string): string {
    try {
      deriveTierDeadline("redetermination", day);
    } catch {
      throw new ChartWardenError(
        "INVALID_NOTICE_DATE",
        "notice date must be a real calendar date (YYYY-MM-DD)",
        422,
      );
    }
    if (day > noticeDayOf(new Date(Date.now() + 86_400_000))) {
      throw new ChartWardenError("NOTICE_DATE_IN_FUTURE", "notice date cannot be in the future", 422);
    }
    return day;
  }

  /**
   * Versioned denial transition: validate the edge, `UPDATE … WHERE id AND version`, then run the optional
   * `emit` IN THE SAME TX (so the §4.5 outbox row commits with the mutation — the D2 posture).
   */
  async function transitionDenial(
    actor: M25WriteActor,
    id: string,
    to: DenialState,
    ifMatch: number,
    extra: Record<string, unknown>,
    emit?: (tx: M25Tx, cur: Awaited<ReturnType<typeof denialState>>) => Promise<void>,
  ): Promise<VersionedResult> {
    return withOrgContext(db, actor, async (tx) => {
      const cur = await denialState(tx, id);
      if (!canTransitionDenial(cur.state, to)) throw new InvalidTransitionError(cur.state, to);
      const updated = await tx
        .update(DC)
        .set({ state: to, version: cur.version + 1, ...extra })
        .where(and(eq(DC.id, id), eq(DC.version, ifMatch)))
        .returning({ id: DC.id, version: DC.version });
      if (!updated[0]) throw new VersionConflictError(cur.version);
      if (emit) await emit(tx, cur);
      return { id: updated[0].id, version: updated[0].version };
    });
  }

  return {
    async replayAdvice(actor, adviceId) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select({ status: RA.parseStatus })
          .from(RA)
          .where(eq(RA.id, adviceId))
          .limit(1);
        if (!rows[0]) throw new NotFoundError("remittance advice not found");
        if (rows[0].status !== "failed") {
          throw new ChartWardenError("INVALID_STATE", "only a failed advice can be replayed", 409);
        }
        await tx.update(RA).set({ parseStatus: "queued" }).where(eq(RA.id, adviceId));
        await outbox.publish(tx, {
          eventName: "m25.edi.835_received",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_advice",
          aggregateId: adviceId,
          payload: { remittanceAdviceId: adviceId, replay: true },
        });
      });
    },

    ...buildRemittanceCommands({ db, outbox, ...ports }),

    async assignDenial(actor, id, input: DenialAssignInput, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await denialState(tx, id);
        const updated = await tx
          .update(DC)
          .set({ assigneeMembershipId: input.assigneeMembershipId, version: cur.version + 1 })
          .where(and(eq(DC.id, id), eq(DC.version, ifMatch)))
          .returning({ id: DC.id, version: DC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(schema.denialCaseAssignment).values({
          organizationId: actor.organizationId,
          denialCaseId: id,
          assignedToMembershipId: input.assigneeMembershipId,
          assignedByMembershipId: actor.membershipId,
          reason: input.reason ?? null,
        });
        return { id: updated[0].id, version: updated[0].version };
      });
    },

    async startDenial(actor, id, ifMatch) {
      return transitionDenial(actor, id, "in_progress", ifMatch, { firstActionedAt: sql`now()` });
    },

    async escalateDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(actor, id, "escalated", ifMatch, {});
    },

    async resolveDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(
        actor,
        id,
        "resolved",
        ifMatch,
        {
          resolvedAt: sql`now()`,
          closureOutcome: "resolved_no_appeal",
        },
        async (tx, cur) => {
          // F-144 (#248) — `m25.denial_resolution_letter.render_requested` is catalogued
          // (events-by-m25.ts) with a real M22 template descriptor and REQUEST_SHAPES adapter, and
          // nothing ever emitted it: a manually-resolved denial produced no resolution letter for any
          // tenant. The chart-target patient is resolved from M23's `claim` row (`patientId`, NOT
          // NULL) — M25's manifest `dependsOn` includes 23, so a direct `repositories.ClaimRepository`
          // read on this SAME tx crosses no boundary `arch:boundaries` polices, the identical legality
          // `outbox-consumers/m23-claim-rejected.ts` already relies on for `providerEntityId`.
          // `denial_case.claim_id` is nullable (277CA-pre-835 / EVV-sourced cases may have no claim
          // yet); a denial resolved with no claim on it gets an honest `patientId: null` render rather
          // than a fabricated one — the F-099 rule.
          const claim = cur.claimId
            ? await new repositories.ClaimRepository(tx).findById(cur.claimId)
            : null;
          await outbox.publish(tx, {
            eventName: "m25.denial_resolution_letter.render_requested",
            organizationId: actor.organizationId,
            aggregateKind: "denial_case",
            aggregateId: id,
            payload: {
              denialCaseId: id,
              payload: {
                patientId: claim?.patientId ?? null,
                claimId: cur.claimId ?? null,
                resolvedAt: new Date().toISOString(),
                closureOutcome: "resolved_no_appeal",
              },
            },
          });
        },
      );
    },

    async closeDenial(actor, id, ifMatch) {
      return transitionDenial(actor, id, "closed", ifMatch, { closedAt: sql`now()` });
    },

    async closeWriteOffDenial(actor, id, input: ReasonInput, ifMatch) {
      return transitionDenial(
        actor,
        id,
        "closed",
        ifMatch,
        {
          closedAt: sql`now()`,
          closureOutcome: "written_off",
          overridePayload: { reason: input.reason, by: actor.membershipId },
        },
        (tx) =>
          outbox.publish(tx, {
            eventName: "m25.patient_responsibility.recorded",
            organizationId: actor.organizationId,
            aggregateKind: "denial_case",
            aggregateId: id,
            payload: { ledgerId: id, patientId: id, prAmount: "0.00" },
          }),
      );
    },

    async reopenDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(actor, id, "open", ifMatch, { closedAt: null, resolvedAt: null });
    },

    async createAppeal(actor, denialCaseId, input: AppealCreateInput) {
      const result = await withOrgContext(db, actor, async (tx) => {
        const cur = await denialState(tx, denialCaseId);
        const tier = input.tier ?? "redetermination";
        if (!cur.claimId)
          throw new ChartWardenError("INVALID_STATE", "the denial has no claim to appeal", 409);
        // Milestone 3: a denial the routing rules send to a MAC reopening (a 56900 non-response) is not appealable.
        // The first appeal needs an audited override reason; a later tier follows an appeal that already existed.
        let routeOverride: { reason: string; ruleId: string | null } | null = null;
        if (tier === "redetermination") {
          const routed = await resolveDenialRoute(tx, denialCaseId, actor.providerEntityScope);
          // A reopening already being worked on this denial means it is on the reopening path whatever the rules
          // say now, so a later rule or reason-code change cannot make the plain appeal route open again.
          const reopenings = await tx
            .select({ state: schema.reopeningCase.state })
            .from(schema.reopeningCase)
            .where(eq(schema.reopeningCase.denialCaseId, denialCaseId));
          const reopeningLive = reopenings.some((r) =>
            ["draft", "submitted", "decided"].includes(r.state),
          );
          if (routed.route === "reopening" || reopeningLive) {
            const reason = input.routeOverrideReason?.trim() ?? "";
            if (reason.length < 10) {
              throw new ChartWardenError(
                "ROUTE_IS_REOPENING",
                "the routing rules send this denial to a MAC reopening, not an appeal; open a reopening, or appeal with an override reason of at least 10 characters",
                409,
              );
            }
            routeOverride = { reason, ruleId: routed.rule?.id ?? null };
          }
        }
        const noticeDay = await resolveNoticeDay(tx, denialCaseId, tier, input.noticeDate);
        const deadline = computeTierDeadline(
          tier,
          noticeDay,
          await providerZone(tx, cur.providerEntityId),
        );
        const inserted = await tx
          .insert(AC)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: cur.providerEntityId,
            denialCaseId,
            claimId: cur.claimId,
            tier,
            state: "draft",
            tierDeadlineAt: deadline,
            noticeDatedOn: noticeDay,
          })
          .returning({ id: AC.id, version: AC.version });
        const appealId = inserted[0]!.id;
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: appealId,
          eventKind: "created",
          actorMembershipId: actor.membershipId,
          // The override reason is free text: it rides the denylisted event payload, so the audit trail keeps it.
          ...(routeOverride
            ? {
                eventPayload: {
                  routeOverrideReason: routeOverride.reason,
                  routeRuleId: routeOverride.ruleId,
                },
              }
            : {}),
        });
        // Move the denial onto the appealed track when the edge is legal (escalated → appealed).
        if (canTransitionDenial(cur.state, "appealed")) {
          await tx
            .update(DC)
            .set({ state: "appealed", version: cur.version + 1 })
            .where(eq(DC.id, denialCaseId));
        }
        return { id: appealId, version: inserted[0]!.version };
      });
      return result;
    },

    async attachAppealDocument(actor, id, documentId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await appealRow(tx, id);
        const updated = await tx
          .update(AC)
          .set({ appealPacketDocumentId: documentId, version: cur.version + 1 })
          .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
          .returning({ id: AC.id, version: AC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: id,
          eventKind: "attached_document",
          actorMembershipId: actor.membershipId,
        });
        return { id: updated[0].id, version: updated[0].version };
      });
    },

    async submitAppeal(actor, id, input: AppealSubmitInput, ifMatch) {
      const submittedAt = new Date();
      return transitionAppeal(
        actor,
        id,
        "submitted",
        ifMatch,
        {
          submittedAt: sql`now()`,
          appealNarrative: {
            narrative: input.appealNarrative,
            documents: input.attachedDocumentIds,
          },
        },
        async (tx, cur) => {
          // GAP-036 - the typed packet payload (narrative, enclosure index, claim copy, 835 detail), built FIRST
          // from the appeal + denial rows under RLS and the claim / document seams: a claim that cannot be read or
          // an enclosure that is not attachable throws here, rolling the submit back before anything is published.
          const packet = await loadAppealPacketPayload(
            tx,
            { id, organizationId: actor.organizationId, ...cur },
            input,
            submittedAt,
            appealSources,
          );
          await outbox.publish(tx, {
            eventName: "m25.appeal.submitted",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: {
              appealCaseId: id,
              denialCaseId: cur.denialCaseId,
              tier: cur.tier,
              submittedAt: submittedAt.toISOString(),
            },
          });
          await outbox.publish(tx, {
            eventName: "m25.appeal_packet.render_requested",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: { appealCaseId: id, tier: cur.tier, payload: packet },
          });
          await recordAppealFilingAttempt(tx, actor, id, cur.providerEntityId);
        },
      );
    },

    async submitAppealLateGoodCause(actor, id, input: AppealLateGoodCauseInput, ifMatch) {
      const submittedAt = new Date();
      return transitionAppeal(
        actor,
        id,
        "submitted",
        ifMatch,
        {
          submittedAt: sql`now()`,
          appealNarrative: {
            narrative: input.appealNarrative,
            documents: input.attachedDocumentIds,
            // M25-F03 — the MAC adjudicates good cause; this flag + the justification ride with the filing.
            lateGoodCauseFiling: true,
            goodCauseJustification: input.goodCauseJustification,
          },
        },
        async (tx, cur) => {
          const packet = await loadAppealPacketPayload(
            tx,
            { id, organizationId: actor.organizationId, ...cur },
            input,
            submittedAt,
            appealSources,
          );
          await outbox.publish(tx, {
            eventName: "m25.appeal.submitted",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: {
              appealCaseId: id,
              denialCaseId: cur.denialCaseId,
              tier: cur.tier,
              submittedAt: submittedAt.toISOString(),
              lateGoodCauseFiling: true,
            },
          });
          await outbox.publish(tx, {
            eventName: "m25.appeal_packet.render_requested",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: { appealCaseId: id, tier: cur.tier, payload: packet },
          });
          await recordAppealFilingAttempt(tx, actor, id, cur.providerEntityId);
        },
        (cur) => {
          // CMS permits a good-cause late filing only at the first two tiers (42 CFR §405.942(b)).
          if (!GOOD_CAUSE_TIERS.has(cur.tier)) {
            throw new ChartWardenError(
              "GOOD_CAUSE_NOT_AVAILABLE",
              `the ${cur.tier} tier has no CMS good-cause late-filing path`,
              409,
            );
          }
          // Before T-0 there is nothing late about it: the normal submit (the within-deadline path) applies.
          if (cur.tierDeadlineAt.getTime() > Date.now()) {
            throw new ChartWardenError(
              "NOT_LATE",
              "the appeal deadline has not elapsed; use the normal submit route",
              409,
            );
          }
        },
      );
    },

    async ackAppeal(actor, id, ifMatch) {
      return transitionAppeal(actor, id, "under_review", ifMatch, {});
    },

    async decideAppeal(actor, id, input: AppealDecideInput, ifMatch) {
      const result = await withOrgContext(db, actor, async (tx) => {
        const cur = await appealRow(tx, id);
        if (!canTransitionAppeal(cur.state, "decided"))
          throw new InvalidTransitionError(cur.state, "decided");
        const decidedAt = new Date(input.decidedAt);
        const noticeDay = checkedNoticeDay(input.decisionNoticeDate ?? noticeDayOf(decidedAt));
        if (noticeDay > noticeDayOf(decidedAt)) {
          throw new ChartWardenError(
            "NOTICE_DATE_AFTER_DECISION",
            "decision notice date cannot be later than the decided-at date",
            422,
          );
        }
        const updated = await tx
          .update(AC)
          .set({
            state: "decided",
            decisionOutcome: input.outcome,
            decidedAt: new Date(input.decidedAt),
            macReferenceNumbers: input.macReferenceNumbers ?? null,
            version: cur.version + 1,
          })
          .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
          .returning({ id: AC.id, version: AC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: id,
          eventKind: "decided",
          actorMembershipId: actor.membershipId,
        });
        // Unfavorable → spawn the next tier (draft) when one exists, anchored on this decision (F04).
        if (input.outcome === "unfavorable") {
          const nt = nextTier(cur.tier);
          if (nt) {
            // The printed decision-letter date (validated above), not the calendar day of an instant.
            await tx.insert(AC).values({
              organizationId: actor.organizationId,
              providerEntityId: cur.providerEntityId,
              denialCaseId: cur.denialCaseId,
              claimId: cur.claimId,
              priorTierAppealCaseId: id,
              tier: nt,
              state: "draft",
              tierDeadlineAt: computeTierDeadline(
                nt,
                noticeDay,
                await providerZone(tx, cur.providerEntityId),
              ),
              noticeDatedOn: noticeDay,
            });
          }
        }
        if (input.outcome === "favorable") {
          await outbox.publish(tx, {
            eventName: "m25.denial.resolved_favorable_via_appeal",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: {
              denialCaseId: cur.denialCaseId,
              appealCaseId: id,
              claimId: cur.claimId,
              tier: cur.tier,
            },
          });
        }
        return { id: updated[0].id, version: updated[0].version };
      });
      return { id: result.id, version: result.version };
    },

    async withdrawAppeal(actor, id, _input: ReasonInput, ifMatch) {
      return transitionAppeal(actor, id, "withdrawn", ifMatch, {});
    },

    async closeAppeal(actor, id, ifMatch) {
      return transitionAppeal(actor, id, "closed", ifMatch, { closedAt: sql`now()` });
    },

    async editTaxonomyOverlay(actor, carcCode, input: TaxonomyOverlayInput, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select({ id: TO.id, version: TO.version })
          .from(TO)
          .where(eq(TO.carcCode, carcCode))
          .limit(1);
        if (rows[0]) {
          const updated = await tx
            .update(TO)
            .set({
              rarcCode: input.rarcCode ?? null,
              plainLanguageOverride: input.plainLanguageOverride ?? null,
              suggestedAction: input.suggestedAction,
              ownerRole: input.ownerRole as (typeof TO.ownerRole.enumValues)[number],
              severity: input.severity as (typeof TO.severity.enumValues)[number],
              version: rows[0].version + 1,
              updatedAt: sql`now()`,
            })
            .where(and(eq(TO.id, rows[0].id), eq(TO.version, ifMatch)))
            .returning({ id: TO.id, version: TO.version });
          if (!updated[0]) throw new VersionConflictError(rows[0].version);
          return { id: updated[0].id, version: updated[0].version };
        }
        const inserted = await tx
          .insert(TO)
          .values({
            organizationId: actor.organizationId,
            carcCode,
            rarcCode: input.rarcCode ?? null,
            plainLanguageOverride: input.plainLanguageOverride ?? null,
            suggestedAction: input.suggestedAction,
            ownerRole: input.ownerRole as (typeof TO.ownerRole.enumValues)[number],
            severity: input.severity as (typeof TO.severity.enumValues)[number],
          })
          .returning({ id: TO.id, version: TO.version });
        return { id: inserted[0]!.id, version: inserted[0]!.version };
      });
    },
  };

  /** Read an appeal's current row facts or throw NOT_FOUND. */
  async function appealRow(tx: M25Tx, id: string) {
    const rows = await tx
      .select({
        state: AC.state,
        version: AC.version,
        tier: AC.tier,
        denialCaseId: AC.denialCaseId,
        claimId: AC.claimId,
        providerEntityId: AC.providerEntityId,
        tierDeadlineAt: AC.tierDeadlineAt,
      })
      .from(AC)
      .where(eq(AC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("appeal case not found");
    return rows[0];
  }

  /**
   * Versioned appeal transition: validate the edge, `UPDATE … WHERE id AND version`, then run the optional
   * `emit` IN THE SAME TX (the §4.5 outbox row commits with the mutation — the D2 posture).
   */
  async function transitionAppeal(
    actor: M25WriteActor,
    id: string,
    to: "submitted" | "under_review" | "withdrawn" | "closed",
    ifMatch: number,
    extra: Record<string, unknown>,
    emit?: (tx: M25Tx, cur: Awaited<ReturnType<typeof appealRow>>) => Promise<void>,
    guard?: (cur: Awaited<ReturnType<typeof appealRow>>) => void,
  ): Promise<VersionedResult> {
    return withOrgContext(db, actor, async (tx) => {
      const cur = await appealRow(tx, id);
      if (!canTransitionAppeal(cur.state, to)) throw new InvalidTransitionError(cur.state, to);
      guard?.(cur);
      const updated = await tx
        .update(AC)
        .set({ state: to, version: cur.version + 1, ...extra })
        .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
        .returning({ id: AC.id, version: AC.version });
      if (!updated[0]) throw new VersionConflictError(cur.version);
      if (emit) await emit(tx, cur);
      return { id: updated[0].id, version: updated[0].version };
    });
  }
}
