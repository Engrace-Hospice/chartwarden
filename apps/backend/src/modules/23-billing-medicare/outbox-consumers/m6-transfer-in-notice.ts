// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m6-transfer-in-notice.ts — the RECEIVING
// hospice's Medicare transfer notice (TOB 8xC) draft, off `m6.transfer.created` direction `in`.
//
// CMS Pub. 100-04 ch. 11 §20.1.3 (Rev. 12847): "The admitting hospice submits a transfer notice after the
// transfer has occurred and the beneficiary's hospice benefit is not affected." A transfer-in continues a
// benefit period begun elsewhere, which is why the NOE draft (`m6-election-period-started.ts`) deliberately
// SKIPS the inherited period — an 8xA would open a new election; the 8xC "creates" none (§20.1.6 summary
// chart). This consumer is the other half of that decision: it drafts the 8xC that period needs.
//
// It only DRAFTS. The notice is held in DRAFT until staff confirm the transferring hospice "has finalized
// their billing" (§20.1.3) — a fact no system of ours can observe — and every other §20.1.3 rule passes
// (`evaluateTransferNotice`). There is no 5-day clock to race: CGS's CR 8877 FAQ ("Are hospice transfers and
// the billing of 81C or 82C subject to the 5-day timely filing requirement? No ...").
//
// The NOTR consumer (`m6-notr-triggers.ts`) binds the same topic for direction `out`; this is a second,
// separately-receipted binding (its own consumer name) for direction `in`. The M6 facts arrive through an
// INJECTED org-explicit port (`transferInNoticeContextForOrg`); no M6 schema is imported.
import { randomUUID } from "node:crypto";
import { deriveControlNumber, repositories, transferNoticeTob } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BillingDb, WriteOutboxPort } from "../services/claim-state-service";

export const M23_TRANSFER_NOTICE_DRAFT_CONSUMER = {
  eventName: "m6.transfer.created",
  consumerName: "m23.m6-transfer-in-notice",
} as const;

/** The M6 transfer-in facts the draft snapshots (structurally `TransferInNoticeContext`). */
export interface TransferInFacts {
  readonly transferEventId: string;
  readonly direction: "in" | "out";
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly effectiveAt: string;
  readonly counterpartyName: string | null;
  readonly counterpartyCcn: string | null;
  readonly counterpartyNpi: string | null;
  readonly periodSequenceAtTransfer: number;
  readonly inheritedElectionPeriodId: string | null;
  readonly inheritedPeriodStart: string | null;
  readonly admissionDate: string | null;
  readonly attendingPhysicianId: string | null;
  readonly hospicePhysicianId: string | null;
}

export type TransferInFactsResolver = (
  organizationId: string,
  transferEventId: string,
) => Promise<TransferInFacts | null>;

export type CcnResolver = (organizationId: string, providerEntityId: string) => Promise<string>;

export interface M23TransferNoticeDraftConsumerDeps {
  readonly db: BillingDb;
  /** The catalog-validating `m23` tx publisher; `m23.transfer_notice.draft_created` rides the insert's tx. */
  readonly outbox: WriteOutboxPort;
  readonly resolveTransferIn: TransferInFactsResolver;
  readonly resolveCcn: CcnResolver;
  readonly onSkipped?: (info: {
    readonly reason: "transfer_out" | "already_drafted";
    readonly organizationId: string;
    readonly transferEventId: string;
  }) => void;
}

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The snapshot an original 8xC is drafted with. PURE (no DB, no clock). */
export function planTransferNoticeDraft(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly facts: TransferInFacts;
  readonly providerEntityId: string;
  readonly providerCcn: string;
}): repositories.NewTransferNoticeInput {
  const { facts } = input;
  return {
    id: input.id,
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    locationId: facts.locationId,
    patientId: facts.patientId,
    admissionId: facts.admissionId,
    transferEventId: facts.transferEventId,
    electionPeriodId: facts.inheritedElectionPeriodId,
    action: "original",
    supersedesNoticeId: null,
    // No WardenX provider entity is flagged hospital-based; claims are TOB 81x throughout (tob/derivation.ts).
    tob: transferNoticeTob("81", "original") as "81C",
    statementFromDate: facts.effectiveAt,
    originalTransferDate: null,
    admissionDate: facts.admissionDate,
    benefitPeriodSequence: facts.periodSequenceAtTransfer,
    benefitPeriodStartDate: facts.inheritedPeriodStart,
    priorHospiceName: facts.counterpartyName ?? "Unknown transferring hospice",
    priorHospiceCcn: facts.counterpartyCcn,
    priorHospiceNpi: facts.counterpartyNpi,
    providerCcn: input.providerCcn,
    attendingPhysicianId: facts.attendingPhysicianId,
    certifyingPhysicianId: facts.hospicePhysicianId,
    controlNumber: deriveControlNumber({
      ccn: input.providerCcn,
      serviceFrom: facts.effectiveAt,
      // The row's own pre-generated id seeds the opaque segment (a redraft gets a fresh id → a fresh number).
      claimId: input.id as never,
      attemptIndex: 0,
    }),
  };
}

export function buildM23TransferNoticeDraftConsumer(deps: M23TransferNoticeDraftConsumerDeps) {
  return {
    consumerName: M23_TRANSFER_NOTICE_DRAFT_CONSUMER.consumerName,
    consumerModule: "m23" as const,
    eventTypes: [M23_TRANSFER_NOTICE_DRAFT_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const transferEventId = field(event.payload, "transferEventId");
      if (transferEventId === null) {
        throw new Error(
          `${M23_TRANSFER_NOTICE_DRAFT_CONSUMER.consumerName}: payload has no transferEventId`,
        );
      }
      // A transfer OUT ends our benefit (the NOTR consumer's business); only the receiving side files an 8xC.
      if (field(event.payload, "direction") !== "in") {
        deps.onSkipped?.({ reason: "transfer_out", organizationId, transferEventId });
        return;
      }
      const facts = await deps.resolveTransferIn(organizationId, transferEventId);
      if (facts === null) {
        throw new Error(
          `${M23_TRANSFER_NOTICE_DRAFT_CONSUMER.consumerName}: transfer event ${transferEventId} not found in org`,
        );
      }
      if (facts.providerEntityId === null) {
        throw new Error(
          `${M23_TRANSFER_NOTICE_DRAFT_CONSUMER.consumerName}: admission ${facts.admissionId} has no provider entity to file under`,
        );
      }
      const providerEntityId = facts.providerEntityId;
      const providerCcn = await deps.resolveCcn(organizationId, providerEntityId);

      await withOrgContext(deps.db as never, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as BillingDb;
        const notices = new repositories.TransferNoticeRepository(tx);
        // The pre-read reports a redelivery as settled; `transfer_notice_original_uq` is the race backstop.
        if (await notices.findLiveOriginalByTransferEvent(transferEventId)) {
          deps.onSkipped?.({ reason: "already_drafted", organizationId, transferEventId });
          return;
        }
        const created = await notices.create(
          planTransferNoticeDraft({
            id: randomUUID(),
            organizationId,
            facts,
            providerEntityId,
            providerCcn,
          }),
        );
        await deps.outbox.publish(tx, {
          eventName: "m23.transfer_notice.draft_created",
          organizationId,
          aggregateKind: "transfer_notice_record",
          aggregateId: created.id,
          payload: {
            transferNoticeId: created.id,
            providerEntityId,
            admissionId: created.admissionId,
            transferEventId,
            action: created.action,
            tob: created.tob,
            statementFromDate: created.statementFromDate,
          },
        });
      });
    },
  };
}
