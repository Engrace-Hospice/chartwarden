// apps/backend/src/modules/27-cost-report/events-by-m27.ts — Module 27's outbox-event contributions
// (spec §4.10 Outbox Event Catalog). The full `m27.*` taxonomy keyed on M27's own resources, under the
// `m27.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file
// for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m27'), and valid declared consumers (real
// module ids). The composition root merges this into the platform event catalog at boot (the M30/M33/M34
// events-by-mN precedent); the dispatcher validates each `m27.*` publish against the TypeBox
// `payloadSchema` inside the same transaction as the mutation (transactional outbox).
//
// M27 carries NO PHI (D18) — every payload is IDs + aggregate financial/statistical facts only. The
// cross-module fan-outs target M22 (ECR/PI artifact render+store), M28 (FHIR DocumentReference), M30
// (HQRP financial context), M33 (dashboards/worklists), M34 (tenant compliance gate), and M36 (alerts).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const cents = Type.Integer();

export const M27_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── cost_report lifecycle (§2.2 / §4.10) ─────────────────────────────────────────────────────────
  {
    eventName: "m27.cost_report.created",
    moduleOwner: "m27",
    description:
      "A new cost report was created for a (ProviderEntity, FYE); a compliance window was opened.",
    payloadSchema: Type.Object({
      costReportId: id,
      providerEntityId: id,
      organizationId: id,
      fyeDate: isoInstant,
      fiscalYearStartDate: isoInstant,
      deadlineDate: isoInstant,
    }),
    // F-132 (#248) — m34 REMOVED: M27's own §1.1 "Consumed by" text is explicit that M34's ONLY
    // consumption of M27 is a seam PULL — `CostReportFilingStatusReader.getOpenReportsForProvider`/
    // `.getMostRecentSubmissionFor`, consulted on-demand at the tenant offboarding gate and the tenant
    // dashboard's compliance-posture summary — never a reactive outbox subscription to the cost-report
    // lifecycle. Same "push declared, real consumption is pull" shape F-130 found for M27's own m26/m6
    // consumption one pass earlier, here on the OTHER side of the relationship.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.populating",
    moduleOwner: "m27",
    description:
      "Seam-derived inputs first materialized (trial balance + statistics); the report entered populating.",
    payloadSchema: Type.Object({ costReportId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.validation_started",
    moduleOwner: "m27",
    description: "A validation run was enqueued against the current cost-report state.",
    payloadSchema: Type.Object({
      costReportId: id,
      validationId: id,
      ruleSetVersion: Type.Integer(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.validation_completed",
    moduleOwner: "m27",
    description:
      "A validation run completed; the rolled-up counts + blocking-failure list are attached.",
    payloadSchema: Type.Object({
      costReportId: id,
      validationId: id,
      passedCount: Type.Integer(),
      failedCount: Type.Integer(),
      warningCount: Type.Integer(),
      overriddenCount: Type.Integer(),
      skippedCount: Type.Integer(),
      blockingRulesFailing: Type.Array(id),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.validation_failed_to_run",
    moduleOwner: "m27",
    description:
      "A validation run failed at the infrastructure layer (seam unbound / stale pull), distinct from rule failure.",
    payloadSchema: Type.Object({ costReportId: id, validationId: id, reason: id }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.ready_for_review",
    moduleOwner: "m27",
    description:
      "Validation completed with no unresolved blocking failures; the report is ready for review.",
    payloadSchema: Type.Object({ costReportId: id, validationId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.returned_to_draft",
    moduleOwner: "m27",
    description: "The report was returned from ready_for_review to populating for further editing.",
    payloadSchema: Type.Object({ costReportId: id, reason: Type.Optional(id) }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.approved_for_submit",
    moduleOwner: "m27",
    description: "The one-way checkpoint: the report was approved for submission (step-up auth).",
    payloadSchema: Type.Object({
      costReportId: id,
      approvedByMembershipId: id,
      approvedAt: isoInstant,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.submitted",
    moduleOwner: "m27",
    description:
      "The report was submitted: a content-hashed snapshot was built and ECR + PI generation enqueued.",
    payloadSchema: Type.Object({
      costReportId: id,
      snapshotId: id,
      snapshotContentHash: id,
      submittedByMembershipId: id,
      attestation: Type.Object({ attestedByMembershipId: id, attestedAt: isoInstant }),
    }),
    // F-115 (#248) — m28 removed (never subscribes, F-035); m30 moved to seamConsumers: reads filing
    // posture via `QualityCostReportConsumer.filingStatusForOrg` (cost_report_filing_compliance, CoP
    // 418.310) on its nightly cadence — same for `accepted`/`reopened` below.
    // F-117 (#248) — m22 removed: `submit` does NOT emit `m27.artifact.render_requested` itself
    // (F-108 — "the emit is gone from submit: the job owns it"); the `ecr-generation` job enqueued
    // one line above is what emits the real, already-live-bound render request, carrying the real
    // artifacts rather than a snapshot placeholder. Declaring m22 directly on `submitted` was the
    // same handshake named twice, one hop earlier than where it's actually produced.
    // F-132 (#248) — m34 REMOVED: same `CostReportFilingStatusReader` seam-pull reasoning as
    // `m27.cost_report.created` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.accepted",
    moduleOwner: "m27",
    description:
      "A MAC acknowledgment (acceptance number) was recorded; the settlement period begins.",
    payloadSchema: Type.Object({
      costReportId: id,
      submissionId: id,
      mcrefAcknowledgmentNumber: id,
      acceptedAt: isoInstant,
    }),
    // F-132 (#248) — m34 REMOVED: same `CostReportFilingStatusReader` seam-pull reasoning as
    // `m27.cost_report.created` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.rejected",
    moduleOwner: "m27",
    description:
      "A MAC rejection was recorded; the rejection code is matched against the rule library (auto-suggestion).",
    payloadSchema: Type.Object({
      costReportId: id,
      submissionId: id,
      mcrefRejectionCode: id,
      mcrefRejectionDetail: Type.Optional(id),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.reopened",
    moduleOwner: "m27",
    description:
      "A submitted/accepted/rejected report was reopened (severity=warn); the prior snapshot is preserved.",
    payloadSchema: Type.Object({
      costReportId: id,
      priorSnapshotId: nullableId,
      newReopenCount: Type.Integer(),
      reopenedByMembershipId: id,
      reason: id,
      reasonCategory: id,
    }),
    // F-115 (#248) — m28 removed (never subscribes, F-035); m30 moved to seamConsumers (same
    // `filingStatusForOrg` seam as `submitted` above).
    // F-117 (#248) — m22 removed: `reopen()` resets the report to `draft` (write-service-drizzle.ts)
    // and neither enqueues a render job nor emits any request event — there is no artifact for M22
    // to produce at reopen; the next real render happens on the following `submitted`.
    // F-132 (#248) — m34 REMOVED: same `CostReportFilingStatusReader` seam-pull reasoning as
    // `m27.cost_report.created` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_report.closed",
    moduleOwner: "m27",
    description:
      "The report was closed on ProviderEntity offboarding; submission history is retained.",
    payloadSchema: Type.Object({ costReportId: id, providerEntityId: id }),
    // F-132 (#248) — m34 REMOVED: same `CostReportFilingStatusReader` seam-pull reasoning as
    // `m27.cost_report.created` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── imports + statistics (§4.5 / §4.10) ──────────────────────────────────────────────────────────
  {
    eventName: "m27.trial_balance.pull_requested",
    moduleOwner: "m27",
    description: "A Xero trial-balance pull was requested (worker pickup signal).",
    payloadSchema: Type.Object({ costReportId: id, source: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.trial_balance.pulled",
    moduleOwner: "m27",
    description:
      "A trial-balance pull completed; account count + debit/credit totals + balanced flag attached.",
    payloadSchema: Type.Object({
      costReportId: id,
      importId: id,
      accountCount: Type.Integer(),
      totalDebitsCents: cents,
      totalCreditsCents: cents,
      balanced: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.trial_balance.pull_failed",
    moduleOwner: "m27",
    description:
      "A trial-balance pull failed (Xero 5xx / token-refresh / not connected); a reconnect prompt is raised.",
    payloadSchema: Type.Object({
      costReportId: id,
      source: id,
      failureReason: id,
      requiresReconnect: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.wage_data.pull_requested",
    moduleOwner: "m27",
    description:
      "A Gusto wage-data pull was requested (worker pickup signal; only when wage_source=gusto).",
    payloadSchema: Type.Object({ costReportId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.wage_data.pulled",
    moduleOwner: "m27",
    description: "A wage-data pull completed; employee count + paid hours + salary total attached.",
    payloadSchema: Type.Object({
      costReportId: id,
      importId: id,
      employeeCount: Type.Integer(),
      totalPaidHours: Type.Number(),
      totalSalaryCents: cents,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.wage_data.pull_failed",
    moduleOwner: "m27",
    description: "A wage-data pull failed; a reconnect prompt is raised.",
    payloadSchema: Type.Object({
      costReportId: id,
      failureReason: id,
      requiresReconnect: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.statistics.refresh_requested",
    moduleOwner: "m27",
    description:
      "A statistics re-aggregation from M6/M8/M23 seams was requested (worker pickup signal).",
    payloadSchema: Type.Object({ costReportId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.statistics.refreshed",
    moduleOwner: "m27",
    description:
      "Statistics re-aggregated; month count + totals + which seams were skipped (deny-stub) attached.",
    payloadSchema: Type.Object({
      costReportId: id,
      monthCount: Type.Integer(),
      totalPatientDays: Type.Integer(),
      totalVisits: Type.Integer(),
      capProviderSkipped: Type.Boolean(),
      claimProviderSkipped: Type.Boolean(),
      /** GAP-080 — true when no completed wage import exists, so no FTE could be derived (the map is empty). */
      fteSourceMissing: Type.Optional(Type.Boolean()),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── mapping / bad-debt / allocation (§4.10) ──────────────────────────────────────────────────────
  {
    eventName: "m27.cost_center_mapping.applied",
    moduleOwner: "m27",
    description: "A cost-center mapping change was applied for a (provider, fiscal year).",
    payloadSchema: Type.Object({
      costReportId: id,
      providerEntityId: id,
      fyInt: Type.Integer(),
      changeCount: Type.Integer(),
      mappingSource: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.cost_center_mapping.reset",
    moduleOwner: "m27",
    description: "A mapping was reset to platform default for a (provider, fiscal year).",
    payloadSchema: Type.Object({
      costReportId: id,
      providerEntityId: id,
      fyInt: Type.Integer(),
      keepTenantOverrides: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.bad_debt.recorded",
    moduleOwner: "m27",
    description: "A bad-debt record was added (informational).",
    payloadSchema: Type.Object({
      costReportId: id,
      recordId: id,
      debtKind: id,
      amountCents: cents,
      periodLabel: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.bad_debt.soft_deleted",
    moduleOwner: "m27",
    description: "A bad-debt record was soft-deleted (tombstone preserved for audit).",
    payloadSchema: Type.Object({ costReportId: id, recordId: id, deletedByMembershipId: id }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.allocation.recomputed",
    moduleOwner: "m27",
    description:
      "The step-down + apportionment + settlement recompute completed for the derived worksheets.",
    payloadSchema: Type.Object({
      costReportId: id,
      worksheetsRecomputed: Type.Array(id),
      totalAllocatedCents: cents,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── validation override + rule suggestion (§4.10) ────────────────────────────────────────────────
  {
    eventName: "m27.validation.overridden",
    moduleOwner: "m27",
    description:
      "A failing validation result was overridden with a reason (severity=warn for audit prominence).",
    payloadSchema: Type.Object({
      costReportId: id,
      validationResultId: id,
      ruleCode: id,
      overriddenByMembershipId: id,
      reason: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.validation.rule_suggestion_created",
    moduleOwner: "m27",
    description:
      "A MAC rejection not covered by any rule produced a draft platform-suggestion (anonymized).",
    payloadSchema: Type.Object({
      draftRuleId: id,
      sourceRejectionCode: id,
      suggestedFromCostReportId: id,
      anonymized: Type.Boolean(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── artifact render + compliance window + snapshot integrity (§4.10) ─────────────────────────────
  {
    eventName: "m27.artifact.render_requested",
    moduleOwner: "m27",
    description:
      "An ECR / PI / supporting-doc artifact render+store was requested (M22 consumes at M22 lock).",
    payloadSchema: Type.Object({
      costReportId: id,
      submissionId: id,
      artifactKind: Type.Union([
        Type.Literal("ecr"),
        Type.Literal("pi"),
        Type.Literal("supporting_doc"),
      ]),
      payloadRef: id,
      retentionClass: Type.Literal("compliance"),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.artifact.stored_back_reference",
    moduleOwner: "m27",
    description:
      "M22 stored an artifact and returned its document id; M27 records the back-reference (internal).",
    payloadSchema: Type.Object({ submissionId: id, artifactKind: id, documentId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.compliance_window.tier_emitted",
    moduleOwner: "m27",
    description:
      "The filing-deadline scan crossed a tier threshold; the tiered alert is dispatched to M36.",
    payloadSchema: Type.Object({
      costReportId: id,
      tier: id,
      deadlineDate: isoInstant,
      daysToDeadline: Type.Integer(),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m27.snapshot.integrity_failure",
    moduleOwner: "m27",
    description:
      "A snapshot's stored content hash did not match its recomputed hash (severity=critical; system-status).",
    payloadSchema: Type.Object({
      costReportId: id,
      snapshotId: id,
      storedHash: id,
      computedHash: id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
];
