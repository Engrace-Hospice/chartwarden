// @wardenx/billing · repositories — `notr_record` (the Notice of Termination/Revocation root, §3.3; the
// §2.2 terminating-event fast path). ORG-SCOPED + VERSIONED — shape-identical to `noe-record` (NOE + NOTR
// share the frozen `NOE_NOTR_STATES` alphabet, so this repo reuses the same `noticeStateCodec`), plus the
// extra `trigger_kind` discriminator and its one-of-three event back-refs. The three db.ts conventions
// appear exactly as in `claim` / `noe-record`:
//   * ENUM CASE BOUNDARY — `notr_record.state` is UPPERCASE; mapped through `noticeStateCodec` on every
//     read/write so callers see only the lowercase domain `NoticeState`. `trigger_kind` is a DB-native
//     lowercase enum with no domain divergence (mirrors `validation_run.trigger`) → it passes through raw.
//   * KEYSET CURSOR PAGINATION — `listByOrgPage` over-fetches `size + 1` rows `(created_at DESC, id DESC)`.
//   * OPTIMISTIC CONCURRENCY (§2.5) — `transitionToState` is the reducer-driven, version-checked update.
//
// The timely-filing watchdog cron enumerates in-flight rows past `window_target_at` via
// `listWindowWatchCandidates` (§3.4 `notr_window_watch_idx`) and stamps `window_breached_at` through
// `transitionToState`. No PHI / no MBI (D13 / §8.7).
import * as schema from "@wardenx/db/schema";
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
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

const N = schema.notrRecord;

/** The DB-native NOTR trigger discriminator (`revocation` | `transfer_out` | `discharge`); no domain divergence. */
export type NotrTriggerKind = schema.NotrRecord["triggerKind"];

/** The domain-cased `notr_record` row: identical to `schema.NotrRecord` except `state` is lowercase `NoticeState`. */
export interface NotrRecord extends Omit<schema.NotrRecord, "state"> {
  readonly state: NoticeState;
}

/** Insert input: the Drizzle insert shape with `state` as the optional lowercase domain `NoticeState`. */
export type NewNotrInput = Omit<schema.NewNotrRecord, "state"> & { readonly state?: NoticeState };

/** List filter for {@link NotrRepository.listByOrgPage} (all optional; combined with AND). */
export interface NotrListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly triggerKind?: NotrTriggerKind;
  readonly state?: NoticeState;
}

/** The columns a NOTR lifecycle transition may set alongside `state` (submission/ack/doc/window back-refs). */
export type NotrTransitionPatch = Partial<
  Pick<
    schema.NewNotrRecord,
    | "payerNotrControlNumber"
    | "latestSubmissionId"
    | "latestAcknowledgmentId"
    | "confirmationDocumentId"
    | "windowBreachedAt"
    | "acceptedAt"
    | "rejectedAt"
    | "rejectionStage"
    | "rejectionCodes"
    | "payerStatusDate"
    | "payerStatusDateSource"
  >
>;

/** The NOTR states that have left the window in flight (excluded from the watchdog scan + per-event uq). */
const NOTR_TERMINAL_DB: schema.NotrRecord["state"][] = [
  "ACK_ACCEPTED",
  "CANCELLED",
  "ACK_REJECTED",
];

/** Map a DB row to the domain-cased record (the single read-boundary case translation). */
function toNotrRecord(row: schema.NotrRecord): NotrRecord {
  return { ...row, state: noticeStateCodec.fromDb(row.state) };
}

/** Data port for `notr_record` (org-scoped read + reducer-driven version-checked write; mirrors `claim`). */
export class NotrRepository {
  constructor(private readonly db: BillingDb) {}

  /** Insert a NOTR (defaults to `draft`). Returns the domain-cased inserted record. */
  async create(input: NewNotrInput): Promise<NotrRecord> {
    const { state, ...rest } = input;
    const values: schema.NewNotrRecord = {
      ...rest,
      ...(state ? { state: noticeStateCodec.toDb(state) } : {}),
    };
    const [row] = await this.db.insert(N).values(values).returning();
    if (!row) throw new Error("notr_record insert returned no row");
    return toNotrRecord(row);
  }

  /** Point read by id, or `null` (domain-cased). */
  async findById(id: string): Promise<NotrRecord | null> {
    const [row] = await this.db.select().from(N).where(eq(N.id, id)).limit(1);
    return row ? toNotrRecord(row) : null;
  }

  /** The NOTR for a deterministic `(provider_entity, notr_control_number)` (the D4 unique surface), or `null`. */
  async findByControlNumber(
    providerEntityId: string,
    notrControlNumber: string,
  ): Promise<NotrRecord | null> {
    const [row] = await this.db
      .select()
      .from(N)
      .where(
        and(eq(N.providerEntityId, providerEntityId), eq(N.notrControlNumber, notrControlNumber)),
      )
      .limit(1);
    return row ? toNotrRecord(row) : null;
  }

  /**
   * The live (non-terminal) NOTR for a terminating event (the `notr_unique_by_event_uq` partial-unique
   * slice), keyed by the populated event column for `triggerKind`. At most one row matches. Returns `null`
   * when no in-flight NOTR exists for the event.
   */
  async findActiveByEvent(
    triggerKind: NotrTriggerKind,
    eventId: string,
  ): Promise<NotrRecord | null> {
    const eventCol =
      triggerKind === "revocation"
        ? N.revocationEventId
        : triggerKind === "transfer_out"
          ? N.transferEventId
          : N.dischargeEventId;
    const [row] = await this.db
      .select()
      .from(N)
      .where(and(eq(eventCol, eventId), notInArray(N.state, NOTR_TERMINAL_DB)))
      .limit(1);
    return row ? toNotrRecord(row) : null;
  }

