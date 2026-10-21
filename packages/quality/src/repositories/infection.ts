// @chartwarden/quality · repositories — the infection-surveillance subdomain: `infection_surveillance_event`
// (per-event infection/exposure observations feeding outbreak detection; PARTITIONED monthly by
// `observed_at`, composite PK id + observed_at; retention class `phi`) and `infection_outbreak_case`
// (the SERVER-CREATED-ONLY detected cluster over a (pathogen, body_site, window); non-partitioned)
// (M30 §3.3, §7.8). ORG-SCOPED; the surveillance/outbreak service wraps these in `withOrgContext`.
// `exposure_source` (free-text identifying) is audit-denylisted (§3.6). The ≥3-events/14d detector reads
// `listEventsForOutbreakWindow`; the outbreak case is idempotent on the V-18 window unique.
import { schema } from "@chartwarden/db";
import { type SQL, and, asc, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";
import type { QualityDb } from "./db";

const E = schema.infectionSurveillanceEvent;
const O = schema.infectionOutbreakCase;

/** A keyset cursor over the partitioned `infection_surveillance_event` read order (observed_at desc, id desc). */
export interface InfectionEventCursor {
  readonly observedAt: Date;
  readonly id: string;
}

function olderThan(cursor: InfectionEventCursor): SQL | undefined {
  return or(
    lt(E.observedAt, cursor.observedAt),
    and(eq(E.observedAt, cursor.observedAt), lt(E.id, cursor.id)),
  );
}

/** Data port for the two infection tables (surveillance event · outbreak case). */
export class InfectionRepository {
  constructor(private readonly db: QualityDb) {}

  // ── infection_surveillance_event (PARTITIONED monthly by observed_at) ────────────────────────────

  /** Insert a surveillance event. Returns the inserted row. */
  async insertEvent(
    values: schema.NewInfectionSurveillanceEvent,
  ): Promise<schema.InfectionSurveillanceEvent> {
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("infection_surveillance_event insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + observed_at, the partition key), or `null`. */
  async findEventById(
    id: string,
    observedAt: Date,
  ): Promise<schema.InfectionSurveillanceEvent | null> {
    const [row] = await this.db
      .select()
      .from(E)
      .where(and(eq(E.id, id), eq(E.observedAt, observedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The outbreak-detector window scan (§3.4 `idx_infection_outbreak_lookup`): the events for a
   * (provider, pathogen, body_site) whose `observed_at` falls within [windowStart, windowEnd], oldest
   * first — the ≥3-events/14d detector counts these.
   */
  async listEventsForOutbreakWindow(
    providerEntityId: string,
    pathogen: string,
    bodySite: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<readonly schema.InfectionSurveillanceEvent[]> {
    return this.db
      .select()
      .from(E)
      .where(
        and(
          eq(E.providerEntityId, providerEntityId),
          eq(E.pathogen, pathogen),
          eq(E.bodySite, bodySite),
          gte(E.observedAt, windowStart),
          lte(E.observedAt, windowEnd),
        ),
      )
      .orderBy(asc(E.observedAt));
  }

  /**
   * The ORG-WIDE trailing-window scan the `m30.outbreak_detection` worker's detector consumes (§7.8 /
   * D11): every surveillance event in the org observed at or after `windowStart`, oldest first.
   *
   * Distinct from both neighbours on purpose. {@link listEventsForOutbreakWindow} spans ONE
   * (provider, pathogen, body_site) triple — enough for the write path's inline re-check of the triple
   * the just-recorded event belongs to, but blind to a cluster forming on any OTHER triple; the worker
   * re-runs the detector over the whole org so it sees them all, and the pure
   * `detectOutbreakClusters` does the grouping. {@link listEventsForOrg} is the §4.1.2 keyset-paged
   * PHI list — a page boundary would silently truncate the detector's input set, so this read is NOT
   * paged: its bound is the window (14 days), not a page size.
   */
  async listEventsForOrgWindow(
    organizationId: string,
    windowStart: Date,
  ): Promise<readonly schema.InfectionSurveillanceEvent[]> {
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), gte(E.observedAt, windowStart)))
      .orderBy(asc(E.observedAt), asc(E.id));
  }

  /** An org's surveillance events (PHI list, §4.1.2 cursor), keyset-paged, newest-observed first. */
  async listEventsForOrg(
    organizationId: string,
    opts: { cursor?: InfectionEventCursor; limit?: number } = {},
  ): Promise<readonly schema.InfectionSurveillanceEvent[]> {
    const where = and(
      eq(E.organizationId, organizationId),
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(E)
      .where(where)
      .orderBy(desc(E.observedAt), desc(E.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** A patient's surveillance events (PHI list), keyset-paged, newest-observed first. */
  async listEventsForPatient(
    organizationId: string,
    patientId: string,
    opts: { cursor?: InfectionEventCursor; limit?: number } = {},
  ): Promise<readonly schema.InfectionSurveillanceEvent[]> {
    const where = and(
      eq(E.organizationId, organizationId),
      eq(E.patientId, patientId),
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(E)
      .where(where)
      .orderBy(desc(E.observedAt), desc(E.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  // ── infection_outbreak_case (server-created only) ───────────────────────────────────────────────

  /**
   * Create a detected outbreak case (server-only, V-18) idempotently on the (provider, pathogen,
   * body_site, window) unique: a concurrent detector that loses the race no-ops onto the existing row.
   * Returns the freshly-inserted case, or the pre-existing one on a conflict.
   */
  async createOutbreak(
    values: schema.NewInfectionOutbreakCase,
  ): Promise<schema.InfectionOutbreakCase> {
    const [inserted] = await this.db
      .insert(O)
      .values(values)
      .onConflictDoNothing({
        target: [O.providerEntityId, O.pathogen, O.bodySite, O.windowStart, O.windowEnd],
      })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findOutbreakByWindow(
      values.providerEntityId,
      values.pathogen,
      values.bodySite,
      values.windowStart,
      values.windowEnd,
    );
    if (!existing)
      throw new Error("infection_outbreak_case create produced neither insert nor hit");
    return existing;
  }

  async findOutbreakById(id: string): Promise<schema.InfectionOutbreakCase | null> {
    const [row] = await this.db.select().from(O).where(eq(O.id, id)).limit(1);
    return row ?? null;
  }

  /** The outbreak case for a (provider, pathogen, body_site, window) (the V-18 unique), or `null`. */
  async findOutbreakByWindow(
    providerEntityId: string,
    pathogen: string,
    bodySite: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<schema.InfectionOutbreakCase | null> {
    const [row] = await this.db
      .select()
      .from(O)
      .where(
        and(
          eq(O.providerEntityId, providerEntityId),
          eq(O.pathogen, pathogen),
          eq(O.bodySite, bodySite),
          eq(O.windowStart, windowStart),
          eq(O.windowEnd, windowEnd),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** An org's not-yet-closed outbreak cases (optionally a single status), newest window first. */
  async listOpenOutbreaks(
    organizationId: string,
    status?: schema.InfectionOutbreakCase["status"],
  ): Promise<readonly schema.InfectionOutbreakCase[]> {
    const where = and(
      eq(O.organizationId, organizationId),
      status ? eq(O.status, status) : inArray(O.status, ["open", "idg_reviewed", "contained"]),
    );
    return this.db.select().from(O).where(where).orderBy(desc(O.windowEnd));
  }

  /** Transition an outbreak case (IDG review → contained → closed) + monitoring stamps. */
  async updateOutbreak(
    id: string,
    patch: Partial<
      Pick<
        schema.NewInfectionOutbreakCase,
        | "status"
        | "idgReviewRequiredAt"
        | "idgReviewedAt"
        | "containedAt"
        | "containedAttestationMembershipId"
        | "nextMonitoringDueAt"
        | "closedAt"
      >
    >,
  ): Promise<schema.InfectionOutbreakCase> {
    const [row] = await this.db.update(O).set(patch).where(eq(O.id, id)).returning();
    if (!row) throw new Error(`infection_outbreak_case ${id} not found for update`);
    return row;
  }
}
