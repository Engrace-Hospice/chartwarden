// @wardenx/quality — concrete implementations of the FIVE PUBLISHED seams (M30 §4.3).
//
// The seam INTERFACES live in `../../seams` (QualityMeasureProvider / IncidentRegisterProvider /
// QapiProjectProvider / ComplianceStatusProvider / SecurityRiskAssessmentReader); these are the live
// Drizzle-backed classes the composition root binds into the M1 SeamRegistry at boot (P2C) over the
// Phase-0 deny-stub. Every read opens its OWN `withOrgContext` transaction (the seam consumers — M22 /
// M28 / M33 / M34 — call these OUTSIDE M30's own request pipeline, so each impl owns its tenancy scope,
// §4.3 / D3) and delegates to the package repositories. Reads are aggregate-by-default (D6) — the only
// patient-linked surface is `IncidentRegisterProvider`, whose PHI methods carry the caller's actor
// context and require the caller to hold patient scope.
//
// PORT-INJECTED (the package's no-apps-backend-edge posture): each impl takes the M1 primary `DbClient`
// it runs `withOrgContext` over, a `systemUserId` (the platform system actor the org-scoped aggregate
// reads bind to `app.user_id`), and an OPTIONAL `providerEntities(orgId)` resolver — the per-PE
// aggregation grain comes from M40's `ProviderEntityReader` (a CONSUMED seam), so the composition root
// binds it at P2C. UNBOUND ⇒ no provider entities resolve and the per-PE aggregates collapse to empty
// (fail-closed: a not-yet-bound PE resolver never fabricates a cross-provider number, D6 / D13).
import type { DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import type {
  ComplianceStatus,
  Incident,
  IncidentKind,
  IncidentSeverity,
  IncidentState,
  MeasureId,
  MeasurePeriod,
  MeasureValue,
  MeasureValueSnapshot,
  QapiProject,
  QapiProjectPhase,
  SraCycle,
} from "../../contracts";
import { listMeasureCatalog as listMeasureCatalogEntries } from "../../measures/registry";
import {
  CopComplianceRepository,
  IncidentRepository,
  QapiRepository,
  QualityMeasureValueRepository,
  SraRepository,
} from "../../repositories/index";
import type {
  ComplianceStatusProvider,
  IncidentRegisterProvider,
  QapiProjectProvider,
  QualityMeasureProvider,
  SecurityRiskAssessmentReader,
} from "../../seams";

// ── shared deps ──────────────────────────────────────────────────────────────────────────────────────

/** The tenancy + per-PE-resolution ports every published-seam impl runs its org-scoped reads under (§4.3). */
export interface QualityPublishedSeamDeps {
  /** The M1 PRIMARY `DbClient` each read opens its own `withOrgContext` transaction over (§4.3 / D3). */
  readonly db: DbClient;
  /** The platform system actor bound to `app.user_id` for the aggregate (actor-less) seam reads. */
  readonly systemUserId: string;
  /**
   * Resolves the org's provider-entity ids (the per-PE aggregation grain, M40 `ProviderEntityReader`).
   * UNBOUND ⇒ `[]` — the per-PE aggregates collapse to empty rather than fabricating a number (D6 / D13).
   */
  readonly providerEntities?: (organizationId: string) => Promise<readonly string[]>;
}

/** The Drizzle tx type each `withOrgContext` body runs the repositories on (the M1 primary handle). */
type SeamTx = DbClient;

/** Resolve the org's provider-entity ids (UNBOUND resolver ⇒ `[]`, fail-closed). */
async function resolveProviderEntities(
  deps: QualityPublishedSeamDeps,
  organizationId: string,
): Promise<readonly string[]> {
  if (!deps.providerEntities) return [];
  return deps.providerEntities(organizationId);
}

// ── 1. QualityMeasureProvider ──────────────────────────────────────────────────────────────────────────

/**
 * The live `QualityMeasureProvider` seam (§4.3) — the HQRP measure read surface M22 (report rendering),
 * M28 (FHIR `MeasureReport`), M33 (executive dashboards), and M34 (FY-rollover tenant gate) consume.
 * Aggregate-only: it never returns patient-level rows (the `quality_measure_value` ledger carries no PHI).
 * The org-level latest/series reads fold across the org's provider entities (resolved via the injected
 * M40 PE resolver) and pick the newest CURRENT (`superseded_at IS NULL`) row; `listMeasureCatalog` is the
 * pure platform measure registry (the codes the worker computes for a fiscal year, §3.1).
 */
export class QualityMeasureProviderImpl implements QualityMeasureProvider {
  constructor(private readonly deps: QualityPublishedSeamDeps) {}

  private read<T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> {
    return withOrgContext<SeamTx, T>(
      this.deps.db,
      { organizationId, userId: this.deps.systemUserId },
      fn,
    );
  }

  async getLatestValue(
    orgId: string,
    measureId: MeasureId,
    period: MeasurePeriod,
  ): Promise<MeasureValue | null> {
    const periodStart = new Date(period.start);
    const periodEnd = new Date(period.end);
    const entities = await resolveProviderEntities(this.deps, orgId);
    return this.read(orgId, async (tx) => {
      const repo = new QualityMeasureValueRepository(tx);
      let latest: schema.QualityMeasureValue | null = null;
      for (const providerEntityId of entities) {
        const row = await repo.findCurrent(measureId, providerEntityId, periodStart, periodEnd);
        if (row && (!latest || row.computedAt > latest.computedAt)) latest = row;
      }
      return latest;
    });
  }

  async getValueSeries(
    orgId: string,
    measureId: MeasureId,
    windowStart: string,
    windowEnd: string,
  ): Promise<MeasureValue[]> {
    const from = new Date(windowStart);
    const to = new Date(windowEnd);
    const entities = await resolveProviderEntities(this.deps, orgId);
    return this.read(orgId, async (tx) => {
      const repo = new QualityMeasureValueRepository(tx);
      const out: schema.QualityMeasureValue[] = [];
      for (const providerEntityId of entities) {
        const rows = await repo.listCurrentForProvider(orgId, providerEntityId, {
          measureCode: measureId,
        });
        for (const row of rows) {
          if (row.periodEnd >= from && row.periodEnd <= to) out.push(row);
        }
      }
      // Newest period first across the folded provider entities.
      return out.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
    });
  }

  async getSnapshot(orgId: string, valueId: string): Promise<MeasureValueSnapshot> {
    return this.read(orgId, async (tx) => {
      const row = await new QualityMeasureValueRepository(tx).findById(valueId);
      // Throw (not redact) on a cross-org / unknown value id — the snapshot is a reproducibility audit
      // surface the caller must own; RLS already scopes the read, this is the explicit §4.3 guard.
      if (!row || row.organizationId !== orgId) {
        throw new NotFoundError(`quality_measure_value ${valueId} not found in org`);
      }
      return {
        valueId: row.id,
        measureCode: row.measureCode,
        snapshotContentHash: row.snapshotContentHash,
        calculatorVersion: row.calculatorVersion,
        computedAt: row.computedAt.toISOString(),
        snapshot: row.computationSnapshot,
      };
    });
  }

  async listMeasureCatalog(fiscalYear: number): Promise<MeasureId[]> {
    // The platform measure catalog is the pure registry (no org scope, no DB) — the codes the worker
    // computes for FY ≥ each measure's activation year (§3.1).
    return listMeasureCatalogEntries(fiscalYear).map((entry) => entry.code);
  }
}

// ── 2. IncidentRegisterProvider ──────────────────────────────────────────────────────────────────────────

const INCIDENT_KINDS: readonly IncidentKind[] = [
  "fall",
  "medication_error",
  "complaint",
  "allegation_of_abuse",
  "exposure_event",
  "other_safety_event",
];
const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = [
  "minor",
  "moderate",
  "severe",
  "critical",
];

/**
 * The live `IncidentRegisterProvider` seam (§4.3) — the incident register M22 (incident reports), M28
 * (FHIR `AdverseEvent`), and M33 (incident dashboards) consume. PHI surface: `listIncidents` / `getIncident`
 * return patient-linked rows, so the caller MUST hold patient scope (the route layer enforces
 * `requirePatientScope()` + the §4.7 predicates; this impl runs under the caller's actor in `withOrgContext`
 * so RLS narrows the rows). `countIncidents` is aggregate-only (no patient leak). The repo `listByOrg`
 * applies single-valued kind/severity/lifecycle filters at the DB; the seam's array filters + the occurred
 * window are folded in memory over the returned page.
 */
export class IncidentRegisterProviderImpl implements IncidentRegisterProvider {
  constructor(private readonly deps: QualityPublishedSeamDeps) {}

  async listIncidents(
    orgId: string,
    filter: {
      kinds?: IncidentKind[];
      states?: IncidentState[];
      severities?: IncidentSeverity[];
      occurredAfter?: string;
      occurredBefore?: string;
      patientId?: string;
    },
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident[]> {
    const after = filter.occurredAfter ? new Date(filter.occurredAfter) : undefined;
    const before = filter.occurredBefore ? new Date(filter.occurredBefore) : undefined;
    const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
    const states = filter.states && filter.states.length > 0 ? new Set(filter.states) : null;
    const severities =
      filter.severities && filter.severities.length > 0 ? new Set(filter.severities) : null;

    return withOrgContext<SeamTx, Incident[]>(
      this.deps.db,
      { organizationId: orgId, userId: actorContext.actorId },
      async (tx) => {
        const repo = new IncidentRepository(tx);
        const rows = filter.patientId
          ? await repo.listForPatient(orgId, filter.patientId, { limit: 200 })
          : await repo.listByOrg(orgId, { limit: 200 });
        return rows.filter((row) => {
          if (kinds && !kinds.has(row.kind)) return false;
          if (states && !states.has(row.lifecycle)) return false;
          if (severities && !severities.has(row.severity)) return false;
          if (after && row.occurredAt < after) return false;
          if (before && row.occurredAt > before) return false;
          return true;
        });
      },
    );
  }

  async getIncident(
    incidentId: string,
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident> {
    // The `incident_report` PK is composite (id + occurred_at, the partition key); the seam's id-only
    // point read cannot resolve the partition without the occurred_at, and the actor context carries no
    // org scope. The in-module point read (route R-50 `GET /incidents/:id`) supplies org + occurred_at +
    // patient scope and is the supported path; this cross-module seam point read binds to that route
    // service at P2C. Until then it fails closed (NotFound) rather than scanning every partition.
    void actorContext;
    throw new NotFoundError(
      `incident ${incidentId} point-read requires org + occurred_at partition scope (bound at P2C)`,
    );
  }

  async countIncidents(
    orgId: string,
    period: { start: string; end: string },
  ): Promise<{ kind: IncidentKind; severity: IncidentSeverity; n: number }[]> {
    const start = new Date(period.start);
    const end = new Date(period.end);
    return withOrgContext<SeamTx, { kind: IncidentKind; severity: IncidentSeverity; n: number }[]>(
      this.deps.db,
      { organizationId: orgId, userId: this.deps.systemUserId },
      async (tx) => {
        const repo = new IncidentRepository(tx);
        // Aggregate-only — fold the org's incidents in the window into kind×severity counts (no row leak).
        const counts = new Map<string, number>();
        for (const kind of INCIDENT_KINDS) {
          const rows = await repo.listByOrg(orgId, { kind, limit: 200 });
          for (const row of rows) {
            if (row.occurredAt < start || row.occurredAt > end) continue;
            const key = `${row.kind} ${row.severity}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        const out: { kind: IncidentKind; severity: IncidentSeverity; n: number }[] = [];
        for (const kind of INCIDENT_KINDS) {
          for (const severity of INCIDENT_SEVERITIES) {
            const n = counts.get(`${kind} ${severity}`) ?? 0;
            if (n > 0) out.push({ kind, severity, n });
          }
        }
        return out;
      },
    );
  }
}

// ── 3. QapiProjectProvider ───────────────────────────────────────────────────────────────────────────────

/**
 * The live `QapiProjectProvider` seam (§4.3) — the QAPI program/project read surface M22 (minutes /
 * charter rendering) and M33 (QAPI status widgets) consume. Aggregate-only. Org-level project listing
 * folds across the org's programs; `getProject` throws on a cross-org / unknown id; the indicator linkage
 * powers the trace from a `quality_measure_value` to the PI activity that owns the indicator.
 */
export class QapiProjectProviderImpl implements QapiProjectProvider {
  constructor(private readonly deps: QualityPublishedSeamDeps) {}

  private read<T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> {
    return withOrgContext<SeamTx, T>(
      this.deps.db,
      { organizationId, userId: this.deps.systemUserId },
      fn,
    );
  }

  async listActivePrograms(
    orgId: string,
  ): Promise<{ programId: string; year: number; charterAdoptedAt: string }[]> {
    return this.read(orgId, async (tx) => {
      const programs = await new QapiRepository(tx).listPrograms(orgId);
      return programs
        .filter((p) => !p.closed)
        .map((p) => ({
          programId: p.id,
          year: p.planYear,
          // The charter-adoption timestamp; programs not yet attested fall back to row creation.
          charterAdoptedAt: p.createdAt.toISOString(),
        }));
    });
  }

  async listProjects(
    orgId: string,
    filter: { phases?: QapiProjectPhase[]; programId?: string },
  ): Promise<QapiProject[]> {
    const phases = filter.phases && filter.phases.length > 0 ? new Set(filter.phases) : null;
    return this.read(orgId, async (tx) => {
      const repo = new QapiRepository(tx);
      const programs = filter.programId
        ? [await repo.findProgramById(filter.programId)].filter(
            (p): p is schema.QapiProgram => !!p && p.organizationId === orgId,
          )
        : (await repo.listPrograms(orgId)).slice();
      const out: schema.QapiProject[] = [];
      for (const program of programs) {
        const projects = await repo.listProjects(program.id);
        for (const project of projects) {
          if (phases && !phases.has(project.status)) continue;
          out.push(project);
        }
      }
      return out;
    });
  }

  async getProject(orgId: string, projectId: string): Promise<QapiProject> {
    return this.read(orgId, async (tx) => {
      const row = await new QapiRepository(tx).findProjectById(projectId);
      if (!row || row.organizationId !== orgId) {
        throw new NotFoundError(`qapi_project ${projectId} not found in org`);
      }
      return row;
    });
  }

  async findProjectsForIndicator(orgId: string, indicatorId: string): Promise<QapiProject[]> {
    return this.read(orgId, async (tx) => {
      const repo = new QapiRepository(tx);
      const programs = await repo.listPrograms(orgId);
      const out: schema.QapiProject[] = [];
      for (const program of programs) {
        const projects = await repo.listProjects(program.id);
        for (const project of projects) {
          if (project.linkedIndicatorId === indicatorId) out.push(project);
        }
      }
      return out;
    });
  }
}

// ── 4. ComplianceStatusProvider ──────────────────────────────────────────────────────────────────────────

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 183;
const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * The live `ComplianceStatusProvider` seam (§4.3) — the CoP/SRA compliance posture M34 (FY-rollover tenant
 * gate) and M33 (compliance widgets) consume. Aggregate-only: it returns categorical status, never the
 * underlying PHI. `getCopStatusByOrg` folds the per-PE citation rows across the org's provider entities;
 * `isOrgCopReadyForFy` is the FY-readiness gate (every citation `compliant` AND reviewed ≤6 months ago);
 * `isSraFresh` is the annual-SRA freshness check (most-recent cycle closed AND ≤365 days old).
 */
export class ComplianceStatusProviderImpl implements ComplianceStatusProvider {
  constructor(private readonly deps: QualityPublishedSeamDeps) {}

  private read<T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> {
    return withOrgContext<SeamTx, T>(
      this.deps.db,
      { organizationId, userId: this.deps.systemUserId },
      fn,
    );
  }

  async getCopStatusByOrg(orgId: string): Promise<ComplianceStatus[]> {
    const entities = await resolveProviderEntities(this.deps, orgId);
    return this.read(orgId, async (tx) => {
      const repo = new CopComplianceRepository(tx);
      const out: schema.CopComplianceStatus[] = [];
      for (const providerEntityId of entities) {
        const rows = await repo.listForProvider(orgId, providerEntityId);
        out.push(...rows);
      }
      return out;
    });
  }

  async isOrgCopReadyForFy(
    orgId: string,
    fiscalYear: number,
  ): Promise<{ ready: boolean; blockers: { citationId: string; reason: string }[] }> {
    void fiscalYear; // the readiness predicate is FY-agnostic today (status + 6-month review freshness).
    const rows = await this.getCopStatusByOrg(orgId);
    const now = Date.now();
    const blockers: { citationId: string; reason: string }[] = [];
    for (const row of rows) {
      if (row.status !== "compliant") {
        blockers.push({ citationId: row.copCitation, reason: `status_${row.status}` });
        continue;
      }
      const reviewedAtMs = row.lastReviewedAt ? row.lastReviewedAt.getTime() : null;
      if (reviewedAtMs === null || now - reviewedAtMs > SIX_MONTHS_MS) {
        blockers.push({ citationId: row.copCitation, reason: "review_stale" });
      }
    }
    return { ready: blockers.length === 0, blockers };
  }

  async isSraFresh(
    orgId: string,
  ): Promise<{ fresh: boolean; lastCycleClosedAt: string | null; daysSinceClose: number | null }> {
    return this.read(orgId, async (tx) => {
      const cycles = await new SraRepository(tx).listCycles(orgId);
      // listCycles is newest-cycle-year first; the freshness gate reads the most-recent CLOSED cycle.
      const closed = cycles.filter((c) => c.status === "closed" && c.closedAt);
      const latest = closed.reduce<schema.SraCycle | null>((best, c) => {
        if (!c.closedAt) return best;
        if (!best || !best.closedAt || c.closedAt > best.closedAt) return c;
        return best;
      }, null);
      if (!latest || !latest.closedAt) {
        return { fresh: false, lastCycleClosedAt: null, daysSinceClose: null };
      }
      const sinceMs = Date.now() - latest.closedAt.getTime();
      const daysSinceClose = Math.floor(sinceMs / (1000 * 60 * 60 * 24));
      return {
        fresh: sinceMs <= ONE_YEAR_MS,
        lastCycleClosedAt: latest.closedAt.toISOString(),
        daysSinceClose,
      };
    });
  }
}

// ── 5. SecurityRiskAssessmentReader ──────────────────────────────────────────────────────────────────────

/** Band a 5×5 SRA score (1–25) into the §4.3 risk band (the open-findings breakdown buckets). */
function bandOf5x5(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 20) return "critical";
  if (score >= 12) return "high";
  if (score >= 6) return "medium";
  return "low";
}

/**
 * The live `SecurityRiskAssessmentReader` seam (§4.3) — the SRA posture M33 (security dashboards) and M34
 * (tenant gate) consume. Aggregate-only: it exposes cycle status + open-finding band COUNTS, never the
 * denylisted finding detail (§3.6). `getCurrentCycle` is the most-recent non-closed cycle (or the newest
 * cycle if all are closed); `getOpenFindingsBands` bands the org's open findings by their residual 5×5 score.
 */
export class SecurityRiskAssessmentReaderImpl implements SecurityRiskAssessmentReader {
  constructor(private readonly deps: QualityPublishedSeamDeps) {}

  private read<T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> {
    return withOrgContext<SeamTx, T>(
      this.deps.db,
      { organizationId, userId: this.deps.systemUserId },
      fn,
    );
  }

  async listCycles(orgId: string): Promise<SraCycle[]> {
    return this.read(orgId, async (tx) => {
      const rows = await new SraRepository(tx).listCycles(orgId);
      return rows.slice();
    });
  }

  async getCurrentCycle(orgId: string): Promise<SraCycle | null> {
    return this.read(orgId, async (tx) => {
      const rows = await new SraRepository(tx).listCycles(orgId);
      // listCycles is newest-cycle-year first: prefer the most-recent OPEN cycle, else the newest cycle.
      const open = rows.find((c) => c.status !== "closed");
      return open ?? rows[0] ?? null;
    });
  }

  async getOpenFindingsBands(
    orgId: string,
  ): Promise<{ critical: number; high: number; medium: number; low: number }> {
    return this.read(orgId, async (tx) => {
      const findings = await new SraRepository(tx).listOpenFindingsForOrg(orgId);
      const bands = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const finding of findings) bands[bandOf5x5(finding.residual5x5Score)] += 1;
      return bands;
    });
  }
}
