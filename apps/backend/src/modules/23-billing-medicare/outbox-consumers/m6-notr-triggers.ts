// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m6-notr-triggers.ts — the NOTR draft, and
// the first thing that has ever written `notr_record` (F-107 / #103).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// The Notice of Termination/Revocation is the filing that tells Medicare a beneficiary's hospice election
// has ENDED. 42 CFR 418.26 requires it within FIVE CALENDAR DAYS of the discharge or revocation effective
// date, and the M23 spec's own regulatory table names it: "NOTR submitted within 5 calendar days of the
// discharge/revocation effective date".
//
// `NotrRepository.create` had no caller anywhere in the repository — the NOE finding (F-106) with a second
// table. `schema.notrRecord` is touched only by M23's ABAC resolver and its eraser; `/api/v1/billing/
// notr-records` is a GET list and the only POST is `:id:submit`, which loads an existing row. So no NOTR
// has ever been drafted, the `notr_window_watch_idx` watchdog has always scanned an empty table, and the
// §11.A rule that binds a claim to its notice had nothing to read.
//
// ── THE THREE TRIGGERS, AND THE TWO THAT NEEDED A DECISION ──────────────────────────────────────────
//
// The spec (§2, §4.4) lists exactly three: `m6.revocation.created`, `m6.transfer.created` DIRECTION-OUT,
// and `m6.discharge.created`. The `notr_record` CHECK constraints make the trigger and its event id one
// fact — `trigger_kind = 'revocation' AND revocation_event_id IS NOT NULL`, and exactly one of the three
// id columns may be set — so the mapping is enforced by the schema, not just by this file.
//
//   • TRANSFER — direction `in` is a deliberate no-op: a transfer IN starts a benefit here, it does not
//     end one. Only `out` terminates the election. This is the one topic whose payload could not carry
//     the filing date: `notr_record.effective_end_date` is NOT NULL and `m6.transfer.created` published
//     `{transferEventId, admissionId, direction, otherHospiceCcn}` and no date at all. It is NOT
//     derivable here — `transferOut` discharges the admission through `dischargeAdmissionTx`, which
//     stamps `admission.discharged_at = now()`, the instant the paperwork was filed rather than the day
//     the transfer took effect, and dating a federal filing from the wrong one is the exact failure the
//     5-day rule punishes. `transfer_event.effective_at` is NOT NULL and both emit sites had
//     `input.effectiveDate` in hand, so the payload is widened producer-side (the F-099/F-100 shape).
//
//   • DISCHARGE — gated on `requiresMedicalDirectorCosign === false`, and that flag is exactly the right
//     discriminator rather than a proxy for one. W-DC-02: filing a for-cause discharge does NOT discharge
//     the admission; the `discharge_event` row is `pending_cosign` and the patient stays on service until
//     a medical director signs. A NOTR filed then would tell CMS the benefit ended while the agency is
//     still being paid to provide it. `discharge()`'s pending-cosign branch emits the event with `true`;
//     `dischargeAdmissionTx` — which runs on the immediate path AND again from `cosignDischarge` — always
//     emits `false`, because by then the admission is actually being discharged. So the for-cause NOTR
//     fires at COSIGN time, off the second emission, with the same `dischargeEventId`. Nothing needs to
//     subscribe to `m6.discharge.cosigned` (whose payload carries no admission, patient or date anyway).
//
// A DEATH discharge drafts a NOTR like any other. The spec's trigger list carves out no reason, 418.26 is
// written about the benefit ending rather than about why, and the asymmetry of the two mistakes is not
// close: an unnecessary NOTR is cancelled at the MAC, a missing one forfeits payment.
//
// Idempotency is `notr_unique_by_event_uq` — UNIQUE on the three event-id columns over the non-terminal
// states — plus the pre-read below. The for-cause path is the case that needs it: the same
// `dischargeEventId` arrives twice, once refused by the cosign gate and once accepted.
//
// Event names are STRING literals and no M6 schema is imported; the admission facts arrive through an
// INJECTED port the composition root binds to M6's org-explicit `admissionSchedulingContextForOrg`.
import { deriveControlNumber, repositories } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import type { BillingDb, WriteOutboxPort } from "../services/claim-state-service";

/** §418.26 — the NOTR filing window, in calendar days from the termination effective date. */
export const NOTR_FILING_WINDOW_DAYS = 5;

/** The three M6 topics that can end an election, and the `notr_record.trigger_kind` each maps to. */
export const M23_NOTR_TRIGGER_BY_EVENT = {
  "m6.revocation.created": "revocation",
  "m6.transfer.created": "transfer_out",
  "m6.discharge.created": "discharge",
} as const;

