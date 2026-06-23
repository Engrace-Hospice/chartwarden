// apps/backend/src/modules/22-documents/consumers/document-requested.ts — the §4.11 render-handshake
// consumer core (M22-T06). Every `*.document_requested`-family event another module emits (M5 amendment,
// M6 election/cert/discharge, M8 encounter, M11 order/labs, M12 medication, M13 eMAR, M14 IDG, M15 discipline
// plan, M16 bereavement, M17 visit confirmation, M18 EVV verification, M23 ABN, M39 consent) drives ONE render:
// M22 resolves the §4.5 `templateKey`, renders the typed payload through the published `DocumentRenderer` seam
// (§7.2 W2), and emits `m22.document.rendered` (+ `m22.document.rendered_critical_results` for D22 critical labs)
// so the source module's own `m22-document-backref` consumer stamps `document_id` on its row.
//
// This file ships the PURE decision core — {@link planDocumentRender} (event + payload → the render plan, with
// the D21 discharge-source discriminator and the M15 plan-kind / M16 letter-kind sub-layout selectors) and
// {@link dispatchDocumentRender} (run the plan through an injected renderer → the back-ref event intents). The
// live dispatcher binds each {@link M22_OUTBOX_SUBSCRIPTIONS} entry to `dispatchDocumentRender` at boot and
// publishes the returned intents on the M1 outbox in the same transaction as the render (deferred to M22-T07's
// service wiring, mirroring the M14/M12 consumer precedent). Consumer dedup is keyed on `(eventId, consumerName)`.
//
// Every consumed event name is a STRING literal: M22 reads other modules solely through the outbox + the
// `@wardenx/forms` library it OWNS (same module, M22 codePath) — this adds NO edge to M22's manifest `dependsOn`.
import { isKnownFormTemplate, lookupFormTemplate, resolveRenderRetentionClass } from "@wardenx/forms";
import type { DocumentAggregateType, DocumentRetentionClass, OrgScope } from "@wardenx/types";

/** Read a non-empty string field off an unknown payload (the events are validated by the dispatcher's schema). */
function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** True when a payload field is strictly boolean-true (D20 SUD-class / D22 critical discriminators). */
function flag(rec: Record<string, unknown>, key: string): boolean {
  return rec[key] === true;
}

/**
 * One §4.11 binding: how to turn a source event's payload into a render. `templateKey` is either a fixed key or a
 * selector (the D21 discharge-source branch, the M15 plan-kind branch) returning the key or `null` to skip.
 * `aggregateIdField` names the payload field carrying the source aggregate id (the W2 back-ref + object-key
 * dedup target). `critical` flags the D22 high-priority lab path. `sudFlagField` (when set) is the payload
 * boolean that upgrades retention to `compliance_42cfr_part2` (D23, the `lab_results_pdf` SUD path).
 */
interface DocumentRequestBinding {
  readonly templateKey: string | ((rec: Record<string, unknown>) => string | null);
  readonly aggregateIdField: string;
  readonly critical?: boolean;
  readonly sudFlagField?: string;
}

/** The D21 external-source death-discharge discriminator (§4.11.2): `source='m29_proposal_accept'` → variant. */
function dischargeTemplate(rec: Record<string, unknown>): string {
  return rec.source === "m29_proposal_accept" ? "discharge_summary_v2_external_source" : "discharge_summary";
}

/** The D21 cosigned-discharge discriminator: the external-source case renders its own cosigned variant key. */
function dischargeCosignedTemplate(rec: Record<string, unknown>): string {
  return rec.source === "m29_proposal_accept"
    ? "discharge_summary_v2_external_source_cosigned"
    : "discharge_summary";
}

/**
 * The §4.11 event → render binding table. Keyed on the canonical wire event name each source module emits; the
 * value is the {@link DocumentRequestBinding} the planner runs. Discharge variants (D21) and the M15 single
 * `plan.version_signed` event (kind-discriminated) use selector functions; bereavement is one `bereavement_letter`
 * key with a `letterKind` sub-layout carried in the payload (no separate key). M23 (`abn`) is a forward producer
 * (deny-stub until M23 lands); M39 consent is LIVE (Wave F).
 */
