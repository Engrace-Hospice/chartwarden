// apps/backend/src/modules/36-messaging/outbox-consumers/idg-carry-forward-compliance.ts — M36's consumer of
// `m14.action_item.carry_forward`: raises the CRITICAL typed alert `m14.action_item.carry_forward.compliance`
// (M14 §2.7 / D8, alert catalog in 14-idg/alerts-by-m14.ts) when — and only when — an action item's carry-forward
// count CROSSES the compliance threshold.
//
// WHERE THE RULES LIVE.
//   • Crossing: M14's cron decides it (`isComplianceAlert` = stored prior < 3 and derived count >= 3, derived from
//     distinct NON-cancelled meetings) and flags it on the event. This consumer additionally refuses to act on a
//     flag whose `carryForwardCount` is < 3 (a malformed / pre-fix event) — it fires on `isComplianceAlert &&
//     count >= 3`, never on an ordinary carry.
//   • Once per item, ever: the alert's correlation id is `m14.carry_forward.compliance:<actionItemId>`, and `alert`
//     is UNIQUE on `(organization_id, correlation_id)` — so a relay redelivery, a second tick, or an item that
//     dips below 3 (a meeting cancelled) and crosses again can never page twice. (The M36 spec documents no
//     repeat/escalation cadence for this alert, so none is built.)
//   • Recipients: resolved by M36 from the platform `alert_rule` (alert-rules.ts seed): `role_set`
//     [compliance_officer, clinical_supervisor, org_admin] + the target meeting's coordinator. M14 names the
//     catalog resolver `idg_compliance_inbox`; M36 owns what it means (ADR-0024: resolution is M36's).
//
// CATALOG VALIDATION. M36 is foundation-tier and must not import M14, so the composition root hands this consumer
// the registered `AlertPayloadEntry` map (`catalog`, built from M14's contribution on the registry). The payload
// is checked against the entry's TypeBox `payloadSchema` BEFORE emit; an unregistered type or a failing payload
// THROWS (the relay retries then dead-letters — a visible failure, never a silently dropped compliance alert).
//
// NO PHI: ids + the count + a constant body template only. No patient id, no action-item title, no deep link (the
// only IDG action-item route is the id-less list, `/idg/action-items`; an id-based one does not exist).
//
// RELAY, NOT A REQUEST: `handle` runs in the outbox relay. It opens no tenant reads itself — `alerts.emit` and the
// membership lookup each wrap their own `withOrgContext` with the event's org id.
import { Value } from "@sinclair/typebox/value";
import type { AlertEmitter } from "@wardenx/messaging";
import type { AlertPayloadEntry } from "@wardenx/types";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

export const IDG_CARRY_FORWARD_COMPLIANCE_CONSUMER = {
  consumerName: "m36.idg-carry-forward-compliance-alert",
  eventNames: ["m14.action_item.carry_forward"] as const,
} as const;

/** The typed alert payload type (also the `alert.event_type` and the platform `alert_rule` key). */
export const IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE = "m14.action_item.carry_forward.compliance";

/** The count at which the alert fires (mirrors `CARRY_FORWARD_COMPLIANCE_THRESHOLD` in @wardenx/idg; M36 does not
 *  import M14's package — the catalog schema's own `minimum: 3` is the contract). */
const THRESHOLD = 3;

/** Constant, PHI-free body (M36 composes the final copy from the catalog payload; it never re-templates). */
export const IDG_CARRY_FORWARD_COMPLIANCE_BODY =
  "An IDG action item has now been carried forward into a third meeting and is still open. Review it on the IDG action-item list.";

export interface IdgCarryForwardComplianceDeps {
  readonly alerts: AlertEmitter;
  /** The registered alert-payload catalog (payloadType -> entry), built by the composition root. */
  readonly catalog: ReadonlyMap<string, AlertPayloadEntry>;
  /** Resolve a membership id to its ACTIVE user id in the org, or null (departed / unknown). */
  readonly membershipUserId: (
    organizationId: string,
    membershipId: string,
  ) => Promise<string | null>;
}

/** The deterministic correlation id: one alert per (org, action item), ever. */
export function carryForwardComplianceCorrelationId(priorActionItemId: string): string {
  return `m14.carry_forward.compliance:${priorActionItemId}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function buildIdgCarryForwardComplianceConsumer(
  deps: IdgCarryForwardComplianceDeps,
): OutboxConsumerBinding {
  const name = IDG_CARRY_FORWARD_COMPLIANCE_CONSUMER.consumerName;
  return {
    consumerName: name,
    consumerModule: "m36",
    eventTypes: [...IDG_CARRY_FORWARD_COMPLIANCE_CONSUMER.eventNames],
    async handle(event) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      // Not the crossing ⇒ nothing to raise (every ordinary carry lands here).
      if (p.isComplianceAlert !== true) return;
      const count = p.carryForwardCount;
      const priorActionItemId = str(p.priorActionItemId);
      if (typeof count !== "number" || !Number.isInteger(count) || count < THRESHOLD) {
        throw new Error(
          `${name}: compliance flag with carryForwardCount '${String(count)}' (< ${THRESHOLD})`,
        );
      }
      if (priorActionItemId === null) throw new Error(`${name}: payload has no priorActionItemId`);

      const entry = deps.catalog.get(IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE);
      if (entry === undefined) {
        throw new Error(
          `${name}: '${IDG_CARRY_FORWARD_COMPLIANCE_PAYLOAD_TYPE}' is not in the alert payload catalog`,
        );
      }

      const coordinatorMembershipId = str(p.coordinatorMembershipId);
      const coordinatorUserId =
        coordinatorMembershipId === null
          ? null
          : await deps.membershipUserId(event.organizationId, coordinatorMembershipId);

      const payload: Record<string, unknown> = {
        organizationId: event.organizationId,
        priorActionItemId,
        carryForwardCount: count,
        severity: "critical",
        recipients: {
          complianceInbox: true,
          ...(coordinatorMembershipId === null
            ? {}
            : { idgCoordinatorMembershipId: coordinatorMembershipId }),
        },
        bodyTemplate: IDG_CARRY_FORWARD_COMPLIANCE_BODY,
        // Consumed by the platform rule's `role_set.userIdPaths` (the meeting coordinator's user id); ids only.
        ...(coordinatorUserId === null ? {} : { coordinatorUserId }),
      };
      if (!Value.Check(entry.payloadSchema, payload)) {
        const paths = [...Value.Errors(entry.payloadSchema, payload)].map((e) => e.path).join(", ");
        throw new Error(
          `${name}: payload fails the '${entry.payloadType}' catalog schema at: ${paths}`,
        );
      }

      // Throws on an emitter failure ⇒ the relay retries; the correlation id dedupes a redelivery after success.
      await deps.alerts.emit(event.organizationId, {
        eventType: entry.payloadType,
        severity: "critical",
        correlationId: carryForwardComplianceCorrelationId(priorActionItemId),
        payload,
      });
    },
  };
}