export type NotrTriggerKind =
  (typeof M23_NOTR_TRIGGER_BY_EVENT)[keyof typeof M23_NOTR_TRIGGER_BY_EVENT];

/** The event set M23 drafts NOTRs from, and the `(eventId, consumerName)` receipt identity. One consumer
 *  name across all three on purpose: the receipt is per (event row, consumer), and this is one behaviour. */
export const M23_NOTR_DRAFT_CONSUMER = {
  consumerName: "m23.m6-notr-triggers",
  eventNames: Object.keys(M23_NOTR_TRIGGER_BY_EVENT),
} as const;

/** The M6-owned admission facts the draft needs, org-explicit (the §4.7 seam is request-scoped). */
export type AdmissionSitingResolver = (
  organizationId: string,
  admissionId: string,
) => Promise<{
  readonly patientId: string;
  readonly providerEntityId: string | null;
} | null>;

/** The 6-char CCN the D4 control number is derived from — the `ProviderCcnPort` shape. */
export type CcnResolver = (organizationId: string, providerEntityId: string) => Promise<string>;

export interface M23NotrDraftConsumerDeps {
  readonly db: BillingDb;
  /** The catalog-validating `m23` tx publisher — `m23.notr.draft_created` is emitted on the insert's own
   *  transaction, so a draft cannot exist without its announcement. */
  readonly outbox: WriteOutboxPort;
  readonly resolveAdmission: AdmissionSitingResolver;
  readonly resolveCcn: CcnResolver;
  /** Sink for a delivery that deliberately wrote nothing. A skip is a SETTLED decision — the outbox row
   *  completes — so without this it would be silent. Not the DLQ path (that is a throw). */
  readonly onSkipped?: (info: {
    readonly reason: "transfer_in" | "awaiting_cosign" | "already_drafted";
    readonly eventType: string;
    readonly organizationId: string;
    readonly admissionId: string;
  }) => void;
}

