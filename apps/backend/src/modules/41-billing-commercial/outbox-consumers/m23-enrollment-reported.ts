// apps/backend/src/modules/41-billing-commercial/outbox-consumers/m23-enrollment-reported.ts — M41's consumer of
// `m23.clearinghouse.enrollment_reported` (ADR-0053 amendment D7). It records an ADVISORY report for staff to confirm; it never
// writes commercial_payer_enrollment, so no send gate opens on a vendor's word. Idempotent on the event's sourceEventKey (the
// receipt and the publish are separate transactions upstream). A payload this consumer cannot read is skipped, never retried.
import type { DbClient } from "@chartwarden/db";
import { CLEARINGHOUSE_ENROLL_TYPE_VALUES, type ClearinghouseEnrollType } from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { recordEnrollmentReport } from "../services/enrollment-report-service";

export const M41_ENROLLMENT_REPORT_EVENT = "m23.clearinghouse.enrollment_reported";

/** The ids-only notice billing staff get (M36 alert `clearinghouse.enrollment_reported`). */
export interface EnrollmentReportAlertPort {
  emit(input: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly sourceEventKey: string;
  }): Promise<void>;
}

export interface M41EnrollmentReportConsumerDeps {
  readonly db: DbClient;
  readonly alerts?: EnrollmentReportAlertPort;
  readonly onSkipped?: (info: {
    readonly reason: "unreadable_payload";
    readonly organizationId: string;
  }) => void;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const ENROLL_TYPES = new Set<string>(CLEARINGHOUSE_ENROLL_TYPE_VALUES);

export function buildM41EnrollmentReportConsumer(
  deps: M41EnrollmentReportConsumerDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m41.m23-enrollment-reported",
    consumerModule: "m41",
    eventTypes: [M41_ENROLLMENT_REPORT_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      if (event.eventType !== M41_ENROLLMENT_REPORT_EVENT) return;
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const sourceEventKey = str(p.sourceEventKey);
      const providerEntityId = str(p.providerEntityId);
      const vendor = str(p.vendor);
      const vendorStatus = str(p.vendorStatus);
      const reportedAt = str(p.reportedAt);
      const enrollType = str(p.enrollType);
      if (
        !sourceEventKey ||
        !providerEntityId ||
        !vendor ||
        !vendorStatus ||
        !reportedAt ||
        !enrollType ||
        !ENROLL_TYPES.has(enrollType)
      ) {
        deps.onSkipped?.({ reason: "unreadable_payload", organizationId: event.organizationId });
        return;
      }
      const outcome = await recordEnrollmentReport(deps.db, event.organizationId, {
        sourceEventKey,
        vendor,
        providerEntityId,
        enrollType: enrollType as ClearinghouseEnrollType,
        vendorStatus,
        vendorEnrollId: str(p.vendorEnrollId),
        clearinghousePayerId: str(p.clearinghousePayerId),
        reportedAt,
        eventTime: str(p.eventTime),
      });
      if (outcome === "recorded") {
        await deps.alerts?.emit({
          organizationId: event.organizationId,
          providerEntityId,
          sourceEventKey,
        });
      }
    },
  };
}
