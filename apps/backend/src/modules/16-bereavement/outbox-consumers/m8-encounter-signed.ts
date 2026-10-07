// apps/backend/src/modules/16-bereavement/outbox-consumers/m8-encounter-signed.ts — GAP-130, the §4.5
// `m8.encounter.signed` → `handleEncounterSigned` binding (D15, §7.5).
//
// M16 §4.5: "`m8.encounter.signed` (filtered to `encounter_type='bereavement_contact'`) | M8 |
// `handleEncounterSigned` | append `bereavement_contact_log` row with `source_encounter_id`; updates outreach
// to `completed`". §7.5 is the done-means: the counselor deep-links from the in-person outreach row into the
// M8 composer, signs the `bereavement_contact` encounter, and M16 — not the counselor, a second time —
// closes the touchpoint off that signature. Before this binding the only path was the counselor completing
// the outreach by hand with the encounter id (route 21), so an in-person visit that was documented and
// signed in M8 never completed its bereavement outreach.
//
// MATCHING. §7.5 matches "by `bereaved_contact_id` + scheduled_for proximity + no existing fulfilment". The
// LOCKED `m8.encounter.signed` payload carries the decedent (`patientId`/`admissionId`) but no bereaved
// contact — M8 has no bereavement-plan or contact column — so the plan is resolved by (org, patient,
// admission) and the touchpoint by {@link selectOutreachForSignedEncounter}: the `in_person_visit` row the
// counselor already STARTED (the "Start contact → open M8 encounter" deep-link of §7.5) wins, else the
// open visit whose `due_at` is nearest the signature. A visit with no open in-person touchpoint is an ad-hoc
// visit — a no-op here; the counselor logs it through route 26.
//
// IDEMPOTENT BY CONSTRUCTION: a contact-log row already carrying `source_encounter_id = encounterId` (this
// consumer's own earlier delivery, or the counselor completing by hand with the same encounter) ends the
// handler before any write, and the outreach update is guarded on the status it was read in.
//
// RELAY TICKS ARE NOT REQUESTS: everything runs inside `withOrgContext` with the event's own org (the F-102
// `CONSUMER_USER_ID` convention); no ambient-scope seam is called. The two M16 events it can publish
// (`outreach_completed`) go through the bound, catalog-validating `m16` publisher on the same tx.
import { isClosedPlanStatus } from "@wardenx/bereavement";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { BereavementOutreachStatus, EncounterId, IsoInstant } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import { transitionBereavementOutreach } from "../lifecycle/index";
import { type EffectContext, runEffects } from "../routes/effects-runner";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;
const OUTREACH = schema.bereavementOutreach;
const LOG = schema.bereavementContactLog;

/** F-102 — a consumer-driven write names no acting membership in the tenancy scope. */
const CONSUMER_USER_ID = "";

/** M8's literal for the bereavement encounter type (`encounter_type` enum, M8 §2.2). */
const BEREAVEMENT_CONTACT_ENCOUNTER_TYPE = "bereavement_contact";

/** §7.5 — a signed in-person bereavement visit is, by definition, the survivor engaging. */
const IN_PERSON_OUTCOME = "engaged" as const;

/** The touchpoint states a signed visit can still fulfil (§2.4): started, due, or missed-within-grace. */
const FULFILLABLE_STATUSES: readonly BereavementOutreachStatus[] = [
  "in_progress",
  "scheduled",
  "missed",
];

/**
 * How early a signed visit may fulfil a `scheduled` touchpoint. The spec sets no early bound; without one an
 * ad-hoc visit would complete a milestone months out (e.g. the 6-month visit), leaving the real one with no
 * open row. Earlier than this, the encounter is ad hoc and left to route 26.
 */
export const SCHEDULED_EARLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const M16_ENCOUNTER_SIGNED_CONSUMER = {
  eventName: "m8.encounter.signed",
  consumerName: "m16.m8-encounter-signed",
} as const;

export interface EncounterSignedDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
}

/** One open in-person touchpoint, as the selector needs it. */
export interface OutreachCandidate {
  readonly id: string;
  readonly status: string;
  readonly dueAt: Date;
  readonly lateGraceUntil: Date;
}

/**
 * §7.5 — pick the in-person touchpoint a signed bereavement encounter fulfils, or null for an ad-hoc visit.
 * Pure. A `missed` row qualifies only while the signature is inside its late grace (`<=`, the 2026-10-05
 * boundary decision); a `scheduled` row only from SCHEDULED_EARLY_WINDOW_MS before its `due_at`; terminal rows
 * never do. Ranking: the STARTED visit first, then nearest `due_at`, then
 * id — so a redelivery always lands on the same row.
 */
export function selectOutreachForSignedEncounter<T extends OutreachCandidate>(
  candidates: readonly T[],
  signedAtIso: string,
): T | null {
  const signedAt = Date.parse(signedAtIso);
  const open = candidates.filter((c) => {
    if (c.status === "missed") return signedAt <= c.lateGraceUntil.getTime();
    if (c.status === "scheduled") return signedAt >= c.dueAt.getTime() - SCHEDULED_EARLY_WINDOW_MS;
    return c.status === "in_progress";
  });
  const rank = (c: T): readonly [number, number, string] => [
    c.status === "in_progress" ? 0 : 1,
    Math.abs(c.dueAt.getTime() - signedAt),
    c.id,
  ];
  const sorted = [...open].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0;
  });
  return sorted[0] ?? null;
}

interface SignedFacts {
  readonly encounterId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly signedByMembershipId: string;
  readonly signedAt: string;
}