export const M22_DOCUMENT_REQUESTED_BINDINGS: Readonly<Record<string, DocumentRequestBinding>> = {
  // ── M5 amendment statement of disagreement (§7.5 W5) ──────────────────────────────────────────────────
  "m5.patient.amendment_decided": {
    templateKey: "patient_amendment_statement_of_disagreement",
    aggregateIdField: "amendmentRequestId",
  },
  // ── M6 admission / election / certification / discharge ───────────────────────────────────────────────
  "m6.election.signed": { templateKey: "election_statement", aggregateIdField: "electionId" },
  "m6.cti.signed": { templateKey: "cti", aggregateIdField: "ctiId" },
  "m6.f2f.attested": { templateKey: "f2f", aggregateIdField: "f2fId" },
  "m6.nor.acknowledged": { templateKey: "nor", aggregateIdField: "norId" },
  "m6.revocation.created": { templateKey: "revocation", aggregateIdField: "revocationId" },
  "m6.discharge.created": { templateKey: dischargeTemplate, aggregateIdField: "dischargeEventId" },
  "m6.discharge.cosigned": { templateKey: dischargeCosignedTemplate, aggregateIdField: "dischargeEventId" },
  "m6.transfer.created": { templateKey: "discharge_summary", aggregateIdField: "transferId" },
  // ── M8 encounter (signed + addendum → new version on the SAME document, W2) ────────────────────────────
  "m8.encounter.signed": { templateKey: "encounter_pdf", aggregateIdField: "encounterId" },
  "m8.encounter.addendum_signed": { templateKey: "encounter_pdf", aggregateIdField: "encounterId" },
  // ── M11 orders + lab results (D20 SUD redaction + D22 critical, D23 retention) ─────────────────────────
  "m11.order.document_requested": { templateKey: "order_record", aggregateIdField: "orderId" },
  "m11.order.results_received": {
    templateKey: "lab_results_pdf",
    aggregateIdField: "orderId",
    sudFlagField: "sudClass",
  },
  "m11.order.results_received_critical": {
    templateKey: "lab_results_pdf",
    aggregateIdField: "orderId",
    critical: true,
    sudFlagField: "sudClass",
  },
  // ── M12 medication order + medication list ────────────────────────────────────────────────────────────
  "m12.medication_order.document_requested": {
    templateKey: "medication_order",
    aggregateIdField: "medicationOrderId",
  },
  "m12.medication_order.list_changed": {
    templateKey: "patient_medication_list",
    aggregateIdField: "patientId",
  },
  // ── M13 eMAR reconciliation worksheet ─────────────────────────────────────────────────────────────────
  "m13.reconciliation.finalized": {
    templateKey: "medication_reconciliation_worksheet",
    aggregateIdField: "reconciliationId",
  },
  // ── M14 IDG packet + minutes ──────────────────────────────────────────────────────────────────────────
  "m14.packet.render_requested": { templateKey: "idg_patient_packet", aggregateIdField: "packetId" },
  "m14.minutes.signed": { templateKey: "idg_minutes", aggregateIdField: "minutesId" },
  // ── M15 discipline care plans (single event, kind-discriminated; the kind IS the template key) ─────────
  "m15.plan.version_signed": {
    templateKey: (rec) => str(rec, "kind"),
    aggregateIdField: "planVersionId",
  },
  // ── M16 bereavement (single `bereavement_letter` key; `letterKind` sub-layout in the payload) ──────────
  "m16.bereavement.outreach_artifact_requested": {
    templateKey: "bereavement_letter",
    aggregateIdField: "artifactRequestId",
  },
  "bereavement.anniversary_due": { templateKey: "bereavement_letter", aggregateIdField: "anniversaryId" },
  // ── M17 visit confirmation + M18 EVV verification ─────────────────────────────────────────────────────
  "m17.visit.scheduled": { templateKey: "visit_confirmation_letter", aggregateIdField: "visitId" },
  "m18.evv.aggregator_accepted": { templateKey: "evv_verification", aggregateIdField: "submissionId" },
  // ── M23 ABN (forward seam; deny-stub render until M23 lands) + M39 consent (LIVE) ──────────────────────
  "m23.abn.required": { templateKey: "abn", aggregateIdField: "abnId" },
  "m39.consent.signed": { templateKey: "consent_record", aggregateIdField: "consentRecordId" },
};

