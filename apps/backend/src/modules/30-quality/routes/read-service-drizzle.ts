// apps/backend/src/modules/30-quality/routes/read-service-drizzle.ts — M30 the Drizzle-backed
// M30ReadRouteService (§4.1/§4.2 READ surface: quality measures, CAHPS reads, QAPI/SRA reads, the
// incident/mortality/infection lists + details, CoP citations, the risk register).
//
// Implements the SAME {@link M30ReadRouteService} interface the route plugins compose over, but every
// read opens ONE `withOrgContext(db, {organizationId, userId}, tx => …)` transaction (the M1
// @wardenx/tenancy helper) so Postgres RLS scopes every statement to `app.org_id` — keeping tenant
// scoping in one home. Inside the tx it reads through the @wardenx/quality data-port REPOSITORIES (each
// takes the `tx` handle) and projects the rows to the deliberately-narrowed read DTOs. Mirrors the
// 33-reporting/routes/read-service-drizzle.ts precedent (one `read(orgId, fn)` helper, one builder
// returning the service, DTO mappers above it).
//
// DTO discipline (mirrors read-service.ts): audit-denylisted / cipher columns (`computation_snapshot`,
// `configuration_cipher`, `primary_caregiver_contact_cipher`, SRA/QAPI narrative free-text, the incident
// `kind_data` free-text members on LIST rows) are NEVER projected onto a view here. PHI lists are
// cursor-paginated via `paginate()` (the §4.1.2 keyset helper) over a bounded, RLS-scoped, partition-key
// DESC-ordered window — the 33-reporting drilldown-audit precedent (fetch a bounded set, paginate in
// memory). Aggregate measure reads project the materialized `quality_measure_value` ledger and label each
// measure from the @wardenx/quality MEASURE_CATALOG (the calculators themselves are worker-phase: a read
// request never fetches upstream-seam state to compute a value that was never materialized — it returns
// `latestValue: null`).
//
// REPO-GAP NOTE: several read DTOs are org-wide projections the per-(provider_entity) repository list
// methods do not directly serve (the measure ledger, the CAHPS decedent/result rolls, CoP citations, the
// QAPI indicator/minutes rolls, the outbreak roll, the partitioned detail point-reads). For those the
// service issues a plain org-scoped Drizzle SELECT on the `tx` handle (still under the SAME RLS GUC) —
// the 33-reporting read service's direct `db.select().from(reportDrilldownAudit)` precedent. Where a
// frozen-schema column the DTO names does not exist (e.g. a separate incident state-history / investigation
// table, the PIP charterer, a CAHPS export-job store), the projection degrades safely (empty / null) and
// the route still returns a faithful record of what the schema holds.
import { schema } from "@wardenx/db";
import {
  CahpsRepository,
  IncidentRepository,
  InfectionRepository,
  MEASURE_CATALOG,
  type MeasureFamily,
  MeasureRecomputeQueueRepository,
  MortalityReviewRepository,
  QapiRepository,
  type QualityDb,
  QualityMeasureValueRepository,
  RiskRegisterRepository,
  SraRepository,
  buildRiskRegister,
  riskBandFromScore,
  unavailableReasonOf,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { M30ReadActor } from "./actor";
import { type CursorPage, pageSizeOf, paginate } from "./concurrency";
import { incidentOwnedBy } from "./incident-ownership";
import { assertPatientInScope } from "./patient-scope";
import {
  fetchIncidentPage,
  fetchInfectionEventPage,
  fetchMortalityPage,
  toKeysetPage,
  toListCursor,
} from "./phi-list-queries";
import type {
  CahpsDecedentFilter,
  CahpsDecedentView,
  CahpsExportJobView,
  CahpsResultFilter,
  CahpsResultSummaryView,
  CahpsVendorBindingView,
  CopCitationView,
  IncidentDetailView,
  IncidentListFilter,
  IncidentSummaryView,
  InfectionEventFilter,
  InfectionEventView,
  InfectionOutbreakFilter,
  InfectionOutbreakView,
  M30ReadRouteService,
  MeasureBandColor,
  MeasureListFilter,
  MeasureSummaryView,
  MeasureValueSeriesView,
  MeasureValueSnapshotView,
  MeasureValueView,
  MortalityListFilter,
  MortalityReviewDetailView,
  MortalityReviewSummaryView,
  QapiGovernanceMinutesView,
  QapiIndicatorView,
  QapiPipView,
  QapiProgramView,
  QapiProjectFilter,
  QapiProjectView,
  RecomputeQueueEntryView,
  RiskRegisterEntryView,
  RiskRegisterFilter,
  SraCycleDetailView,
  SraCycleView,
  SraFindingView,
  SraRemediationView,
} from "./read-service";

/**
 * Composition deps the Drizzle read backend binds at boot. Intentionally minimal — every read scopes
 * itself through `withOrgContext`, so the backend needs no replica/queue/seam port (unlike M33). The
 * clock + active fiscal year drive the measure-catalog projection (which measures the platform currently
 * computes); both default so the boot wiring can omit them in dev.
 */
export interface M30ReadServicePorts {
  /** Injectable clock (test seam); defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** The fiscal year the platform computes measures for (drives the §R-01 catalog projection). */
  readonly currentFiscalYear?: number;
}

// ── small projection helpers ───────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();
/** Does the actor's membership match any of the row's owner columns? (the own-record arm of the PHI scope) */
const ownsRow = (membershipId: string | undefined, ...owners: (string | null)[]): boolean =>
  membershipId !== undefined && owners.includes(membershipId);
/** A Drizzle `numeric` column round-trips as a string; parse to a number (or null when absent). */
const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));

