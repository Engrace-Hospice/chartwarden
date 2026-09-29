// apps/backend/src/modules/13-emar/outbox-consumers/m6-reconciliation-triggers.ts — the §2.8 D17
// medication-reconciliation worksheet, opened from M6's four trigger events (F-152, #248).
//
// `decideReconciliationTrigger` + `buildReconciliationWorksheet` (`../consumers/index.ts` /
// `@wardenx/emar`) have been complete, pure, unit-tested cores since M13-T06/T08, and
// `M13_OUTBOX_SUBSCRIPTIONS` has named all four M6 events (`admission.activated`, `transfer.created`,
// `discharge.created`, `cti.signed`) with a real consumer each since the list was written. **No
// `OutboxConsumerBinding` existed for any of them** — the header on `consumers/index.ts` said "the live
// boot wiring... binds the handler to the dispatcher" in the future tense, and nothing ever did. One
// layer below that: there was no INSERT into `medication_reconciliation_worksheet` anywhere in the
// repository. CMS's CoP 418.54 comprehensive-assessment reconciliation window (5 calendar days on
// admission/recertification, 24h on transfer/discharge) has never actually opened a worksheet for any
// admission in any deployment.
//
// M13's manifest `dependsOn` is `[1, 12, 36, 38]` — NOT 6 — so this consumer cannot import M6's seam
// directly; `resolveAdmission` is an injected dependency the composition root satisfies with M6's
// org-explicit `admissionSchedulingContextForOrg` (the §4.7 seam pins the tenant from the ambient
// request scope and a relay tick is not a request — the F-105/F-150 precedent). That read also supplies
// `providerEntityId`/`locationId`, which the three-column tenancy rule requires on
// `medication_reconciliation_worksheet` and which none of the four M6 payloads carry (F-192, #248 widened
// `m6.transfer.created` with a `patientId` for M22's own render handshake, but `providerEntityId`/
// `locationId` are still absent from every one of the four, so `resolveAdmission` stays the read this
// consumer needs regardless).
//
// A consumer-driven write names no acting membership (F-102's `CONSUMER_USER_ID` convention) — there is
// none to name here regardless: `medication_reconciliation_worksheet.finalized_by_membership_id` is the
// only actor column on the table, and it is set later, by the clinician who actually works the worksheet,
// never at open time.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { AdmissionId, IsoInstant, PatientId, ReconciliationWorksheetId } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { M6_RECONCILIATION_TRIGGER_KIND, decideReconciliationTrigger } from "../consumers/index";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const WS = schema.medicationReconciliationWorksheets;

/** §3.3 — a consumer-driven write names no acting membership (F-102). */
const CONSUMER_USER_ID = "";

export const M13_RECONCILIATION_TRIGGER_CONSUMER = {
  eventNames: Object.keys(M6_RECONCILIATION_TRIGGER_KIND),
  consumerName: "m13.reconciliation-trigger",
} as const;

/** The admission facts M6 supplies (org-explicit read, injected — M13 does not depend on M6).
 *  `providerEntityId`/`locationId` mirror `admission`'s own nullable columns exactly (ARCH-011) —
 *  widened here rather than assumed non-null, the F-152 gap this file's own verification caught. */
export interface AdmissionAnchor {
  readonly patientId: PatientId;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

export interface ReconciliationTriggerDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly resolveAdmission: (
    organizationId: string,
    admissionId: string,
  ) => Promise<AdmissionAnchor | null>;
}

