// @wardenx/quality · repositories — the safety-incident ledger: `incident_report` (falls, med errors,
// complaints, abuse allegations, exposures; PARTITIONED monthly by `occurred_at`, composite PK
// id + occurred_at; retention class `phi`) (M30 §3.3). ORG-SCOPED; the incident service wraps these in
// `withOrgContext` and the PHI list routes drive cursor pagination off `listByOrg` / `listForPatient`
// (keyset on (occurred_at, id) desc, §4.1.2). The free-text members of `kind_data` are audit-denylisted
// (§3.6). Auto-creation idempotency runs through `findByTriggeringEvent` (the per-leaf partial-unique).
import { schema } from "@wardenx/db";
import { and, desc, eq, lt, ne, or, type SQL } from "drizzle-orm";
import type { QualityDb } from "./db";

const I = schema.incidentReport;

/** A keyset cursor over the partitioned `incident_report` read order (occurred_at desc, id desc). */
export interface IncidentCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** Build the keyset predicate for "strictly older than the cursor" on (occurred_at, id) desc. */
function olderThan(cursor: IncidentCursor): SQL | undefined {
  return or(
    lt(I.occurredAt, cursor.occurredAt),
    and(eq(I.occurredAt, cursor.occurredAt), lt(I.id, cursor.id)),
  );
}

/** Data port for `incident_report`. */
export class IncidentRepository {
  constructor(private readonly db: QualityDb) {}

  /** Insert an incident (defaults to `draft`). Returns the inserted row. */
  async create(values: schema.NewIncidentReport): Promise<schema.IncidentReport> {
    const [row] = await this.db.insert(I).values(values).returning();
    if (!row) throw new Error("incident_report insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + occurred_at, the partition key), or `null`. */
  async findById(id: string, occurredAt: Date): Promise<schema.IncidentReport | null> {
    const [row] = await this.db
      .select()
      .from(I)
      .where(and(eq(I.id, id), eq(I.occurredAt, occurredAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The auto-creation idempotency probe (the per-leaf `uq_incident_auto_creation` surface): the incident
   * already created from a triggering outbox event, or `null` — so a redelivered event no-ops.
   */
  async findByTriggeringEvent(
    triggeringEventOutboxId: string,
  ): Promise<schema.IncidentReport | null> {
    const [row] = await this.db
      .select()
      .from(I)
      .where(eq(I.triggeringEventOutboxId, triggeringEventOutboxId))
      .limit(1);
    return row ?? null;
  }

  /**
   * An org's incidents (PHI list, §4.1.2 cursor): optional kind/severity/lifecycle filters + a keyset
   * cursor; newest-occurred first. Returns one extra-bounded page; the service derives the next cursor
   * from the last row.
   */
  async listByOrg(
    organizationId: string,
    opts: {
      kind?: schema.IncidentReport["kind"];
      severity?: schema.IncidentReport["severity"];
      lifecycle?: schema.IncidentReport["lifecycle"];
      cursor?: IncidentCursor;
      limit?: number;
    } = {},
  ): Promise<readonly schema.IncidentReport[]> {
    const where = and(
      eq(I.organizationId, organizationId),
      opts.kind ? eq(I.kind, opts.kind) : undefined,
      opts.severity ? eq(I.severity, opts.severity) : undefined,
      opts.lifecycle ? eq(I.lifecycle, opts.lifecycle) : undefined,
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(I)
      .where(where)
      .orderBy(desc(I.occurredAt), desc(I.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** A patient's incidents (PHI list, §3.4 `idx_incident_by_patient`), keyset-paged, newest-occurred first. */
  async listForPatient(
    organizationId: string,
    patientId: string,
    opts: { cursor?: IncidentCursor; limit?: number } = {},
  ): Promise<readonly schema.IncidentReport[]> {
    const where = and(
      eq(I.organizationId, organizationId),
      eq(I.patientId, patientId),
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(I)
      .where(where)
      .orderBy(desc(I.occurredAt), desc(I.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /**
   * The open-incident worklist for an org (§3.4 partial `idx_incident_open_for_org`): incidents not yet
   * `closed_followup_complete`, optionally narrowed by severity, newest-occurred first.
   */
  async listOpenForOrg(
    organizationId: string,
    opts: { severity?: schema.IncidentReport["severity"]; limit?: number } = {},
  ): Promise<readonly schema.IncidentReport[]> {
    const where = and(
      eq(I.organizationId, organizationId),
      ne(I.lifecycle, "closed_followup_complete"),
      opts.severity ? eq(I.severity, opts.severity) : undefined,
    );
    return this.db
      .select()
      .from(I)
      .where(where)
      .orderBy(desc(I.occurredAt), desc(I.id))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** Transition / edit an incident. Scoped by the composite PK (id + occurred_at). */
  async update(
    id: string,
    occurredAt: Date,
    patch: Partial<
      Pick<
        schema.NewIncidentReport,
        | "kindData"
        | "severity"
        | "lifecycle"
        | "mandatoryReportFlag"
        | "externalReportRef"
        | "externalReportFiledAt"
        | "correctiveActionTakenText"
        | "linkedQapiProjectId"
        | "triagedByMembershipId"
        | "triagedAt"
        | "closedAt"
        | "reopenedAt"
        | "reopenReason"
        | "documentId"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.IncidentReport> {
    const [row] = await this.db
      .update(I)
      .set(patch)
      .where(and(eq(I.id, id), eq(I.occurredAt, occurredAt)))
      .returning();
    if (!row) throw new Error(`incident_report ${id}@${occurredAt.toISOString()} not found for update`);
    return row;
  }
}
