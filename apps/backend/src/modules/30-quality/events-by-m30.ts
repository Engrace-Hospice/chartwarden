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
import type { ModuleEventContribution } from "@chartwarden/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
/** GAP-046 — published only once the nominee has confirmed the close in their own session (both parties attested). */
const closeParty = Type.Object({ membershipId: id, role: id });
const closeAttestationFields = {
  closedBy: closeParty,
  nominatedCosigner: closeParty,
  cosignerAttested: Type.Literal(true),
};
/** A `{ start, end }` period (CAHPS sample / reporting window). */
const period = Type.Object({ start: isoInstant, end: isoInstant });

export const M30_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── quality measures (§4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.measure.value_emitted",
    moduleOwner: "m30",
    description:
      "An append-only `quality_measure_value` row was inserted (recompute worker); M28 projects the FHIR MeasureReport (F-115/#248: at request time, not via this event), M33 refreshes the dashboard tile.",
    payloadSchema: Type.Object({
      orgId: id,
      measureId: id,
      periodEnd: isoInstant,
      valueId: id,
      rate: Type.Number(),
      bandColor: id,
      snapshotContentHash: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
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
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── incidents (§4.10) ───────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.incident.submitted",
    moduleOwner: "m30",
    description:
      "An incident transitioned draft→submitted (R-54); M28 projects the FHIR AdverseEvent (F-115/#248: at request time, not via this event), M33 reflects it, M36 raises the sentinel/abuse §4.9 alerts.",
    payloadSchema: Type.Object({
      orgId: id,
      incidentId: id,
      kind: id,
      severity: id,
      reportedAt: isoInstant,
      hasPatientLink: Type.Boolean(),
    }),
    // F-144 (#248) — m22 REMOVED: "renders the PDF on request" is a synchronous/route-triggered
    // mechanism, not an outbox subscription to this lifecycle event — M30's own spec (§ Document
    // storage and PDF rendering) names a dedicated `m30.incident.render_requested` event for this
    // purpose, never catalogued or emitted anywhere in the codebase (a producer-side gap, reported not
    // fixed). Not in M22's own §4.11 table either.
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
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
    declaredConsumers: [],
    seamConsumers: ["m33", "m36", "m4"],
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
    declaredConsumers: [],
    seamConsumers: ["m36"],
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
    seamConsumers: [],
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
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.cahps.export_failed",
    moduleOwner: "m30",
    description:
      "The R-14 export worker exhausted its §4.8 retry budget (GAP-087); the cycle's sample rows are `export_failed` and M36 raises the §4.9 alert to the QAPI Coordinator, who re-triggers via R-14.",
    payloadSchema: Type.Object({
      orgId: id,
      samplePeriod: period,
      vendor: id,
      reason: Type.String(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.cahps.results_ingested",
    moduleOwner: "m30",
    description:
      "The R-16 system route ingested aggregated vendor results; M28 projects the FHIR mapping (F-115/#248: at request time, not via this event), M33 refreshes the CAHPS result tiles.",
    payloadSchema: Type.Object({
      orgId: id,
      period,
      measuresAffected: Type.Array(id),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── QAPI (§4.10) ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.qapi.project_chartered",
    moduleOwner: "m30",
    description:
      "A new QAPI PI project was chartered from a triggered indicator (R-27); M33 reflects it.",
    payloadSchema: Type.Object({
      orgId: id,
      projectId: id,
      indicatorId: id,
      phase: Type.Literal("planned"),
    }),
    // F-144 (#248) — m22 REMOVED: same shape as `m30.incident.submitted` above — "on request" is a
    // route-triggered mechanism, not a push off this lifecycle event. M30's spec's document-rendering
    // section names five dedicated `*.render_requested` events for its M22 handshakes (none ever
    // catalogued or emitted); this project-chartering milestone isn't the render trigger either way.
    // Not in M22's own §4.11 table.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.qapi.pip_closed",
    moduleOwner: "m30",
    description:
      "A PIP cycle was closed (R-31) once the QAPI Coordinator and Medical Director have BOTH signed (initiate + the nominee's own confirmation); M33 reflects the closure.",
    payloadSchema: Type.Object({
      orgId: id,
      // `qapi_pip.linked_project_id` is a nullable FK — a PIP need not hang off a chartered project, so the
      // event carries `null` (not an empty id) when unlinked. Matches the column's nullability (M1-T10).
      projectId: nullableId,
      pipId: id,
      outcome: id,
      closedAt: isoInstant,
      ...closeAttestationFields,
    }),
    // F-144 (#248) — m22 REMOVED: "renders the minutes/outcome PDF on request" is a route-triggered
    // mechanism, not a push off this lifecycle event — the same shape as `m30.incident.submitted` and
    // `m30.qapi.project_chartered` above. `m30.qapi_minutes.render_requested`, M30 spec's own named
    // event for this artifact, is never catalogued or emitted anywhere. Not in M22's own §4.11 table.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── SRA (§4.10) ─────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m30.sra.cycle_opened",
    moduleOwner: "m30",
    description:
      "A new annual SRA cycle was opened (R-41); M33 reflects the cycle in the security dashboard.",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      fiscalYear: Type.Integer(),
      scopeTemplateVersion: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.sra.finding_added",
    moduleOwner: "m30",
    description:
      "A new SRA finding was added (R-43); M33 reflects the finding count / risk-band breakdown.",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      findingId: id,
      controlRef: id,
      riskBand: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.sra.cycle_closed",
    moduleOwner: "m30",
    description:
      "An SRA cycle was closed (R-47) once the Security Officer and Compliance Officer have BOTH signed (initiate + the nominee's own confirmation); M33 reflects it, M34 refreshes the tenant compliance gate (SRA freshness).",
    payloadSchema: Type.Object({
      orgId: id,
      cycleId: id,
      closedAt: isoInstant,
      openFindingsAtClose: Type.Integer({ minimum: 0 }),
      ...closeAttestationFields,
    }),
    // F-132 (#248) — m34 REMOVED: the description's "M34 refreshes the tenant compliance gate" is real
    // but the mechanism is the SEAM M30 publishes — `SecurityRiskAssessmentReader`, M30's own §4.6
    // registry entry names its only consumer as `['m34']` and its own text says M34 consults it "at
    // fiscal-year rollover" — never a reactive outbox subscription to cycle closure.
    declaredConsumers: [],
    seamConsumers: ["m33"],
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
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m30.mortality.review_completed",
    moduleOwner: "m30",
    description:
      "A reviewer completed a mortality review (R-73); M33 reflects the three-dimension outcome.",
    payloadSchema: Type.Object({
      orgId: id,
      reviewId: id,
      dimensions: Type.Object({
        clinical: id,
        satisfaction: id,
        compliance: id,
      }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
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
    // F-132 (#248) — m34 REMOVED: same `ComplianceStatusProvider` seam-pull reasoning as
    // `m30.sra.cycle_closed` above (M30's own §4.6 registry names its consumers as `['m28','m33','m34']`
    // via the seam, never via this outbox event).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── infection surveillance (§4.10) ──────────────────────────────────────────────────────────────
  {
    eventName: "m30.infection.event_recorded",
    moduleOwner: "m30",
    description:
      "A surveillance event was recorded (R-91); the ≥3-events/14d cluster threshold is evaluated INLINE, in the same transaction, immediately after this emit — never via an outbox round-trip.",
    payloadSchema: Type.Object({
      orgId: id,
      eventId: id,
      pathogen: id,
      bodySite: id,
      patientId: id,
    }),
    // F-115 (#248) — "self-subscriber" was wrong: `write-service-drizzle.ts`'s `recordInfectionEvent`
    // runs the §7.8 outbreak-window scan synchronously right after this emit, in the same tx. Nothing
    // has ever consumed this event via the outbox, and nothing needs to — record-only.
    declaredConsumers: [],
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
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
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
    declaredConsumers: [],
    seamConsumers: ["m33"],
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
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