/** Pull `admissionId` + the per-event trigger instant out of one of the four M6 payload shapes. */
function factsOf(
  eventType: string,
  payload: unknown,
): { admissionId: AdmissionId; triggeredAt: IsoInstant } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M13_RECONCILIATION_TRIGGER_CONSUMER.consumerName}: ${eventType} payload has no ${key}`);
    }
    return value;
  };
  const admissionId = read("admissionId") as AdmissionId;
  const instantField: Record<string, string> = {
    "m6.admission.activated": "activatedAt",
    "m6.transfer.created": "effectiveAt",
    "m6.discharge.created": "dischargeDate",
    "m6.cti.signed": "signedAt",
  };
  const field = instantField[eventType];
  if (!field) throw new Error(`${M13_RECONCILIATION_TRIGGER_CONSUMER.consumerName}: unknown event ${eventType}`);
  return { admissionId, triggeredAt: read(field) as IsoInstant };
}

/**
 * M13's live binding for the four §2.8 D17 M6 reconciliation triggers.
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and —
 * `recon_ws_admission_trigger_uk`, the UNIQUE (org, admission, triggerKind, triggerOutboxEventId) index —
 * absorbed by `.onConflictDoNothing()` rather than a pre-read alone, the same "the index is the real
 * idempotency floor, the pre-read only avoids a wasted insert" reasoning F-105's bereavement intake uses.
 */
export function buildM13ReconciliationTriggerConsumer(deps: ReconciliationTriggerDeps) {
  return {
    consumerName: M13_RECONCILIATION_TRIGGER_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: M13_RECONCILIATION_TRIGGER_CONSUMER.eventNames,
    async handle(event: {
      readonly eventType: string;
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const triggerKind = M6_RECONCILIATION_TRIGGER_KIND[event.eventType];
      if (!triggerKind) return; // defensive; the dispatcher only routes the four subscribed names here
      const facts = factsOf(event.eventType, event.payload);
      const organizationId = event.organizationId;

      const anchor = await deps.resolveAdmission(organizationId, facts.admissionId);
      if (!anchor) {
        throw new Error(
          `${M13_RECONCILIATION_TRIGGER_CONSUMER.consumerName}: no M6 admission context for ${facts.admissionId}`,
        );
      }
      // admission.provider_entity_id / .location_id are both nullable (ARCH-011);
      // medication_reconciliation_worksheet's are both NOT NULL (the three-column tenancy rule).
      // Dead-letter for a human rather than guess either — the same "refuse rather than fabricate"
      // posture m6-bereavement-eligible.ts takes on an unresolved death fact. This has never been
      // exercised (no worksheet has ever been written), so whether a real admission can reach one of
      // these four trigger events with no siting assigned is unconfirmed.
      const { providerEntityId, locationId } = anchor;
      if (providerEntityId === null || locationId === null) {
        throw new Error(
          `${M13_RECONCILIATION_TRIGGER_CONSUMER.consumerName}: admission ${facts.admissionId} has no ` +
            `${providerEntityId === null ? "provider entity" : "location"} assigned; cannot open a worksheet`,
        );
      }

      const worksheetId = crypto.randomUUID() as ReconciliationWorksheetId;
      const plan = decideReconciliationTrigger(event.eventType, {
        worksheetId,
        patientId: anchor.patientId,
        admissionId: facts.admissionId,
        triggerOutboxEventId: event.id,
        triggeredAt: facts.triggeredAt,
      });
      if (!plan) return;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const existing = await tx
            .select({ id: WS.id })
            .from(WS)
            .where(
              and(
                eq(WS.organizationId, organizationId),
                eq(WS.admissionId, facts.admissionId),
                eq(WS.triggerKind, triggerKind),
                eq(WS.triggerOutboxEventId, event.id),
              ),
            )
            .limit(1);
          if (existing.length > 0) return; // idempotent redelivery — the unique index backstops this too

          await tx
            .insert(WS)
            .values({
              id: worksheetId,
              organizationId,
              providerEntityId,
              locationId,
              patientId: plan.worksheet.patientId,
              admissionId: plan.worksheet.admissionId,
              triggerKind: plan.worksheet.triggerKind,
              triggerOutboxEventId: plan.worksheet.triggerOutboxEventId,
              triggeredAt: new Date(plan.worksheet.triggeredAt),
              dueAt: new Date(plan.worksheet.dueAt),
              status: plan.worksheet.status,
            })
            .onConflictDoNothing();

          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m13.reconciliation.opened",
            aggregateKind: "medication_reconciliation_worksheet",
            aggregateId: worksheetId,
            payload: {
              worksheetId: plan.openedSignal.worksheetId,
              patientId: plan.openedSignal.patientId,
              admissionId: plan.openedSignal.admissionId,
              triggerKind: plan.openedSignal.triggerKind,
              dueAt: plan.openedSignal.dueAt,
            },
          });
        },
      );
    },
  };
}