  /**
   * The terminating event's EFFECTIVE NOTR — the latest that is neither cancelled nor rejected, an accepted one
   * included (the NOTR twin of `NoeRepository.findEffectiveByAdmission`). `null` when only cancelled / rejected
   * NOTRs (or none) exist for the event.
   */
  async findEffectiveByEvent(
    triggerKind: NotrTriggerKind,
    eventId: string,
  ): Promise<NotrRecord | null> {
    const eventCol =
      triggerKind === "revocation"
        ? N.revocationEventId
        : triggerKind === "transfer_out"
          ? N.transferEventId
          : N.dischargeEventId;
    const [row] = await this.db
      .select()
      .from(N)
      .where(and(eq(eventCol, eventId), notInArray(N.state, ["CANCELLED", "ACK_REJECTED"])))
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(1);
    return row ? toNotrRecord(row) : null;
  }

  /**
   * One keyset page of an org's NOTRs (optionally narrowed by provider/patient/admission/trigger/state),
   * `(created_at DESC, id DESC)`. Over-fetches `size + 1` rows so {@link buildCursorPage} reveals `hasMore`
   * + mints the next cursor. RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listByOrgPage(
    organizationId: string,
    filter: NotrListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<NotrRecord>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(N.organizationId, organizationId),
      filter.providerEntityId ? eq(N.providerEntityId, filter.providerEntityId) : undefined,
      filter.patientId ? eq(N.patientId, filter.patientId) : undefined,
      filter.admissionId ? eq(N.admissionId, filter.admissionId) : undefined,
      filter.triggerKind ? eq(N.triggerKind, filter.triggerKind) : undefined,
      filter.state ? eq(N.state, noticeStateCodec.toDb(filter.state)) : undefined,
      keysetBefore(N.createdAt, N.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(N)
      .where(where)
      .orderBy(desc(N.createdAt), desc(N.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toNotrRecord), size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * The notices the DDE work queue should hold work for (ADR-0052): in flight (state not terminal) with a filing
   * window target on or before `throughDate` (`YYYY-MM-DD`, today plus the watchdog look-ahead), breached or not.
   * Unlike `listWindowWatchCandidates` it does not wait for the target day, and it returns only notices that have no
   * DDE item of this type yet (anti-join). Soonest target first.
   */
  async listDdeWatchCandidates(
    organizationId: string,
    throughDate: string,
    limit = 200,
  ): Promise<readonly NotrRecord[]> {
    const rows = await this.db
      .select()
      .from(N)
      .where(
        and(
          eq(N.organizationId, organizationId),
          notInArray(N.state, NOTR_TERMINAL_DB),
          lte(N.windowTargetAt, throughDate),
          // Anti-join: only notices with NO DDE item of this type yet, so already-served (older) notices can
          // never fill the LIMIT and starve a newer at-risk one, and the caller needs no per-row existence check.
          sql`NOT EXISTS (SELECT 1 FROM dde_work_item d WHERE d.subject_kind = 'notr_record' AND d.subject_id = ${N.id} AND d.item_type = 'notr')`,
        ),
      )
      .orderBy(asc(N.windowTargetAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toNotrRecord);
  }

  /**
   * The timely-filing watchdog scan (§3.4 `notr_window_watch_idx`): an org's NOTRs still in flight (state ∉
   * terminal) whose `window_target_at` has passed `asOf` and that are not yet stamped breached. The cron
   * stamps `window_breached_at` via {@link transitionToState}. `asOf` is a `YYYY-MM-DD`. Newest-target first.
   */
  async listWindowWatchCandidates(
    organizationId: string,
    asOf: string,
    limit = 200,
  ): Promise<readonly NotrRecord[]> {
    const rows = await this.db
      .select()
      .from(N)
      .where(
        and(
          eq(N.organizationId, organizationId),
          notInArray(N.state, NOTR_TERMINAL_DB),
          lte(N.windowTargetAt, asOf),
          isNull(N.windowBreachedAt),
        ),
      )
      .orderBy(desc(N.windowTargetAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toNotrRecord);
  }

  /**
   * The corrections filed against a rejected notice (`corrects_notice_id = id`, migration 0378), newest first —
   * the one-correction-at-a-time rule and the "corrected by" link read them.
   */
  async listCorrectionsOf(id: string): Promise<readonly NotrRecord[]> {
    const rows = await this.db
      .select()
      .from(N)
      .where(eq(N.correctsNoticeId, id))
      .orderBy(desc(N.createdAt), desc(N.id));
    return rows.map(toNotrRecord);
  }

  /** {@link listCorrectionsOf} for a page of notices at once (the list view's "corrected by" link). */
  async listCorrectionsForMany(ids: readonly string[]): Promise<readonly NotrRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(N)
      .where(inArray(N.correctsNoticeId, [...ids]))
      .orderBy(desc(N.createdAt), desc(N.id));
    return rows.map(toNotrRecord);
  }

  /**
   * REDUCER-DRIVEN, version-checked transition (§2.5). The service computes `nextState` via
   * `reduce(state, event)` (machines/notr) and passes the current `expectedVersion` (If-Match); this applies
   * `state = nextState` + `patch` only when the persisted version matches, bumping `version` + `updated_at`.
   * On a mismatch returns `VERSION_CONFLICT` carrying the current persisted version (or `null` when the row
   * vanished). The state value is mapped to the DB enum here.
   */
  async transitionToState(
    id: string,
    expectedVersion: number,
    nextState: NoticeState,
    patch: NotrTransitionPatch = {},
  ): Promise<VersionedUpdateResult<NotrRecord>> {
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
    if (row) return versionOk(toNotrRecord(row));
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}