/** The render plan a §4.11 event resolves to — everything the renderer + the back-ref event need. */
export interface DocumentRenderPlan {
  readonly scope: OrgScope;
  readonly templateKey: string;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string;
  readonly patientId: string;
  /** The §4.5 floor class, upgraded to `compliance_42cfr_part2` when the source is SUD-class (D23). */
  readonly retentionClass: DocumentRetentionClass;
  /** True on the D22 critical-lab path (the consumer additionally emits `rendered_critical_results`). */
  readonly critical: boolean;
  /** The payload handed to the renderer — the original event payload with `aggregateId` normalised onto it. */
  readonly renderPayload: Record<string, unknown>;
}

/**
 * Resolve a §4.11 event + payload to its {@link DocumentRenderPlan}, or `null` when the event is not a render
 * trigger M22 handles, the template key is unknown to the platform floor, or the payload lacks the
 * `organizationId` / `patientId` / source aggregate id the §2.2.2 patient-prefixed object key requires (the
 * dispatcher logs + drops these — a malformed event must never mint a key with an empty prefix). Pure.
 */
export function planDocumentRender(eventName: string, payload: unknown): DocumentRenderPlan | null {
  const binding = M22_DOCUMENT_REQUESTED_BINDINGS[eventName];
  if (!binding) return null;
  const rec = (payload ?? {}) as Record<string, unknown>;

  const templateKey = typeof binding.templateKey === "function" ? binding.templateKey(rec) : binding.templateKey;
  if (!templateKey || !isKnownFormTemplate(templateKey)) return null;
  const entry = lookupFormTemplate(templateKey);
  if (!entry) return null;

  const organizationId = str(rec, "organizationId");
  const patientId = str(rec, "patientId");
  const aggregateId = str(rec, binding.aggregateIdField);
  if (!organizationId || !patientId || !aggregateId) return null;

  const sudClass = binding.sudFlagField ? flag(rec, binding.sudFlagField) : false;
  return {
    scope: { orgId: organizationId },
    templateKey,
    aggregateType: entry.aggregateType,
    aggregateId,
    patientId,
    retentionClass: resolveRenderRetentionClass(templateKey, { sudClass }),
    critical: binding.critical === true,
    // Normalise the source aggregate id onto the uniform `aggregateId` field the renderer reads (the forms
    // manifest resolver sets `aggregateIdField: null`), preserving the original payload for the render adapter.
    renderPayload: { ...rec, aggregateId, patientId },
  };
}

/** The §7.2 W2 render port the dispatcher runs a plan through (M22's published `DocumentRenderer` seam at boot). */
export interface DocumentRenderPort {
  render(scope: OrgScope, templateKey: string, payload: unknown): Promise<{ documentId: string }>;
}

/** A back-ref outbox intent the dispatcher publishes after a render (the source module's `document_id` stamp). */
export interface RenderedBackRefEvent {
  readonly eventName: "m22.document.rendered" | "m22.document.rendered_critical_results";
  readonly payload: Record<string, unknown>;
}

/**
 * Run a {@link DocumentRenderPlan} through the injected renderer and return the back-ref event intents the live
 * dispatcher publishes: always `m22.document.rendered` (carrying the new `documentId` + the source aggregate the
 * producer stamps), plus `m22.document.rendered_critical_results` on the D22 critical-lab path (M14 priority
 * routing). The actual outbox publish + M4 write-audit run in the boot wiring (M22-T07); this function is the
 * pure render-then-describe-effects core. Idempotency is the dispatcher's `(eventId, consumerName)` dedup.
 */
export async function dispatchDocumentRender(
  plan: DocumentRenderPlan,
  deps: { renderer: DocumentRenderPort },
): Promise<readonly RenderedBackRefEvent[]> {
  const { documentId } = await deps.renderer.render(plan.scope, plan.templateKey, plan.renderPayload);
  const events: RenderedBackRefEvent[] = [
    {
      eventName: "m22.document.rendered",
      payload: {
        documentId,
        organizationId: plan.scope.orgId,
        aggregateType: plan.aggregateType,
        aggregateId: plan.aggregateId,
        templateKey: plan.templateKey,
        retentionClass: plan.retentionClass,
      },
    },
  ];
  if (plan.critical) {
    events.push({
      eventName: "m22.document.rendered_critical_results",
      payload: {
        documentId,
        organizationId: plan.scope.orgId,
        orderId: plan.aggregateId,
        templateKey: plan.templateKey,
      },
    });
  }
  return events;
}