/** The MEASURE_CATALOG family → the §4.2 dashboard `domain` union (collapses `hope_derived` → `hope`). */
function familyToDomain(family: MeasureFamily): MeasureSummaryView["domain"] {
  return family === "hope_derived" ? "hope" : family;
}

/**
 * Derive the four-band display color for a measure value. The ledger persists `threshold_met` but not the
 * band (the band is the calculator's pure output, recomputed for display): an empty denominator collapses
 * to `insufficient_n`; a failed threshold is `red`; a met-or-not-evaluated threshold is `green`. `yellow`
 * (the warn band) is not reconstructible from the persisted row, so it is never inferred here.
 */
function bandOf(row: schema.QualityMeasureValue): MeasureBandColor {
  if (row.denominator <= 0) return "insufficient_n";
  if (row.thresholdMet === false) return "red";
  return "green";
}

function mapMeasureValue(row: schema.QualityMeasureValue): MeasureValueView {
  return {
    valueId: row.id,
    organizationId: row.organizationId,
    measureId: row.measureCode,
    period: {
      kind: row.periodKind,
      start: isoReq(row.periodStart),
      end: isoReq(row.periodEnd),
    },
    numerator: row.numerator,
    denominator: row.denominator,
    rate: num(row.ratio),
    thresholdMet: row.thresholdMet,
    bandColor: bandOf(row),
    unavailableReason: unavailableReasonOf(row.computationSnapshot ?? null),
    computedAt: isoReq(row.computedAt),
    computeVersion: row.calculatorVersion,
    snapshotContentHash: row.snapshotContentHash,
    supersededByValueId: row.supersededBy ?? null,
  };
}

/** Map the schema mortality status (4 states + `overdue`) onto the narrowed §R-70 view union (3 states). */
function mortalityStatus(
  s: schema.MortalityReview["status"],
): MortalityReviewSummaryView["status"] {
  switch (s) {
    case "pending":
      return "created";
    case "completed":
      return "completed";
    default:
      // `in_progress` and `overdue` are both "in progress" from the worklist's perspective.
      return "in_progress";
  }
}

/** Map the schema SRA-finding status onto the §R-42 `disposition` union. */
function findingDisposition(s: schema.SraFinding["status"]): SraFindingView["disposition"] {
  switch (s) {
    case "mitigated":
      return "remediated";
    case "accepted_risk":
      return "accepted";
    case "mitigation_planned":
    case "mitigation_in_progress":
      return "remediating";
    default:
      // `identified` | `analyzed`
      return "open";
  }
}

function mapSraFinding(row: schema.SraFinding): SraFindingView {
  return {
    findingId: row.id,
    cycleId: row.sraCycleId,
    findingNumber: row.findingNumber,
    // The frozen schema stores the asset category + the composite 5×5 scores, not a discrete NIST control
    // ref or the decomposed likelihood/impact factors — project the category as the control ref and the
    // residual score as the risk score (its band is reconstructed from the score).
    controlRef: row.affectedAssetCategory,
    likelihood: 0,
    impact: 0,
    riskScore: row.residual5x5Score,
    riskBand: riskBandFromScore(row.residual5x5Score),
    disposition: findingDisposition(row.status),
  };
}

function mapSraRemediation(row: schema.SraRemediation): SraRemediationView {
  const status: SraRemediationView["status"] =
    row.status === "proposed" ? "planned" : row.status === "abandoned" ? "deferred" : row.status; // in_progress | completed
  return {
    remediationId: row.id,
    findingId: row.sraFindingId,
    remediationNumber: row.remediationNumber,
    plan: row.descriptionText,
    ownerMembershipId: row.ownerMembershipId,
    dueAt: row.targetDate,
    status,
    completedAt: iso(row.completedAt),
  };
}

