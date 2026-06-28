// apps/backend/src/modules/30-quality/events-by-m30.ts — Module 30's outbox-event contributions
// (spec §4.10 Outbox Event Catalog). The full `m30.*` taxonomy keyed on M30's own resources, under the
// `m30.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this
// file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m30'), and valid declared consumers
// (real module ids); the canonical wire `eventName`s here ALL carry the `m30.` prefix the event-catalog
// gate enforces.
//
// M30 is OUTBOX-ONLY across module boundaries (architecture v0.11 §7 / ADR-0011 / ARCH-272 — there is no
// synchronous cross-module call into M30; the dependency-cruiser blocks any direct import of M30
// internals). The cross-module fan-outs target M28 (FHIR MeasureReport / AdverseEvent streams), M33
// (dashboards), M36 (alerts, §4.9), M22 (PDF render on request), M34 (tenant compliance gate), and M4
// (defensive audit). A few events are `m30`-self subscribers re-handled inside M30's own consumers
// (e.g. the infection-surveillance outbreak-detection worker). Each entry adds the TypeBox
// `payloadSchema` + declared consumers the dispatcher validates each publish against, so "DB updated but
// the event never went out" is closed in the same transaction as the mutation (transactional outbox).
// Every `event_id` is UUIDv5 over `(orgId, scope, businessKey)` for replay safety (§4.10).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
/** A `{ start, end }` period (CAHPS sample / reporting window). */
const period = Type.Object({ start: isoInstant, end: isoInstant });

