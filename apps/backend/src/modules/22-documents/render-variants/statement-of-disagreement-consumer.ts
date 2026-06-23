// apps/backend/src/modules/22-documents/render-variants/statement-of-disagreement-consumer.ts — M22-T09 (§7.5 W5).
//
// The §164.526 Statement-of-Disagreement pipeline (D13): M5 emits `m5.patient.amendment_decided` for EVERY
// amendment outcome; M22 renders the SoD ONLY when `decision='denied'`. The rendered `document` carries
// `attach_to_disclosures=true` and the `original_amendment_request_id` tag so M5 / M28 + M22's outbound-disclosure
// subsetter attach the statement to every subsequent disclosure of the underlying record. On a completed render
// M22 emits `m22.document.statement_of_disagreement_published` (the §4.10 SoD signal) in addition to the standard
// `m22.document.rendered` back-ref M5 stamps.
//
// PURE: the decision/redaction-free shaping is `@wardenx/forms`' `buildStatementOfDisagreementPayload` (returns
// `null` for any non-denied decision); this file adds the org/patient guard, the render directive, and the
// SoD-published outbox intent. The live boot wiring runs the render + publishes the intents in one transaction.

import {
  buildStatementOfDisagreementPayload,
  type StatementOfDisagreementRenderPayload,
} from "@wardenx/forms";
import type { OrgScope } from "@wardenx/types";

/** The resolved Statement-of-Disagreement render plan, or a skip (non-denied / malformed / non-SoD event). */
export type StatementOfDisagreementResolution =
  | {
      readonly status: "render";
      readonly scope: OrgScope;
      readonly amendmentRequestId: string;
      readonly patientId: string;
      readonly payload: StatementOfDisagreementRenderPayload;
    }
  /** The amendment was approved/withdrawn (no SoD), the event is not the M5 decision, or the payload is malformed. */
  | { readonly status: "skip" };

function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Resolve `m5.patient.amendment_decided` to its Statement-of-Disagreement render plan (§7.5 W5 / D13), or `skip`
 * when the event is not the M5 decision, the decision is not `'denied'`, or the payload lacks org/patient/amendment
 * id. The SoD shaping (`attach_to_disclosures=true`, the `original_amendment_request_id` tag, compliance retention)
 * is the pure `@wardenx/forms` builder. Pure.
 */
export function resolveStatementOfDisagreement(
  eventName: string,
  payload: unknown,
): StatementOfDisagreementResolution {
  if (eventName !== "m5.patient.amendment_decided") return { status: "skip" };
  const rec = (payload ?? {}) as Record<string, unknown>;
  const organizationId = str(rec, "organizationId");
  const patientId = str(rec, "patientId");
  const amendmentRequestId = str(rec, "amendmentRequestId");
  const decision = str(rec, "decision");
  if (!organizationId || !patientId || !amendmentRequestId || !decision) return { status: "skip" };

  const built = buildStatementOfDisagreementPayload({
    amendmentRequestId,
    patientId,
    decision,
    statementText: str(rec, "statementText"),
    denialReason: str(rec, "denialReason"),
  });
  if (built === null) return { status: "skip" };
  return { status: "render", scope: { orgId: organizationId }, amendmentRequestId, patientId, payload: built };
}

/** The §4.10 outbox intent M22 publishes once the SoD render completes (in addition to `m22.document.rendered`). */
export interface StatementOfDisagreementPublishedEvent {
  readonly eventName: "m22.document.statement_of_disagreement_published";
  readonly payload: {
    readonly documentId: string;
    readonly organizationId: string;
    readonly patientId: string;
    readonly originalAmendmentRequestId: string;
  };
}

/**
 * Describe the SoD-published outbox intent for a completed render (§7.5 step 5). The live dispatcher publishes this
 * alongside the standard `m22.document.rendered` back-ref so M5's disclosure-assembly reader can find the statement
 * via `DocumentReader.listAttachToDisclosures(patientId)`. Pure.
 */
export function statementOfDisagreementPublishedEvent(
  plan: Extract<StatementOfDisagreementResolution, { status: "render" }>,
  documentId: string,
): StatementOfDisagreementPublishedEvent {
  return {
    eventName: "m22.document.statement_of_disagreement_published",
    payload: {
      documentId,
      organizationId: plan.scope.orgId,
      patientId: plan.patientId,
      originalAmendmentRequestId: plan.amendmentRequestId,
    },
  };
}
