// apps/backend/src/modules/36-messaging/outbox-consumers/critical-lab-alerts.ts — #908/#910: M36's consumers of the two
// critical-lab signals, `m11.order.results_received_critical` (M11's LabResultsApplier) and
// `m29.lab_observation.abnormal_flag` (M29's planner). Both were declared `declaredConsumers: []`, so a critical (HH/LL)
// result reached no one.
//
// ONE ALERT PER OBSERVATION. Both events describe the same observation, so both consumers resolve the SAME facts (the
// `critical_lab_result` row M11 writes in the applier's transaction, read through `CriticalLabLookup`) and emit under ONE
// correlation id keyed by the observation; `alert` is UNIQUE on (organization_id, correlation_id), so whichever event
// arrives second is absorbed. A row not yet written (the applier has not run) THROWS: the relay retries, so the page is
// never sent from partial facts and never dropped.
//
// RECIPIENTS (deduplicated; `emitWithRecipientFallback` pages the tenant admins when the set resolves to nobody):
//   caseload RN        CareTeamProvider.primaryRnUserId (open `primary_rn` assignment)
//   order drafter      the membership that drafted/recorded the order (order-bound results)
//   attending          CareTeamProvider.attendingUserId (open `attending_clinician`, else `md` assignment)
//   medical director   role key `medical_director`, resolved by the seeded `role_set` rule from `alertRoleKeys`;
//                      ALWAYS on an unsigned order, and always on an unresolved-quarantine escalation.
// A result bound to NO order pages the caseload RN only; the escalation (below) widens it. The ordering physician of an
// order is an MDM directory entity with no user account, so the patient's attending stands in for them.
//
// PHI-FREE: ids, the LOINC code, the flag and instants only. TENANT: from the envelope, never the payload.
import type { AlertEmitter } from "@chartwarden/messaging";
import type { CareTeamProvider } from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { type FallbackWarn, emitWithRecipientFallback } from "../alert-recipient-fallback";

/** The platform `alert_rule` key (packages/messaging seed). */
export const CRITICAL_LAB_ALERT_TYPE = "m11.order.critical_lab_result";
export const M36_CRITICAL_LAB_FROM_M11_CONSUMER = "m36.critical-lab-alert.from-m11";
export const M36_CRITICAL_LAB_FROM_M29_CONSUMER = "m36.critical-lab-alert.from-m29";
export const MEDICAL_DIRECTOR_ROLE_KEY = "medical_director";

/** The facts M11 recorded for one critical observation (`critical_lab_result` + its order's drafter). */
export interface CriticalLabFacts {
  readonly observationId: string;
  readonly patientId: string;
  readonly orderId: string | null;
  readonly loincCode: string;
  readonly criticalFlag: string;
  readonly orderUnsigned: boolean;
  readonly drafterMembershipId: string | null;
  readonly receivedAt: string;
}

export interface CriticalLabDeps {
  readonly alerts: AlertEmitter;
  readonly careTeam: Pick<CareTeamProvider, "primaryRnUserId" | "attendingUserId">;
  readonly lookup: (
    organizationId: string,
    observationId: string,
  ) => Promise<CriticalLabFacts | null>;
  readonly membershipUserId: (
    organizationId: string,
    membershipId: string,
  ) => Promise<string | null>;
  readonly warn?: FallbackWarn;
}

function uniq(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((i): i is string => typeof i === "string" && i.length > 0))];
}

function requireObservationId(event: DispatchableOutboxEvent): string {
  const v = ((event.payload ?? {}) as Record<string, unknown>).observationId;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${CRITICAL_LAB_ALERT_TYPE}: ${event.eventType} payload has no observationId`);
  }
  return v;
}

function safePayload(
  facts: CriticalLabFacts,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventType: CRITICAL_LAB_ALERT_TYPE,
    observationId: facts.observationId,
    patientId: facts.patientId,
    orderId: facts.orderId,
    loincCode: facts.loincCode,
    criticalFlag: facts.criticalFlag,
    receivedAt: facts.receivedAt,
    deepLink: facts.orderId ? `/orders/${facts.orderId}` : `/patients/${facts.patientId}`,
    ...extra,
  };
}

/** The initial page: RN (+ drafter + attending for an order-bound result; + medical director when unsigned). */
export async function pageCriticalLab(
  deps: CriticalLabDeps,
  organizationId: string,
  observationId: string,
): Promise<void> {
  const facts = await deps.lookup(organizationId, observationId);
  if (facts === null) {
    throw new Error(
      `${CRITICAL_LAB_ALERT_TYPE}: no critical_lab_result row yet for ${observationId}`,
    );
  }
  const ref = { organizationId, patientId: facts.patientId };
  const orderBound = facts.orderId !== null;
  const recipients = uniq([
    await deps.careTeam.primaryRnUserId(ref),
    orderBound && facts.drafterMembershipId
      ? await deps.membershipUserId(organizationId, facts.drafterMembershipId)
      : null,
    orderBound ? await deps.careTeam.attendingUserId(ref) : null,
  ]);
  await emitWithRecipientFallback(
    deps.alerts,
    organizationId,
    {
      eventType: CRITICAL_LAB_ALERT_TYPE,
      severity: "critical",
      correlationId: `m11-lab-critical:${observationId}`,
      payload: safePayload(facts, {
        stage: orderBound ? "result" : "result_no_order",
        orderUnsigned: facts.orderUnsigned,
        recipientUserIds: recipients,
        alertRoleKeys: facts.orderUnsigned ? [MEDICAL_DIRECTOR_ROLE_KEY] : [],
        message: orderBound
          ? "A critical lab result was received."
          : "A critical lab result was received with no matching order.",
      }),
    },
    deps.warn,
  );
}

/** The escalation of an unresolved no-order quarantine: medical director (role) + the attending, and the RN again. */
export function buildCriticalLabEscalator(deps: CriticalLabDeps) {
  return async (organizationId: string, facts: CriticalLabFacts): Promise<void> => {
    const ref = { organizationId, patientId: facts.patientId };
    const recipients = uniq([
      await deps.careTeam.primaryRnUserId(ref),
      await deps.careTeam.attendingUserId(ref),
    ]);
    await emitWithRecipientFallback(
      deps.alerts,
      organizationId,
      {
        eventType: CRITICAL_LAB_ALERT_TYPE,
        severity: "critical",
        correlationId: `m11-lab-critical:${facts.observationId}:escalation`,
        payload: safePayload(facts, {
          stage: "escalation_unresolved_no_order",
          orderUnsigned: false,
          recipientUserIds: recipients,
          alertRoleKeys: [MEDICAL_DIRECTOR_ROLE_KEY],
          message: "A critical lab result with no matching order is still unresolved.",
        }),
      },
      deps.warn,
    );
  };
}

function binding(
  consumerName: string,
  eventType: string,
  deps: CriticalLabDeps,
): OutboxConsumerBinding {
  return {
    consumerName,
    consumerModule: "m36",
    eventTypes: [eventType],
    async handle(event) {
      await pageCriticalLab(deps, event.organizationId, requireObservationId(event));
    },
  };
}

export function buildM36CriticalLabAlertConsumers(
  deps: CriticalLabDeps,
): readonly OutboxConsumerBinding[] {
  return [
    binding(M36_CRITICAL_LAB_FROM_M11_CONSUMER, "m11.order.results_received_critical", deps),
    binding(M36_CRITICAL_LAB_FROM_M29_CONSUMER, "m29.lab_observation.abnormal_flag", deps),
  ];
}
