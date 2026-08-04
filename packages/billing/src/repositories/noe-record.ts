// @wardenx/billing · repositories — `noe_record` (the Notice of Election root, §3.3; the §2.2 5-day-window
// fast path). ORG-SCOPED + VERSIONED — this repo mirrors the `claim` exemplar exactly: keyset-paginated org
// read, deterministic `(provider_entity, noe_control_number)` get, and the REDUCER-DRIVEN, version-checked
// `transitionToState` (§2.5 If-Match) the NOE service drives from `machines/noe`. The two demonstrate the
// same three db.ts conventions:
//   * ENUM CASE BOUNDARY — `noe_record.state` is UPPERCASE in the DB; this repo maps it through the shared
//     `noticeStateCodec` (NOE + NOTR share the frozen `NOE_NOTR_STATES` alphabet) on EVERY read
//     (`toNoeRecord`) and write, so callers only ever see the lowercase domain `NoticeState`.
//   * KEYSET CURSOR PAGINATION — `listByOrgPage` over-fetches `size + 1` rows `(created_at DESC, id DESC)`.
//   * OPTIMISTIC CONCURRENCY (§2.5) — `transitionToState` applies `state = nextState` + patch only when the
//     persisted `version` matches, else returns `VERSION_CONFLICT` (the service → 412).
//
// The 5-day-window watchdog cron enumerates in-flight rows past `window_target_at` via
// `listWindowWatchCandidates` (backed by the §3.4 `noe_window_watch_idx` partial index) and stamps
// `window_breached_at` through `transitionToState` (or a same-state patch). No PHI / no MBI (D13 / §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, isNull, lte, notInArray } from "drizzle-orm";
import type { NoticeState } from "../contracts";
import {
  type BillingDb,
  type CursorPage,
  type VersionedUpdateResult,
  buildCursorPage,
  decodeCursor,
  keysetBefore,
  noticeStateCodec,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./db";

const N = schema.noeRecord;

/** The domain-cased `noe_record` row: identical to `schema.NoeRecord` except `state` is lowercase `NoticeState`. */
export interface NoeRecord extends Omit<schema.NoeRecord, "state"> {
  readonly state: NoticeState;
}

/** Insert input: the Drizzle insert shape with `state` as the optional lowercase domain `NoticeState`. */
export type NewNoeInput = Omit<schema.NewNoeRecord, "state"> & { readonly state?: NoticeState };

/** List filter for {@link NoeRepository.listByOrgPage} (all optional; combined with AND). */
export interface NoeListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly state?: NoticeState;
}

/** The columns a NOE lifecycle transition may set alongside `state` (submission/ack/doc/window back-refs). */
export type NoeTransitionPatch = Partial<
  Pick<
    schema.NewNoeRecord,
    | "payerNoeControlNumber"
    | "latestSubmissionId"
    | "latestAcknowledgmentId"
    | "confirmationDocumentId"
    | "windowBreachedAt"
  >
>;

/** The NOE states that have left the 5-day window in flight (excluded from the watchdog scan + admission uq). */
const NOE_TERMINAL_DB: schema.NoeRecord["state"][] = ["ACK_ACCEPTED", "CANCELLED", "ACK_REJECTED"];

/** Map a DB row to the domain-cased record (the single read-boundary case translation). */
function toNoeRecord(row: schema.NoeRecord): NoeRecord {
  return { ...row, state: noticeStateCodec.fromDb(row.state) };
}

/** Data port for `noe_record` (org-scoped read + reducer-driven version-checked write; mirrors `claim`). */
export class NoeRepository {
  constructor(private readonly db: BillingDb) {}

  /** Insert a NOE (defaults to `draft`). Returns the domain-cased inserted record. */
  async create(input: NewNoeInput): Promise<NoeRecord> {
    const { state, ...rest } = input;
    const values: schema.NewNoeRecord = {
      ...rest,
      ...(state ? { state: noticeStateCodec.toDb(state) } : {}),
    };
    const [row] = await this.db.insert(N).values(values).returning();
    if (!row) throw new Error("noe_record insert returned no row");
    return toNoeRecord(row);
  }