function mapSraCycle(row: schema.SraCycle): SraCycleView {
  return {
    cycleId: row.id,
    organizationId: row.organizationId,
    cycleYear: row.cycleYear,
    status: row.status,
    scopeTemplateVersion: row.templateVersion,
    ownerMembershipId: row.openedByMembershipId,
    openedAt: isoReq(row.openedAt),
    closedAt: iso(row.closedAt),
  };
}

function mapIncidentSummary(row: schema.IncidentReport): IncidentSummaryView {
  return {
    incidentId: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    state: row.lifecycle,
    severity: row.severity,
    patientId: row.patientId ?? null,
    occurredAt: isoReq(row.occurredAt),
    reportedAt: isoReq(row.reportedAt),
    reportedByMembershipId: row.reportedByMembershipId,
    assignedToMembershipId: row.triagedByMembershipId ?? null,
  };
}

function mapMortalitySummary(row: schema.MortalityReview): MortalityReviewSummaryView {
  return {
    reviewId: row.id,
    organizationId: row.organizationId,
    patientId: row.deceasedPatientId,
    dateOfDeath: isoReq(row.deathAt),
    assignedToMembershipId: row.assignedReviewerMembershipId ?? null,
    status: mortalityStatus(row.status),
    targetCompletionAt: isoReq(row.targetCompletionAt),
    completedAt: iso(row.completedAt),
  };
}

function mapInfectionEvent(row: schema.InfectionSurveillanceEvent): InfectionEventView {
  return {
    eventId: row.id,
    organizationId: row.organizationId,
    patientId: row.patientId ?? "",
    pathogen: row.pathogen,
    bodySite: row.bodySite,
    observedAt: isoReq(row.observedAt),
    filedByMembershipId: row.filedByMembershipId,
    outbreakCaseId: null,
  };
}

/** Map the schema outbreak status (open/idg_reviewed/contained/closed) onto the §R-92 view union. */
function outbreakStatus(
  s: schema.InfectionOutbreakCase["status"],
): InfectionOutbreakView["status"] {
  switch (s) {
    case "idg_reviewed":
      return "notified";
    case "closed":
      return "resolved";
    default:
      return s; // open | contained
  }
}

function mapOutbreak(row: schema.InfectionOutbreakCase): InfectionOutbreakView {
  return {
    caseId: row.id,
    organizationId: row.organizationId,
    pathogen: row.pathogen,
    bodySite: row.bodySite,
    eventCount: row.triggeringEventCount,
    firstEventAt: isoReq(row.windowStart),
    lastEventAt: isoReq(row.windowEnd),
    status: outbreakStatus(row.status),
    resolvedAt: iso(row.closedAt),
  };
}

function mapCopCitation(row: schema.CopComplianceStatus): CopCitationView {
  return {
    citationId: row.id,
    organizationId: row.organizationId,
    citationRef: row.copCitation,
    displayName: `CoP ${row.copCitation}`,
    status: row.status,
    evidencePointers: row.evidenceDocumentIds,
    lastReviewedAt: iso(row.lastReviewedAt),
    nextReviewDueAt: iso(row.nextReviewDueAt),
  };
}