export const M30_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── quality measures (§4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.measure.value_emitted",
    moduleOwner: "m30",
    description:
      "An append-only `quality_measure_value` row was inserted (recompute worker); M28 streams the FHIR MeasureReport, M33 refreshes the dashboard tile.",
    payloadSchema: Type.Object({
      orgId: id,
      measureId: id,
      periodEnd: isoInstant,
      valueId: id,
      rate: Type.Number(),
      bandColor: id,
      snapshotContentHash: id,
    }),
    declaredConsumers: ["m28", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.measure.threshold_breached",
    moduleOwner: "m30",
    description:
      "A QAPI indicator crossed its threshold (yellow→red); M36 raises the §4.9 `measure_threshold_breached` warn, M33 reflects the breach.",
    payloadSchema: Type.Object({
      orgId: id,
      indicatorId: id,
      measureId: id,
      periodEnd: isoInstant,
      rate: Type.Number(),
      threshold: Type.Number(),
      severityBand: id,
    }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── incidents (§4.10) ───────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.incident.submitted",
    moduleOwner: "m30",
    description:
      "An incident transitioned draft→submitted (R-54); M22 renders the PDF on request, M28 streams the FHIR AdverseEvent, M33 reflects it, M36 raises the sentinel/abuse §4.9 alerts.",
    payloadSchema: Type.Object({
      orgId: id,
      incidentId: id,
      kind: id,
      severity: id,
      reportedAt: isoInstant,
      hasPatientLink: Type.Boolean(),
    }),
    declaredConsumers: ["m22", "m28", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.incident.state_changed",
    moduleOwner: "m30",
    description:
      "Any incident state transition; M33 reflects it, M36 drives the overdue queue, M4 keeps a defensive audit copy (already audited inline).",
    payloadSchema: Type.Object({
      orgId: id,
      incidentId: id,
      fromState: id,
      toState: id,
      actorUserId: id,
      occurredAt: isoInstant,
    }),
    declaredConsumers: ["m33", "m36", "m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.incident.cap_overdue",
    moduleOwner: "m30",
    description:
      "A CAP action item passed its `dueAt` without a `completedAt`; M36 raises the §4.9 `cap_overdue` alert.",
    payloadSchema: Type.Object({
      orgId: id,
      incidentId: id,
      actionIndex: Type.Integer({ minimum: 0 }),
      dueAt: isoInstant,
      ownerUserId: id,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── CAHPS (§4.10) ───────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.cahps.sample_ready",
    moduleOwner: "m30",
    description:
      "The monthly cron built the prior-month decedent sample; M36 raises the §4.9 `cahps_sample_ready` info to the QAPI Coordinator.",
    payloadSchema: Type.Object({
      orgId: id,
      samplePeriod: period,
      decedentCount: Type.Integer({ minimum: 0 }),
      vendor: id,
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.cahps.export_completed",
    moduleOwner: "m30",
    description:
      "The R-14 export worker finished generating the vendor export; M33 surfaces the completion in the CAHPS widget.",
    payloadSchema: Type.Object({
      orgId: id,
      exportId: id,
      samplePeriod: period,
      vendor: id,
      status: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.cahps.results_ingested",
    moduleOwner: "m30",
    description:
      "The R-16 system route ingested aggregated vendor results; M28 streams the FHIR mapping, M33 refreshes the CAHPS result tiles.",
    payloadSchema: Type.Object({
      orgId: id,
      period,
      measuresAffected: Type.Array(id),
    }),
    declaredConsumers: ["m28", "m33"],
    isOutboxOnly: true,
  },
  // ── QAPI (§4.10) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.qapi.project_chartered",
    moduleOwner: "m30",
    description:
      "A new QAPI PI project was chartered from a triggered indicator (R-27); M33 reflects it, M22 renders the charter PDF on request.",
    payloadSchema: Type.Object({
      orgId: id,
      projectId: id,
      indicatorId: id,
      phase: Type.Literal("planned"),
    }),
    declaredConsumers: ["m33", "m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.qapi.pip_closed",
    moduleOwner: "m30",
    description:
      "A PIP cycle was closed with the two-person co-sign (R-31); M33 reflects the closure, M22 renders the minutes/outcome PDF on request.",
    payloadSchema: Type.Object({
      orgId: id,
      projectId: id,
      pipId: id,
      outcome: id,
      closedAt: isoInstant,
    }),
    declaredConsumers: ["m33", "m22"],
    isOutboxOnly: true,
  },
  // ── SRA (§4.10) ─────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.sra.cycle_opened",
    moduleOwner: "m30",
    description: "A new annual SRA cycle was opened (R-41); M33 reflects the cycle in the security dashboard.",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      fiscalYear: Type.Integer(),
      scopeTemplateVersion: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.sra.finding_added",
    moduleOwner: "m30",
    description: "A new SRA finding was added (R-43); M33 reflects the finding count / risk-band breakdown.",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      findingId: id,
      controlRef: id,
      riskBand: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.sra.cycle_closed",
    moduleOwner: "m30",
    description:
      "An SRA cycle was closed with the two-person co-sign (R-47); M33 reflects it, M34 refreshes the tenant compliance gate (SRA freshness).",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      closedAt: isoInstant,
      openFindingsAtClose: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m33", "m34"],
    isOutboxOnly: true,
  },
  // ── mortality (§4.10) ───────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.mortality.review_created",
    moduleOwner: "m30",
    description:
      "A mortality review was auto-created on `m6.discharge.death`; M33 reflects the open-review queue.",
    payloadSchema: Type.Object({
      orgId: id,
      reviewId: id,
      patientId: id,
      dateOfDeath: isoInstant,
      targetCompletionAt: nullableId,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.mortality.review_completed",
    moduleOwner: "m30",
    description: "A reviewer completed a mortality review (R-73); M33 reflects the three-dimension outcome.",
    payloadSchema: Type.Object({
      orgId: id,
      reviewId: id,
      dimensions: Type.Object({
        clinical: id,
        satisfaction: id,
        compliance: id,
      }),
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── CoP compliance (§4.10) ──────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.cop.status_changed",
    moduleOwner: "m30",
    description:
      "A CoP citation status transitioned (R-81); M33 reflects it, M34 refreshes the tenant compliance gate (CoP readiness).",
    payloadSchema: Type.Object({
      orgId: id,
      citationId: id,
      fromStatus: id,
      toStatus: id,
      lastReviewedAt: nullableId,
    }),
    declaredConsumers: ["m33", "m34"],
    isOutboxOnly: true,
  },
  // ── infection surveillance (§4.10) ──────────────────────────────────────────────────────────────
  {
    eventName: "m30.infection.event_recorded",
    moduleOwner: "m30",
    description:
      "A surveillance event was recorded (R-91); the M30 outbreak-detection worker consumes it to evaluate the ≥3-events/14d cluster threshold (self-subscriber).",
    payloadSchema: Type.Object({
      orgId: id,
      eventId: id,
      pathogen: id,
      bodySite: id,
      patientId: id,
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.infection.outbreak_opened",
    moduleOwner: "m30",
    description:
      "An infection cluster crossed the outbreak threshold; M36 raises the §4.9 `outbreak_detected` high alert, M33 reflects the outbreak.",
    payloadSchema: Type.Object({
      orgId: id,
      caseId: id,
      pathogen: id,
      bodySite: id,
      eventCount: Type.Integer({ minimum: 0 }),
      firstEventAt: isoInstant,
      lastEventAt: isoInstant,
    }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.infection.outbreak_resolved",
    moduleOwner: "m30",
    description: "An outbreak case was closed (R-93); M33 reflects the resolution.",
    payloadSchema: Type.Object({
      orgId: id,
      caseId: id,
      resolutionNote: Type.String(),
      resolvedAt: isoInstant,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── risk register (§4.10) ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.risk_register.refreshed",
    moduleOwner: "m30",
    description:
      "The `risk_register_view` materialized view was refreshed (R-96 / cron); M33 refreshes the unified risk view.",
    payloadSchema: Type.Object({
      orgId: id,
      refreshedAt: isoInstant,
      totalRows: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