function factsOf(p: Record<string, unknown>): SignedFacts {
  const need = (field: string): string => {
    const v = p[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${M16_ENCOUNTER_SIGNED_CONSUMER.consumerName}: payload has no ${field}`);
    }
    return v;
  };
  return {
    encounterId: need("encounterId"),
    patientId: need("patientId"),
    admissionId: need("admissionId"),
    signedByMembershipId: need("signedByMembershipId"),
    signedAt: need("signedAt"),
  };
}

/**
 * M16's live `m8.encounter.signed` binding (filtered to `bereavement_contact`): appends the D15
 * `in_person_visit` contact-log row with `source_encounter_id` and drives the matched touchpoint to
 * `completed` (through `startContact`/`lateAttempt` when it was not yet started), publishing
 * `m16.bereavement.outreach_completed`.
 */
export function buildM16EncounterSignedConsumer(deps: EncounterSignedDeps) {
  return {
    consumerName: M16_ENCOUNTER_SIGNED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_ENCOUNTER_SIGNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      // Route BEFORE opening a transaction: every signed encounter in the tenant reaches this consumer.
      if (p.encounterType !== BEREAVEMENT_CONTACT_ENCOUNTER_TYPE) return;
      const facts = factsOf(p);
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [already] = await tx
            .select({ id: LOG.id })
            .from(LOG)
            .where(
              and(
                eq(LOG.organizationId, organizationId),
                eq(LOG.sourceEncounterId, facts.encounterId),
              ),
            )
            .limit(1);
          if (already) return; // this encounter already fulfils a touchpoint

          const [plan] = await tx
            .select()
            .from(PLAN)
            .where(
              and(
                eq(PLAN.organizationId, organizationId),
                eq(PLAN.patientId, facts.patientId),
                eq(PLAN.admissionId, facts.admissionId),
              ),
            )
            .limit(1);
          if (!plan || isClosedPlanStatus(plan.status)) return; // no live program to record against

          const candidates = await tx
            .select()
            .from(OUTREACH)
            .where(
              and(
                eq(OUTREACH.planId, plan.id),
                eq(OUTREACH.kind, "in_person_visit"),
                inArray(OUTREACH.status, [...FULFILLABLE_STATUSES]),
              ),
            );
          const outreach = selectOutreachForSignedEncounter(candidates, facts.signedAt);
          if (!outreach) return; // an ad-hoc visit — route 26 is the counselor's path for it

          await completeFromEncounter(tx, deps, plan, outreach, facts);
        },
      );
    },
  };
}

type PlanRow = typeof PLAN.$inferSelect;
type OutreachRow = typeof OUTREACH.$inferSelect;

async function completeFromEncounter(
  tx: DbClient,
  deps: EncounterSignedDeps,
  plan: PlanRow,
  outreach: OutreachRow,
  facts: SignedFacts,
): Promise<void> {
  const at = facts.signedAt as IsoInstant;
  const effectCtx = (payloads: EffectContext["payloads"]): EffectContext => ({
    organizationId: plan.organizationId,
    at: new Date(at),
    outbox: deps.outbox,
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads,
  });

  // §2.4 — completion is only legal from `in_progress`; a due or missed-within-grace visit is opened by
  // the signature itself (`startContact` / `lateAttempt`), exactly as a counselor would.
  let status = outreach.status;
  if (status === "scheduled" || status === "missed") {
    const opened = transitionBereavementOutreach(
      status,
      status === "scheduled"
        ? { type: "startContact", at, kind: outreach.kind }
        : {
            type: "lateAttempt",
            at,
            lateGraceUntil: outreach.lateGraceUntil.toISOString() as IsoInstant,
          },
    );
    await runEffects(tx, opened.effects, effectCtx({}));
    status = opened.to;
  }

  const [log] = await tx
    .insert(LOG)
    .values({
      organizationId: plan.organizationId,
      providerEntityId: plan.providerEntityId,
      locationId: plan.locationId,
      planId: plan.id,
      bereavedContactId: outreach.bereavedContactId,
      outreachId: outreach.id,
      contactAt: new Date(at),
      kind: "in_person_visit",
      outcome: IN_PERSON_OUTCOME,
      sourceEncounterId: facts.encounterId,
      contactNotesCipher: null, // D15 — the narrative lives on the M8 encounter, never here
      loggedByUserId: facts.signedByMembershipId,
      contactRespondedDirectly: true,
    })
    .returning({ id: LOG.id });
  if (!log) throw new Error("m16: the in-person contact-log insert returned no row");

  const completed = transitionBereavementOutreach(status, {
    type: "completeContact",
    at,
    kind: "in_person_visit",
    outcome: IN_PERSON_OUTCOME,
    sourceEncounterId: facts.encounterId as EncounterId,
    contactLogCount: 1,
  });
  await runEffects(
    tx,
    completed.effects,
    effectCtx({
      "m16.bereavement.outreach_completed": {
        planId: plan.id,
        contactId: outreach.bereavedContactId,
        outreachId: outreach.id,
        outcome: IN_PERSON_OUTCOME,
        sourceEncounterId: facts.encounterId,
      },
    }),
  );

  const [row] = await tx
    .update(OUTREACH)
    .set({
      status: completed.to,
      startedAt: outreach.startedAt ?? new Date(at),
      completedAt: new Date(at),
      updatedAt: new Date(),
    })
    // No version column on bereavement_outreach (GAP-194): the status read above is the guard, so a
    // concurrent counselor completion matches no row and this delivery rolls back to retry → no-op.
    .where(and(eq(OUTREACH.id, outreach.id), eq(OUTREACH.status, outreach.status)))
    .returning({ id: OUTREACH.id });
  if (!row) throw new Error("m16: the outreach changed underneath the encounter-signed completion");
}