/** `effectiveEndDate + 5 days` as a `yyyy-mm-dd`. Calendar days, per 42 CFR 418.26 — not business days. */
export function notrWindowTargetAt(effectiveEndDate: string): string {
  const ms = Date.parse(`${effectiveEndDate}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`notrWindowTargetAt: malformed date '${effectiveEndDate}'`);
  }
  return new Date(ms + NOTR_FILING_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What one delivery resolved to: the trigger's own event id, the termination date, or a reason to skip. */
type Plan =
  | { readonly kind: "skip"; readonly reason: "transfer_in" | "awaiting_cosign" }
  | {
      readonly kind: "draft";
      readonly trigger: NotrTriggerKind;
      readonly admissionId: string;
      readonly effectiveEndDate: string;
      readonly revocationEventId: string | null;
      readonly transferEventId: string | null;
      readonly dischargeEventId: string | null;
    };

/**
 * Route one delivered M6 topic to its NOTR plan. PURE — no DB, no clock — so the three branches and the
 * two skip conditions are assertable without a database.
 */
export function planNotrDraft(eventType: string, payload: unknown): Plan {
  const admissionId = field(payload, "admissionId");
  if (admissionId === null) {
    throw new Error(`${M23_NOTR_DRAFT_CONSUMER.consumerName}: ${eventType} carries no admissionId`);
  }

  if (eventType === "m6.revocation.created") {
    const revocationEventId = field(payload, "revocationEventId");
    const effectiveEndDate = field(payload, "revocationDate");
    if (revocationEventId === null || effectiveEndDate === null) {
      throw new Error(
        `${M23_NOTR_DRAFT_CONSUMER.consumerName}: ${eventType} is missing its revocation facts`,
      );
    }
    return {
      kind: "draft",
      trigger: "revocation",
      admissionId,
      effectiveEndDate,
      revocationEventId,
      transferEventId: null,
      dischargeEventId: null,
    };
  }

  if (eventType === "m6.transfer.created") {
    // A transfer IN starts a benefit here; it does not end one.
    if (field(payload, "direction") !== "out") return { kind: "skip", reason: "transfer_in" };
    const transferEventId = field(payload, "transferEventId");
    const effectiveEndDate = field(payload, "effectiveAt");
    if (transferEventId === null || effectiveEndDate === null) {
      throw new Error(
        `${M23_NOTR_DRAFT_CONSUMER.consumerName}: ${eventType} is missing its transfer facts`,
      );
    }
    return {
      kind: "draft",
      trigger: "transfer_out",
      admissionId,
      effectiveEndDate,
      revocationEventId: null,
      transferEventId,
      dischargeEventId: null,
    };
  }

  // m6.discharge.created — W-DC-02: a filing awaiting a medical-director cosign has NOT ended the
  // benefit. The cosign re-emits this event with the flag false, and that emission drafts the notice.
  if ((payload as Record<string, unknown>)?.requiresMedicalDirectorCosign === true) {
    return { kind: "skip", reason: "awaiting_cosign" };
  }
  const dischargeEventId = field(payload, "dischargeEventId");
  const effectiveEndDate = field(payload, "dischargeDate");
  if (dischargeEventId === null || effectiveEndDate === null) {
    throw new Error(
      `${M23_NOTR_DRAFT_CONSUMER.consumerName}: ${eventType} is missing its discharge facts`,
    );
  }
  return {
    kind: "draft",
    trigger: "discharge",
    admissionId,
    effectiveEndDate,
    revocationEventId: null,
    transferEventId: null,
    dischargeEventId,
  };
}

/** M23's live NOTR-draft binding (§4.4, task 50 / 42 CFR 418.26). */
export function buildM23NotrDraftConsumer(deps: M23NotrDraftConsumerDeps) {
  return {
    consumerName: M23_NOTR_DRAFT_CONSUMER.consumerName,
    consumerModule: "m23" as const,
    eventTypes: [...M23_NOTR_DRAFT_CONSUMER.eventNames],
    async handle(event: {
      readonly organizationId: string;
      readonly eventType: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const plan = planNotrDraft(event.eventType, event.payload);
      if (plan.kind === "skip") {
        deps.onSkipped?.({
          reason: plan.reason,
          eventType: event.eventType,
          organizationId,
          admissionId: field(event.payload, "admissionId") ?? "",
        });
        return;
      }

      const admission = await deps.resolveAdmission(organizationId, plan.admissionId);
      if (admission === null) {
        throw new Error(
          `${M23_NOTR_DRAFT_CONSUMER.consumerName}: admission ${plan.admissionId} not found in org`,
        );
      }
      if (admission.providerEntityId === null) {
        throw new Error(
          `${M23_NOTR_DRAFT_CONSUMER.consumerName}: admission ${plan.admissionId} has no provider entity to bill under`,
        );
      }
      const providerEntityId = admission.providerEntityId;
      const ccn = await deps.resolveCcn(organizationId, providerEntityId);

      await withOrgContext(deps.db as never, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as BillingDb;
        const notrs = new repositories.NotrRepository(tx);
        const triggerEventId =
          plan.revocationEventId ?? plan.transferEventId ?? plan.dischargeEventId;
        if (triggerEventId === null) {
          throw new Error(`${M23_NOTR_DRAFT_CONSUMER.consumerName}: no trigger event id resolved`);
        }
        // The pre-read is what lets a redelivery report `already_drafted` instead of raising a
        // constraint error; `notr_unique_by_event_uq` is the structural backstop it cannot replace,
        // because a pre-read races a concurrent delivery.
        if (await notrs.findActiveByEvent(plan.trigger, triggerEventId)) {
          deps.onSkipped?.({
            reason: "already_drafted",
            eventType: event.eventType,
            organizationId,
            admissionId: plan.admissionId,
          });
          return;
        }

        const windowTargetAt = notrWindowTargetAt(plan.effectiveEndDate);
        // The D4 deterministic control number, keyed on the TRIGGER's own event id so a redelivery
        // reproduces the same string rather than drifting per attempt.
        const notrControlNumber = deriveControlNumber({
          ccn,
          serviceFrom: plan.effectiveEndDate,
          claimId: triggerEventId,
          attemptIndex: 0,
        });

        const created = await notrs.create({
          organizationId,
          providerEntityId,
          patientId: admission.patientId,
          admissionId: plan.admissionId,
          triggerKind: plan.trigger,
          revocationEventId: plan.revocationEventId,
          transferEventId: plan.transferEventId,
          dischargeEventId: plan.dischargeEventId,
          effectiveEndDate: plan.effectiveEndDate,
          windowTargetAt,
          notrControlNumber,
        });

        await deps.outbox.publish(tx, {
          eventName: "m23.notr.draft_created",
          organizationId,
          aggregateKind: "notr_record",
          aggregateId: created.id,
          // Field names are the CATALOG's — `terminationEffectiveDate`, not the column's
          // `effective_end_date`. The publisher `Value.Check`s this and rolls the insert back on a
          // mismatch, which is what caught the first draft of this payload.
          payload: {
            notrId: created.id,
            providerEntityId,
            admissionId: plan.admissionId,
            terminationEffectiveDate: plan.effectiveEndDate,
            windowTargetAt,
          },
        });
      });
    },
  };
}