// ── the builder ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the Drizzle-backed {@link M30ReadRouteService}. Every method opens one `withOrgContext`
 * transaction (RLS-scoped to the actor's org) and reads through the @wardenx/quality repositories on the
 * tx handle, projecting to the read DTOs. The route plugins gate each method on the §4.6 permission +
 * (PHI routes) `requirePatientScope()` BEFORE the call reaches here — this layer assumes an authorized,
 * org-bound actor and never re-derives the org from anything but `actor.organizationId`.
 */
export function buildDrizzleM30ReadService(
  db: QualityDb,
  ports: M30ReadServicePorts = {},
): M30ReadRouteService {
  const now = ports.now ?? (() => new Date());
  const fiscalYear = ports.currentFiscalYear ?? now().getUTCFullYear();

  // One RLS-scoped read transaction. The org/actor binding is the server-assembled actor (never the wire);
  // `Tx` is pinned to `QualityDb` (= the M1 `DbClient`) so the tx handle satisfies every repo constructor
  // (the M33 `withOrgContext<WriteTx, T>` precedent — keeps tenant scoping in this one home).
  const read = <T>(actor: M30ReadActor, fn: (tx: QualityDb) => Promise<T>): Promise<T> =>
    withOrgContext<QualityDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  return {
    // ── Quality measures (R-01, R-02, R-03, R-05) ──────────────────────────────────────────────────────
    async listMeasures(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        // Project the platform catalog active for the current FY, attaching the latest materialized value
        // per measure (a read never computes an unmaterialized value — `latestValue` stays null then).
        const V = schema.qualityMeasureValue;
        const currentRows = await tx
          .select()
          .from(V)
          .where(and(eq(V.organizationId, actor.organizationId), isNull(V.supersededAt)))
          .orderBy(desc(V.periodEnd));
        const latestByCode = new Map<string, schema.QualityMeasureValue>();
        for (const row of currentRows) {
          if (!latestByCode.has(row.measureCode)) latestByCode.set(row.measureCode, row);
        }

        const catalog = MEASURE_CATALOG.filter((m) => m.activatesFy <= fiscalYear);
        const views: (MeasureSummaryView & { createdAt: string; id: string })[] = catalog
          .filter((m) => {
            const domain = familyToDomain(m.family);
            return filter.domain === undefined || filter.domain === domain;
          })
          .map((m) => {
            const latest = latestByCode.get(m.code);
            return {
              measureId: m.code,
              displayName: m.description,
              domain: familyToDomain(m.family),
              latestValue: latest ? mapMeasureValue(latest) : null,
              fiscalYear,
              // Stable keyset: the catalog order is deterministic, so the code doubles as the sort anchor.
              createdAt: m.code,
              id: m.code,
            };
          })
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

        const page = paginate(views, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...view }) => view),
        } satisfies CursorPage<MeasureSummaryView>;
      });
    },

    async getMeasureValues(actor, measureId, filter) {
      return read(actor, async (tx) => {
        const V = schema.qualityMeasureValue;
        const rows = await tx
          .select()
          .from(V)
          .where(
            and(
              eq(V.organizationId, actor.organizationId),
              eq(V.measureCode, measureId),
              isNull(V.supersededAt),
            ),
          )
          .orderBy(desc(V.periodEnd));
        const windowStart = filter.windowStart ? new Date(filter.windowStart) : null;
        const windowEnd = filter.windowEnd ? new Date(filter.windowEnd) : null;
        const values = rows
          .filter((r) => {
            if (windowStart && r.periodEnd < windowStart) return false;
            if (windowEnd && r.periodStart > windowEnd) return false;
            return true;
          })
          .map(mapMeasureValue);
        const display = MEASURE_CATALOG.find((m) => m.code === measureId)?.description ?? measureId;
        return { measureId, displayName: display, values } satisfies MeasureValueSeriesView;
      });
    },

    async getMeasureValueSnapshot(actor, measureId, valueId) {
      return read(actor, async (tx) => {
        const row = await new QualityMeasureValueRepository(tx).findById(valueId);
        if (!row || row.measureCode !== measureId) throw new NotFoundError("measure value");
        const snap = (row.computationSnapshot ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string => (typeof v === "string" ? v : "");
        const rec = (v: unknown): Record<string, unknown> =>
          v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
        const counts = ((): Record<string, number> => {
          const c = rec(snap.inputRowCounts);
          const out: Record<string, number> = {};
          for (const [k, v] of Object.entries(c)) if (typeof v === "number") out[k] = v;
          return out;
        })();
        return {
          valueId: row.id,
          measureId: row.measureCode,
          computeVersion: row.calculatorVersion,
          snapshotContentHash: row.snapshotContentHash,
          computedAt: isoReq(row.computedAt),
          inputs: {
            populationSourceTables: arr(snap.populationSourceTables),
            populationFilter: str(snap.populationFilter),
            inputRowCounts: counts,
            parameters: rec(snap.parameters),
            thresholdConstants: rec(snap.thresholdConstants),
          },
          intermediates: snap.intermediates ? rec(snap.intermediates) : null,
          output: {
            numerator: row.numerator,
            denominator: row.denominator,
            rate: num(row.ratio),
          },
        } satisfies MeasureValueSnapshotView;
      });
    },

    async listRecomputeQueue(actor) {
      return read(actor, async (tx) => {
        const rows = await new MeasureRecomputeQueueRepository(tx).listPending({
          organizationId: actor.organizationId,
          limit: 200,
        });
        return rows.map(
          (r): RecomputeQueueEntryView => ({
            jobId: r.id,
            scope: { kind: "measure", measureId: r.measureCode },
            priority: "normal",
            enqueuedAt: isoReq(r.enqueuedAt),
            state: r.requiresRecompute ? "waiting" : "completed",
          }),
        );
      });
    },

    // ── CAHPS (R-10, R-12, R-15, R-17) ──────────────────────────────────────────────────────────────────
    async getCahpsVendor(actor) {
      return read(actor, async (tx) => {
        const row = await new CahpsRepository(tx).findActiveBinding(actor.organizationId);
        if (!row) return null;
        return {
          bindingId: row.id,
          organizationId: row.organizationId,
          vendorAdapterId: row.vendorAdapterId,
          // The binding stores the adapter id (`shp` | `press_ganey` | …); the human label is the adapter
          // id itself until an M38-backed vendor catalog seam is bound.
          vendorName: row.vendorAdapterId,
          effectiveFrom: isoReq(row.effectiveFrom),
          effectiveTo: iso(row.effectiveUntil),
          isActive: row.active,
        } satisfies CahpsVendorBindingView;
      });
    },

    async listCahpsDecedents(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        // No org-wide-across-cycles repo method (the roster is partitioned by `sampling_cycle_month`); read
        // org-scoped under RLS, optionally narrowed by the requested sample window, newest-created first.
        const S = schema.cahpsDecedentSample;
        const rows = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.createdAt))
          .limit(500);
        const start = filter.samplePeriodStart ?? null;
        const end = filter.samplePeriodEnd ?? null;
        const mapped = rows
          .filter((r) => {
            if (start && r.samplingCycleMonth < start) return false;
            if (end && r.samplingCycleMonth > end) return false;
            if (filter.eligibleOnly && r.exclusionReason != null) return false;
            return true;
          })
          .map((r) => ({
            sampleId: r.id,
            organizationId: r.organizationId,
            patientId: r.deceasedPatientId,
            // The roster row carries the cycle month, not a discrete date-of-death column; the sample
            // window derives from the partition month.
            dateOfDeath: r.samplingCycleMonth,
            samplePeriodStart: r.samplingCycleMonth,
            samplePeriodEnd: r.samplingCycleMonth,
            eligible: r.exclusionReason == null,
            exclusionReason: r.exclusionReason ?? null,
            createdAt: isoReq(r.createdAt),
            id: r.id,
          }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<CahpsDecedentView>;
      });
    },

    async getCahpsExport(_actor, _exportId): Promise<CahpsExportJobView> {
      // §R-15 reads a CAHPS export-JOB store. No M30 base table backs export jobs (export is a BullMQ
      // worker concern bound in P2c — the §4.8 producer + the M22 signed-URL mint); until that store is
      // bound the read is a non-leaking 404 rather than a fabricated job.
      throw new NotFoundError("cahps export");
    },

    async listCahpsResults(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        const R = schema.cahpsResultSummary;
        const rows = await tx
          .select()
          .from(R)
          .where(eq(R.organizationId, actor.organizationId))
          .orderBy(desc(R.reportingPeriodEnd))
          .limit(500);
        const mapped = rows
          .filter((r) => {
            if (filter.reportingPeriodStart && r.reportingPeriodStart < filter.reportingPeriodStart)
              return false;
            if (filter.reportingPeriodEnd && r.reportingPeriodEnd > filter.reportingPeriodEnd)
              return false;
            return true;
          })
          .map((r) => {
            // Min-cell suppression blanks the score payloads to `{}` at ingest (WF-06); reconstruct the
            // suppression flag from the empty payloads + surface one representative composite top-box.
            const composites = Object.values(r.compositeScores);
            const suppressed =
              composites.length === 0 && Object.keys(r.topBoxPercentages).length === 0;
            const first = composites[0];
            return {
              resultId: r.id,
              organizationId: r.organizationId,
              // The summary aggregates the six CMS composites, not a single measure id; the adapter id is
              // the stable per-row source label.
              measureId: r.vendorAdapterId,
              reportingPeriodStart: r.reportingPeriodStart,
              reportingPeriodEnd: r.reportingPeriodEnd,
              topBoxPercent: suppressed || typeof first !== "number" ? null : first,
              suppressedMinCell: suppressed,
              ingestedAt: isoReq(r.ingestedAt),
              createdAt: isoReq(r.ingestedAt),
              id: r.id,
            };
          });
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<CahpsResultSummaryView>;
      });
    },

    // ── QAPI (R-20, R-23, R-26, R-29, R-33) ─────────────────────────────────────────────────────────────
    async listQapiPrograms(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const rows = await new QapiRepository(tx).listPrograms(actor.organizationId);
        const mapped = rows.map((r) => ({
          programId: r.id,
          organizationId: r.organizationId,
          planYear: r.planYear,
          charterAdoptedAt: isoReq(r.createdAt),
          governanceComposition: r.governingBodyRoster.map((m) => ({
            role: m.role,
            membershipId: m.membershipId,
          })),
          status: (r.closed ? "superseded" : "active") as QapiProgramView["status"],
          createdAt: isoReq(r.createdAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<QapiProgramView>;
      });
    },

    async listQapiIndicators(actor, cursor, limit) {
      return read(actor, async (tx) => {
        // Org-wide indicator roll (the repo lists per-program); read live (non-soft-deleted) under RLS.
        const IND = schema.qapiIndicator;
        const rows = await tx
          .select()
          .from(IND)
          .where(and(eq(IND.organizationId, actor.organizationId), isNull(IND.deletedAt)))
          .orderBy(desc(IND.createdAt))
          .limit(500);
        const mapped = rows.map((r) => {
          const measureId = r.dataPath.startsWith("measure:")
            ? r.dataPath.slice("measure:".length)
            : null;
          return {
            indicatorId: r.id,
            organizationId: r.organizationId,
            qapiProgramId: r.qapiProgramId,
            displayName: r.indicatorName,
            measureId,
            // The frozen schema stores a tenant target value, not a min/max direction; the live rate/band
            // are a measure-evaluation concern (worker phase) — a read projects the static target only.
            thresholdDirection: "max" as const,
            thresholdValue: num(r.tenantTargetValue) ?? 0,
            currentRate: null,
            currentBand: null,
            breached: false,
            createdAt: isoReq(r.createdAt),
            id: r.id,
          };
        });
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<QapiIndicatorView>;
      });
    },

    async listQapiProjects(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        const PRJ = schema.qapiProject;
        const where = filter.programId
          ? and(
              eq(PRJ.organizationId, actor.organizationId),
              eq(PRJ.qapiProgramId, filter.programId),
            )
          : eq(PRJ.organizationId, actor.organizationId);
        const rows = await tx
          .select()
          .from(PRJ)
          .where(where)
          .orderBy(desc(PRJ.createdAt))
          .limit(500);
        const phases = filter.phases ? new Set(filter.phases) : null;
        const mapped = rows
          .filter((r) => !phases || phases.has(r.status))
          .map((r) => ({
            projectId: r.id,
            organizationId: r.organizationId,
            qapiProgramId: r.qapiProgramId,
            title: r.title,
            phase: r.status,
            indicatorId: r.linkedIndicatorId ?? null,
            ledByMembershipId: r.ownerMembershipId,
            charteredAt: isoReq(r.createdAt),
            completedAt: r.status === "completed" ? isoReq(r.updatedAt) : null,
            createdAt: isoReq(r.createdAt),
            id: r.id,
          }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<QapiProjectView>;
      });
    },

    async listQapiPips(actor, projectId, cursor, limit) {
      return read(actor, async (tx) => {
        const PIP = schema.qapiPip;
        const rows = await tx
          .select()
          .from(PIP)
          .where(
            and(eq(PIP.organizationId, actor.organizationId), eq(PIP.linkedProjectId, projectId)),
          )
          .orderBy(desc(PIP.createdAt))
          .limit(500);
        const mapped = rows.map((r) => ({
          pipId: r.id,
          organizationId: r.organizationId,
          projectId,
          phase: r.status,
          charterText: r.charterText,
          // The frozen schema records the two cosigners, not a discrete charterer id; the QAPI-coordinator
          // cosigner is the closest persisted principal (the closer≠charterer SoD is enforced on write).
          charteredByMembershipId: r.cosignQapiCoordinatorMembershipId ?? "",
          outcome: r.conclusionText ?? null,
          closedAt: iso(r.closedAt),
          createdAt: isoReq(r.createdAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<QapiPipView>;
      });
    },

    async listQapiGovernance(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const MIN = schema.qapiGovernanceMinutes;
        const rows = await tx
          .select()
          .from(MIN)
          .where(eq(MIN.organizationId, actor.organizationId))
          .orderBy(desc(MIN.meetingAt))
          .limit(500);
        const mapped = rows.map((r) => ({
          minutesId: r.id,
          organizationId: r.organizationId,
          qapiProgramId: r.qapiProgramId,
          meetingAt: isoReq(r.meetingAt),
          // No discrete recorder column on the frozen schema; the sign-off principal is the closest match.
          recordedByMembershipId: r.signedByMembershipId ?? "",
          // `minutes_text` is audit-denylisted free-text — summarized to its leading slice, never verbatim.
          summary: r.minutesText.slice(0, 280),
          attendees: r.attendeeRoster.map((a) => ({
            role: a.role ?? "",
            membershipId: a.membershipId,
          })),
          createdAt: isoReq(r.meetingAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<QapiGovernanceMinutesView>;
      });
    },

    // ── SRA (R-40, R-42) ────────────────────────────────────────────────────────────────────────────────
    async listSraCycles(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const rows = await new SraRepository(tx).listCycles(actor.organizationId);
        const mapped = rows.map((r) => ({
          ...mapSraCycle(r),
          createdAt: isoReq(r.createdAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<SraCycleView>;
      });
    },

    async getSraCycle(actor, cycleId) {
      return read(actor, async (tx) => {
        const repo = new SraRepository(tx);
        const cycle = await repo.findCycleById(cycleId);
        if (!cycle) throw new NotFoundError("sra cycle");
        const findings = await repo.listFindings(cycle.id);
        const remediations = (
          await Promise.all(findings.map((f) => repo.listRemediations(f.id)))
        ).flat();
        const openFindingsCount = findings.filter(
          (f) => f.status !== "mitigated" && f.status !== "accepted_risk",
        ).length;
        return {
          ...mapSraCycle(cycle),
          progress: {
            findingsCount: findings.length,
            openFindingsCount,
            remediationsCount: remediations.length,
          },
          findings: findings.map(mapSraFinding),
          remediations: remediations.map(mapSraRemediation),
        } satisfies SraCycleDetailView;
      });
    },

    // ── Incidents (R-50, R-52, R-61) — PHI ────────────────────────────────────────────────────────────
    async listIncidents(actor, filter, cursor, limit, scope) {
      // GAP-091 — an explicit patient filter outside the caller's scope is a 404, never an empty page.
      assertPatientInScope(scope, filter.patientId, "patient");
      const keyset = toListCursor(cursor);
      return read(actor, async (tx) =>
        toKeysetPage(
          await fetchIncidentPage(
            tx,
            actor.organizationId,
            filter,
            scope,
            keyset,
            pageSizeOf(limit),
            actor.membershipId,
          ),
          (r) => ({ at: r.occurredAt, id: r.id }),
          mapIncidentSummary,
        ),
      );
    },

    async getIncident(actor, incidentId, scope) {
      return read(actor, async (tx) => {
        // Point-read by id only (the composite PK includes the `occurred_at` partition key the route does
        // not carry); the RLS-scoped SELECT scans the partitions and returns the org's row.
        const I = schema.incidentReport;
        const [row] = await tx.select().from(I).where(eq(I.id, incidentId)).limit(1);
        if (!row) throw new NotFoundError("incident");
        assertPatientInScope(
          scope,
          row.patientId,
          "incident",
          incidentOwnedBy(row, actor.membershipId),
        );
        return {
          ...mapIncidentSummary(row),
          // The structured per-kind payload (the route is permission-gated + patient-scoped, so the
          // authorized PHI reader receives it intact).
          data: row.kindData as Readonly<Record<string, unknown>>,
          // No separate CAP-plan / investigation-note / state-history tables in the frozen 18-table set —
          // the detail projects the corrective-action narrative the row carries and empty histories.
          capPlan: row.correctiveActionTakenText
            ? {
                rootCauseSummary: row.correctiveActionTakenText,
                actions: [],
                verificationCriteria: "",
              }
            : null,
          capVerifiedByMembershipId: null,
          capVerifiedAt: null,
          closedByMembershipId: null,
          closedAt: iso(row.closedAt),
          stateHistory: [],
          investigationNotes: [],
          createdAt: isoReq(row.createdAt),
          updatedAt: isoReq(row.updatedAt),
        } satisfies IncidentDetailView;
      });
    },

    async listAbuseAllegations(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const rows = await new IncidentRepository(tx).listByOrg(actor.organizationId, {
          kind: "allegation_of_abuse",
          limit: 200,
        });
        const mapped = rows.map((r) => ({
          ...mapIncidentSummary(r),
          createdAt: isoReq(r.occurredAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<IncidentSummaryView>;
      });
    },

    // ── Mortality (R-70, R-71) — PHI ──────────────────────────────────────────────────────────────────
    async listMortalityReviews(actor, filter, cursor, limit, scope) {
      assertPatientInScope(scope, filter.patientId, "patient");
      const keyset = toListCursor(cursor);
      return read(actor, async (tx) =>
        toKeysetPage(
          await fetchMortalityPage(
            tx,
            actor.organizationId,
            filter,
            scope,
            keyset,
            pageSizeOf(limit),
            actor.membershipId,
          ),
          (r) => ({ at: r.deathAt, id: r.id }),
          mapMortalitySummary,
        ),
      );
    },

    async getMortalityReview(actor, reviewId, scope) {
      return read(actor, async (tx) => {
        const M = schema.mortalityReview;
        const [row] = await tx.select().from(M).where(eq(M.id, reviewId)).limit(1);
        if (!row) throw new NotFoundError("mortality review");
        assertPatientInScope(
          scope,
          row.deceasedPatientId,
          "mortality review",
          ownsRow(actor.membershipId, row.assignedReviewerMembershipId),
        );
        return {
          ...mapMortalitySummary(row),
          dimensions: {
            clinical: (row.clinicalDimensionData ?? null) as Readonly<
              Record<string, unknown>
            > | null,
            satisfaction: (row.satisfactionDimensionData ?? null) as Readonly<
              Record<string, unknown>
            > | null,
            compliance: (row.complianceDimensionData ?? null) as Readonly<
              Record<string, unknown>
            > | null,
          },
          reviewerMembershipId: row.assignedReviewerMembershipId ?? null,
          createdAt: isoReq(row.createdAt),
          updatedAt: isoReq(row.updatedAt),
        } satisfies MortalityReviewDetailView;
      });
    },

    // ── CoP compliance (R-80) ───────────────────────────────────────────────────────────────────────────
    async listCopCitations(actor, cursor, limit) {
      return read(actor, async (tx) => {
        const C = schema.copComplianceStatus;
        const rows = await tx
          .select()
          .from(C)
          .where(eq(C.organizationId, actor.organizationId))
          .orderBy(desc(C.createdAt))
          .limit(500);
        const mapped = rows.map((r) => ({
          ...mapCopCitation(r),
          createdAt: isoReq(r.createdAt),
          id: r.id,
        }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<CopCitationView>;
      });
    },

    // ── Infection (R-90, R-92) ─────────────────────────────────────────────────────────────────────────
    async listInfectionEvents(actor, filter, cursor, limit, scope) {
      assertPatientInScope(scope, filter.patientId, "patient");
      const keyset = toListCursor(cursor);
      return read(actor, async (tx) =>
        toKeysetPage(
          await fetchInfectionEventPage(
            tx,
            actor.organizationId,
            filter,
            scope,
            keyset,
            pageSizeOf(limit),
          ),
          (r) => ({ at: r.observedAt, id: r.id }),
          mapInfectionEvent,
        ),
      );
    },

    async listInfectionOutbreaks(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        const O = schema.infectionOutbreakCase;
        const rows = await tx
          .select()
          .from(O)
          .where(eq(O.organizationId, actor.organizationId))
          .orderBy(desc(O.windowEnd))
          .limit(500);
        const mapped = rows
          .filter((r) => {
            if (filter.pathogen && r.pathogen !== filter.pathogen) return false;
            if (filter.status && outbreakStatus(r.status) !== filter.status) return false;
            return true;
          })
          .map((r) => ({
            ...mapOutbreak(r),
            createdAt: isoReq(r.windowEnd),
            id: r.id,
          }));
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<InfectionOutbreakView>;
      });
    },

    // ── Risk register (R-95) ───────────────────────────────────────────────────────────────────────────
    async listRiskRegister(actor, filter, cursor, limit) {
      return read(actor, async (tx) => {
        const sources = await new RiskRegisterRepository(tx).loadOpenRiskSources(
          actor.organizationId,
        );
        const rows = buildRiskRegister(sources);
        const sourceMap: Record<string, RiskRegisterEntryView["source"]> = {
          sra_finding: "sra",
          incident_report: "incident",
          qapi_project: "qapi",
          cop_compliance_status: "cop",
        };
        const mapped = rows
          .map((r) => ({
            entryId: `${r.sourceKind}:${r.sourceId}`,
            organizationId: r.organizationId,
            source: sourceMap[r.sourceKind] ?? "incident",
            sourceRef: r.sourceId,
            title: r.title,
            severity: r.severityBand,
            // The register unions only OPEN risks (D13), so every projected entry is open.
            status: "open",
            openedAt: r.openedAt,
            lastActivityAt: r.lastActivityAt,
            createdAt: r.lastActivityAt,
            id: `${r.sourceKind}:${r.sourceId}`,
          }))
          .filter((e) => {
            if (filter.source && e.source !== filter.source) return false;
            if (filter.severity && e.severity !== filter.severity) return false;
            return true;
          });
        const page = paginate(mapped, cursor, limit);
        return {
          ...page,
          items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d),
        } satisfies CursorPage<RiskRegisterEntryView>;
      });
    },
  };
}
