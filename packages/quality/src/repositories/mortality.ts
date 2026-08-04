// @wardenx/quality · repositories — the post-death review ledger: `mortality_review` (the structured
// clinical/satisfaction/compliance review created once per admission via an idempotent death event;
// PARTITIONED monthly by `death_at`, composite PK id + death_at; retention class `phi`) (M30 §3.3).
// ORG-SCOPED; the mortality service wraps these in `withOrgContext` and the PHI list routes drive cursor
// pagination off `listByOrg` / `listForPatient` (keyset on (death_at, id) desc, §4.1.2). The free-text
// dimension members are audit-denylisted (§3.6). Auto-creation idempotency runs through
// `findByIdempotencyKey` + the per-admission `findByAdmission` (the per-leaf UNIQUEs).
import { schema } from "@wardenx/db";
import { type SQL, and, desc, eq, lt, ne, or } from "drizzle-orm";
import type { QualityDb } from "./db";

const M = schema.mortalityReview;

/** A keyset cursor over the partitioned `mortality_review` read order (death_at desc, id desc). */
export interface MortalityCursor {
  readonly deathAt: Date;
  readonly id: string;
}

/** Build the keyset predicate for "strictly older than the cursor" on (death_at, id) desc. */
function olderThan(cursor: MortalityCursor): SQL | undefined {
  return or(lt(M.deathAt, cursor.deathAt), and(eq(M.deathAt, cursor.deathAt), lt(M.id, cursor.id)));
}

/** Data port for `mortality_review`. */
export class MortalityReviewRepository {
  constructor(private readonly db: QualityDb) {}

  /** Insert a review (defaults to `pending`). Returns the inserted row. */
  async create(values: schema.NewMortalityReview): Promise<schema.MortalityReview> {
    const [row] = await this.db.insert(M).values(values).returning();
    if (!row) throw new Error("mortality_review insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + death_at, the partition key), or `null`. */
  async findById(id: string, deathAt: Date): Promise<schema.MortalityReview | null> {
    const [row] = await this.db
      .select()
      .from(M)
      .where(and(eq(M.id, id), eq(M.deathAt, deathAt)))
      .limit(1);
    return row ?? null;
  }

  /** The per-admission review (the per-leaf `uq_mortality_review_per_admission` surface), or `null`. */
  async findByAdmission(admissionId: string): Promise<schema.MortalityReview | null> {
    const [row] = await this.db.select().from(M).where(eq(M.admissionId, admissionId)).limit(1);
    return row ?? null;
  }

  /**
   * The auto-creation idempotency probe (the per-leaf `uq_mortality_review_idem` surface): the review
   * already created from a death event's idempotency key, or `null` — so a redelivered event no-ops.
   */
  async findByIdempotencyKey(
    createdViaEventIdempotencyKey: string,
  ): Promise<schema.MortalityReview | null> {
    const [row] = await this.db
      .select()
      .from(M)
      .where(eq(M.createdViaEventIdempotencyKey, createdViaEventIdempotencyKey))
      .limit(1);
    return row ?? null;
  }

  /** An org's reviews (PHI list, §4.1.2 cursor): optional status filter + keyset cursor, newest-death first. */
  async listByOrg(
    organizationId: string,
    opts: {
      status?: schema.MortalityReview["status"];
      cursor?: MortalityCursor;
      limit?: number;
    } = {},
  ): Promise<readonly schema.MortalityReview[]> {
    const where = and(
      eq(M.organizationId, organizationId),
      opts.status ? eq(M.status, opts.status) : undefined,
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(M)
      .where(where)
      .orderBy(desc(M.deathAt), desc(M.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /** A patient's reviews (PHI list), keyset-paged, newest-death first. */
  async listForPatient(
    organizationId: string,
    deceasedPatientId: string,
    opts: { cursor?: MortalityCursor; limit?: number } = {},
  ): Promise<readonly schema.MortalityReview[]> {
    const where = and(
      eq(M.organizationId, organizationId),
      eq(M.deceasedPatientId, deceasedPatientId),
      opts.cursor ? olderThan(opts.cursor) : undefined,
    );
    return this.db
      .select()
      .from(M)
      .where(where)
      .orderBy(desc(M.deathAt), desc(M.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /**
   * The overdue worklist: not-yet-completed reviews whose `target_completion_at < asOf` (the
   * mortality-review-overdue alert source), oldest-target first.
   */
  async listOverdue(
    organizationId: string,
    asOf: Date = new Date(),
    limit = 100,
  ): Promise<readonly schema.MortalityReview[]> {
    return this.db
      .select()
      .from(M)
      .where(
        and(
          eq(M.organizationId, organizationId),
          ne(M.status, "completed"),
          lt(M.targetCompletionAt, asOf),
        ),
      )
      .orderBy(M.targetCompletionAt)
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Transition / edit a review. Scoped by the composite PK (id + death_at). */
  async update(
    id: string,
    deathAt: Date,
    patch: Partial<
      Pick<
        schema.NewMortalityReview,
        | "status"
        | "assignedReviewerMembershipId"
        | "clinicalDimensionData"
        | "satisfactionDimensionData"
        | "complianceDimensionData"
        | "reviewerSignatureAt"
        | "targetCompletionAt"
        | "completedAt"
        | "linkedQapiProjectId"
        | "documentId"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.MortalityReview> {
    const [row] = await this.db
      .update(M)
      .set(patch)
      .where(and(eq(M.id, id), eq(M.deathAt, deathAt)))
      .returning();
    if (!row)
      throw new Error(`mortality_review ${id}@${deathAt.toISOString()} not found for update`);
    return row;
  }
}