  /** Point read by id, or `null` (domain-cased). */
  async findById(id: string): Promise<NoeRecord | null> {
    const [row] = await this.db.select().from(N).where(eq(N.id, id)).limit(1);
    return row ? toNoeRecord(row) : null;
  }

  /** The NOE for a deterministic `(provider_entity, noe_control_number)` (the D4 unique surface), or `null`. */
  async findByControlNumber(
    providerEntityId: string,
    noeControlNumber: string,
  ): Promise<NoeRecord | null> {
    const [row] = await this.db
      .select()
      .from(N)
      .where(
        and(eq(N.providerEntityId, providerEntityId), eq(N.noeControlNumber, noeControlNumber)),
      )
      .limit(1);
    return row ? toNoeRecord(row) : null;
  }

  /**
   * The live (non-terminal) NOE for an admission — the `noe_record_admission_uq` partial-unique slice, so at
   * most one row matches. Returns `null` when no in-flight NOE exists for the admission.
   */
  async findActiveByAdmission(admissionId: string): Promise<NoeRecord | null> {
    const [row] = await this.db
      .select()
      .from(N)
      .where(and(eq(N.admissionId, admissionId), notInArray(N.state, NOE_TERMINAL_DB)))
      .limit(1);
    return row ? toNoeRecord(row) : null;
  }

  /**
   * One keyset page of an org's NOEs (optionally narrowed by provider/patient/admission/state), `(created_at
   * DESC, id DESC)`. Over-fetches `size + 1` rows so {@link buildCursorPage} reveals `hasMore` + mints the
   * next cursor. RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listByOrgPage(
    organizationId: string,
    filter: NoeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<NoeRecord>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(N.organizationId, organizationId),
      filter.providerEntityId ? eq(N.providerEntityId, filter.providerEntityId) : undefined,
      filter.patientId ? eq(N.patientId, filter.patientId) : undefined,
      filter.admissionId ? eq(N.admissionId, filter.admissionId) : undefined,
      filter.state ? eq(N.state, noticeStateCodec.toDb(filter.state)) : undefined,
      keysetBefore(N.createdAt, N.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(N)
      .where(where)
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toNoeRecord), size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * The 5-day-window watchdog scan (§3.4 `noe_window_watch_idx`): an org's NOEs still in flight (state ∉
   * terminal) whose `window_target_at` has passed `asOf` and that have not yet been stamped breached. The
   * cron stamps `window_breached_at` via {@link transitionToState}. `asOf` is a `YYYY-MM-DD` (the `date`
   * column alphabet). Newest-target first.
   */
  async listWindowWatchCandidates(
    organizationId: string,
    asOf: string,
    limit = 200,
  ): Promise<readonly NoeRecord[]> {
    const rows = await this.db
      .select()
      .from(N)
      .where(
        and(
          eq(N.organizationId, organizationId),
          notInArray(N.state, NOE_TERMINAL_DB),
          lte(N.windowTargetAt, asOf),
          isNull(N.windowBreachedAt),
        ),
      )
      .orderBy(desc(N.windowTargetAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toNoeRecord);
  }

  /**
   * REDUCER-DRIVEN, version-checked transition (§2.5). The service computes `nextState` via
   * `reduce(state, event)` (machines/noe) and passes the current `expectedVersion` (If-Match); this applies
   * `state = nextState` + `patch` only when the persisted version matches, bumping `version` + `updated_at`.
   * On a mismatch returns `VERSION_CONFLICT` carrying the current persisted version (or `null` when the row
   * vanished) so the service can surface a 412. The state value is mapped to the DB enum here.
   */
  async transitionToState(
    id: string,
    expectedVersion: number,
    nextState: NoticeState,
    patch: NoeTransitionPatch = {},
  ): Promise<VersionedUpdateResult<NoeRecord>> {
    const [row] = await this.db
      .update(N)
      .set({
        ...patch,
        state: noticeStateCodec.toDb(nextState),
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(N.id, id), eq(N.version, expectedVersion)))
      .returning();
    if (row) return versionOk(toNoeRecord(row));
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}
