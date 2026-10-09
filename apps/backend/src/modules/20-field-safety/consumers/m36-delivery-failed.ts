// apps/backend/src/modules/20-field-safety/consumers/m36-delivery-failed.ts — M20's subscriber to
// `m36.notification.delivery_failed` (§4.8, #205 M36 follow-up).
//
// A page that never reached the on-call responder for an OPEN SOS alert is itself a §2.2.2 escalation
// trigger: `sos-escalator.ts`'s own header already names this exact case ("driven by … the m36.notification.
// delivery_failed consumer (delivery_failed — a page that did not arrive is a breach that has already
// happened)"), and `events-by-m20.ts`'s `sos_alert_escalated` catalog description says so too ("the SLA
// watchdog (or a delivery failure, or a supervisor)"). This file is that producer's IO half.
//
// NO PRODUCER PUBLISHES THE EVENT YET — see events-by-m36.ts's header. This consumer is wired and ready
// for when one lands, not yet exercised in production.
//
// ── WHY THE ESCALATION LADDER, NOT `escalateUnresolved` ─────────────────────────────────────────────────
//
// `triage-call.ts`'s `escalateUnresolved`-shaped answer does not exist for M20: `escalateSos` (./sos-alert)
// IS the general "advance one rung" function, legal from exactly `acknowledging` / `escalation_tier_1` /
// `escalation_tier_2` / `escalation_tier_3` (`resolveSosEdge(state, "escalate")`), so — unlike M19's
// `escalateUnresolved`, which is legal from only one of six open states — this needed no separate append-
// only record; the existing state machine already generalizes.
//
// ── WHY `escalation_tier_3` IS DELIBERATELY REFUSED, NOT ESCALATED ───────────────────────────────────────
//
// `escalate` from `escalation_tier_3` reaches `emergency_terminus`, whose entry auto-dials the clinician's
// consented emergency contact (a spouse), surfaces the PSAP line and pages WardenX ops (GAP-032 made those
// effects real, via the durable ledger in `../terminus/`). That is the mandated end of the life-safety chain
// for an alert that has been UNANSWERED past its tier-3 SLA - it must never be reachable because ONE
// notification to ONE recipient failed to deliver. A single bounced SMS or expired push would otherwise jump
// an alert straight into the terminus with no SLA breach and call a spouse. The SLA watchdog
// (`../jobs/cron-workers.ts`) is the only edge that enters the terminus. `terminus_unsupported` therefore
// still DEAD-LETTERS (OPS-035's posture: a DLQ entry is a signal ops reviews, not noise).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  SafetySosAlertId,
  SafetySosLifecycleState,
} from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildSosEscalatedAlert } from "../alerts";
import { type SafetySosAlertFacts, escalateSos } from "../lifecycle/sos-alert";
import { type SosStateHistoryPort, runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";

const SOS = schema.safetySosAlert;
const SOS_HISTORY = schema.safetySosAlertStateHistory;
const CONSENT = schema.safetyEmergencyContactConsent;

/** §3.3 — a system-driven escalation names no acting membership. */
const CONSUMER_USER_ID = "";

/** The states `escalateSos` may safely advance from, given this consumer never resolves the terminus
 *  caller-owned effects (see the header). `escalation_tier_3` is EXCLUDED on purpose. */
const ESCALATABLE_STATES: readonly SafetySosLifecycleState[] = [
  "acknowledging",
  "escalation_tier_1",
  "escalation_tier_2",
];

/** The `m36.notification.delivery_failed` payload as M20 reads it (mapped from the catalog's generic wire
 *  shape by `./m36-delivery-failed`'s binding — see events-by-m36.ts's header on `sourceAggregateId`). */
export interface M36DeliveryFailedPayload {
  readonly notificationId: string;
  readonly recipientKind: "on_call" | "role_set" | "care_team" | "individual" | "other";
  /** The `mN.*` alert eventType M36 was delivering (`m20.safety.sos_*` when the page was ours). */
  readonly alertEventType: string | null;
  /** The SOS alert the undelivered page was about, when `alertEventType` was one of M20's own. */
  readonly sosAlertId: SafetySosAlertId | null;
  readonly channel: string | null;
  readonly failedAt: IsoInstant;
}

export type SosDeliveryFailureAction =
  /** The failed page was not about one of M20's own alerts. */
  | { readonly kind: "ignore" }
  /** The named alert does not exist (or is another tenant's — the read is org-scoped). */
  | { readonly kind: "no_such_alert" }
  /** The alert already left the escalation ladder (acknowledged/resolving/resolved/cancelled/terminus/
   *  incident_opened) — re-paging it would train responders to ignore a channel that already worked. */
  | { readonly kind: "already_settled"; readonly lifecycleState: SafetySosLifecycleState }
  /** `escalation_tier_3` — the next rung is the terminus this consumer cannot safely complete. */
  | { readonly kind: "terminus_unsupported" }
  | { readonly kind: "escalate"; readonly alert: SafetySosAlertFacts };

/** §4.8 — decide what an `m36.notification.delivery_failed` delivery does for M20 (pure, no IO). */
export function decideSosDeliveryFailure(input: {
  readonly payload: M36DeliveryFailedPayload;
  readonly alert: SafetySosAlertFacts | null;
}): SosDeliveryFailureAction {
  if (input.payload.sosAlertId === null) return { kind: "ignore" };
  if (input.alert === null) return { kind: "no_such_alert" };
  if (input.alert.lifecycleState === "escalation_tier_3") return { kind: "terminus_unsupported" };
  if (!ESCALATABLE_STATES.includes(input.alert.lifecycleState)) {
    return { kind: "already_settled", lifecycleState: input.alert.lifecycleState };
  }
  return { kind: "escalate", alert: input.alert };
}

export interface SosDeliveryFailureConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  /** §2.4 rule 4 — best-effort, outside the failure path (see ../routes/effects-runner.ts). */
  readonly alerts?: AlertPort;
  readonly now?: () => Date;
}

function sosFactsOf(row: {
  lifecycleState: string;
  version: number;
  postedByMembershipId: string;
  postedAt: Date;
  cancelWindowExpiredAt: Date;
  cancelStatus: string;
  lastKnownVisitId: string | null;
  linkedIncidentId: string | null;
}): SafetySosAlertFacts {
  return {
    lifecycleState: row.lifecycleState as SafetySosAlertFacts["lifecycleState"],
    version: row.version,
    postedByMembershipId: row.postedByMembershipId as SafetySosAlertFacts["postedByMembershipId"],
    postedAt: row.postedAt.toISOString() as IsoInstant,
    cancelWindowExpiredAt: row.cancelWindowExpiredAt.toISOString() as IsoInstant,
    cancelStatus: row.cancelStatus as SafetySosAlertFacts["cancelStatus"],
    lastKnownVisitId: row.lastKnownVisitId as SafetySosAlertFacts["lastKnownVisitId"],
    linkedIncidentId: row.linkedIncidentId as SafetySosAlertFacts["linkedIncidentId"],
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m20.m36-delivery-failed: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m20.m36-delivery-failed: '${key}' must be a non-empty string`);
  }
  return value;
}

/** §2.2.8 — is `emergency_contact_call` an ACTIVE consent for the clinician who raised the alert? Mirrors
 *  `write-service-drizzle.ts`'s `consentActive` (private to that factory's closure — duplicated rather
 *  than exported, the same minimal-diff call this module's M19 sibling makes for `loadSos`). */
async function emergencyContactConsentActive(
  tx: DbClient,
  organizationId: string,
  clinicianMembershipId: MembershipId,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: CONSENT.status, expiresAt: CONSENT.expiresAt })
    .from(CONSENT)
    .where(
      and(
        eq(CONSENT.organizationId, organizationId),
        eq(CONSENT.clinicianMembershipId, clinicianMembershipId),
        eq(CONSENT.consentPurpose, "emergency_contact_call"),
        eq(CONSENT.status, "granted"),
      ),
    )
    .limit(1);
  if (!row) return false;
  return row.expiresAt === null || row.expiresAt.getTime() > at.getTime();
}

/** Apply an `escalate` action: `escalateSos` + `runEffects` + the version-guarded patch, one transaction. */
async function applyEscalation(
  deps: SosDeliveryFailureConsumerDeps,
  organizationId: OrgId,
  sosAlertId: SafetySosAlertId,
  at: Date,
  atIso: IsoInstant,
): Promise<void> {
  await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (handle) => {
    const tx = handle as DbClient;
    const [row] = await tx
      .select()
      .from(SOS)
      .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, organizationId)))
      .limit(1);
    if (!row) return; // §2.6 — settled/vanished between decide and apply; nothing to escalate.
    const alert = sosFactsOf(row as never);
    // Re-check under the transaction: the decide pass above is not atomic with this read.
    if (!ESCALATABLE_STATES.includes(alert.lifecycleState)) return;

    const emergencyContactConsent = await emergencyContactConsentActive(
      tx,
      organizationId,
      alert.postedByMembershipId,
      at,
    );
    const transition = escalateSos({
      alert,
      reasonCode: "delivery_failed",
      at: atIso,
      emergencyContactConsent,
    });
    if (transition.to === "emergency_terminus") return; // decided above; re-checked, never reached here.

    const stateHistory: SosStateHistoryPort = {
      async insert(insertTx: unknown, historyRow) {
        await (insertTx as DbClient).insert(SOS_HISTORY).values({
          organizationId: historyRow.organizationId,
          providerEntityId: historyRow.providerEntityId,
          locationId: historyRow.locationId,
          sosAlertId: historyRow.sosAlertId,
          fromState: historyRow.fromState as never,
          toState: historyRow.toState as never,
          transitionedAt: historyRow.transitionedAt,
          transitionedByMembershipId: historyRow.transitionedByMembershipId,
          reason: historyRow.reason,
        });
      },
    };

    await runEffects(tx, transition.effects, {
      organizationId: row.organizationId as string,
      providerEntityId: row.providerEntityId as string,
      locationId: row.locationId as string | null,
      sosAlertId,
      at,
      actorMembershipId: null, // §3.3 — a watchdog/delivery-failure tier advance carries no membership.
      reason: "m36.notification.delivery_failed",
      outbox: deps.outbox,
      ...(deps.alerts ? { alerts: deps.alerts } : {}),
      stateHistory,
      aggregateKind: "safety_sos_alert",
      aggregateId: sosAlertId,
      payloads: {
        "m20.safety.sos_alert_escalated": {
          orgId: row.organizationId,
          providerEntityId: row.providerEntityId,
          occurredAt: atIso,
          sosAlertId,
          fromTier: transition.from,
          toTier: transition.to,
          escalatedAt: atIso,
          reasonCode: "delivery_failed",
        },
      },
      alertPayloads: {
        "m20.safety.sos_alert_escalated": buildSosEscalatedAlert({
          orgId: row.organizationId as never,
          providerEntityId: row.providerEntityId as never,
          sosAlertId,
          fromTier: transition.from as SafetySosLifecycleState,
          toTier: transition.to as SafetySosLifecycleState,
          escalatedAt: atIso,
          reasonCode: "delivery_failed",
        }) as unknown as Record<string, unknown>,
      },
    });

    await tx
      .update(SOS)
      .set({ lifecycleState: transition.to as never, version: alert.version + 1, updatedAt: at })
      .where(and(eq(SOS.id, sosAlertId), eq(SOS.version, alert.version)));
  });
}

/** The live §4.8 M36 delivery-failure binding. */
export function buildSosDeliveryFailureConsumer(
  deps: SosDeliveryFailureConsumerDeps,
): OutboxConsumerBinding {
  const clock = deps.now ?? (() => new Date());
  return {
    consumerName: "m20.m36-delivery-failed",
    consumerModule: "m20",
    eventTypes: ["m36.notification.delivery_failed"],
    async handle(event) {
      const payload = recordOf(event.payload);
      const organizationId = event.organizationId as OrgId;
      const at = clock();
      const atIso = at.toISOString() as IsoInstant;
      const alertEventType =
        typeof payload.alertEventType === "string" ? payload.alertEventType : null;
      const sourceAggregateId =
        typeof payload.sourceAggregateId === "string" ? payload.sourceAggregateId : null;
      const m20Payload: M36DeliveryFailedPayload = {
        notificationId: stringOf(payload, "notificationId"),
        recipientKind: payload.recipientKind as M36DeliveryFailedPayload["recipientKind"],
        alertEventType,
        sosAlertId:
          alertEventType?.startsWith("m20.") === true && sourceAggregateId !== null
            ? (sourceAggregateId as SafetySosAlertId)
            : null,
        channel: typeof payload.channel === "string" ? payload.channel : null,
        failedAt: typeof payload.failedAt === "string" ? (payload.failedAt as IsoInstant) : atIso,
      };

      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        let facts: SafetySosAlertFacts | null = null;
        if (m20Payload.sosAlertId !== null) {
          await withOrgContext(
            deps.db,
            { organizationId, userId: CONSUMER_USER_ID },
            async (handle) => {
              const [row] = await (handle as DbClient)
                .select()
                .from(SOS)
                .where(
                  and(
                    eq(SOS.id, m20Payload.sosAlertId as string),
                    eq(SOS.organizationId, organizationId),
                  ),
                )
                .limit(1);
              facts = row ? sosFactsOf(row as never) : null;
            },
          );
        }

        const action = decideSosDeliveryFailure({ payload: m20Payload, alert: facts });
        switch (action.kind) {
          case "ignore":
          case "no_such_alert":
          case "already_settled":
            return;
          case "terminus_unsupported":
            throw new Error(
              `m20.m36-delivery-failed: SOS alert ${m20Payload.sosAlertId} is at escalation_tier_3 with a failed page — the next rung is emergency_terminus, whose dial/PSAP/page effects this consumer does not implement (see the file header); dead-lettering for a human.`,
            );
          case "escalate":
            return applyEscalation(
              deps,
              organizationId,
              m20Payload.sosAlertId as SafetySosAlertId,
              at,
              atIso,
            );
        }
      });
    },
  };
}
