// @wardenx/billing · repositories — `transfer_notice_record` (the 8xC transfer notice / corrected 8xC / 8xD void,
// migration 0375). ORG-SCOPED + VERSIONED, shape-identical to `noe-record` / `notr-record` and over the same
// `noticeStateCodec` (UPPERCASE DB enum ↔ lowercase domain `NoticeState`), keyset pagination and §2.5
// optimistic concurrency. No PHI beyond ids / dates / CCN-NPI of a provider; no MBI (D13).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
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

const T = schema.transferNoticeRecord;

export type TransferNoticeAction = schema.TransferNoticeRecord["action"];

/** The domain-cased row: identical to `schema.TransferNoticeRecord` except `state` is lowercase. */
export interface TransferNoticeRecord extends Omit<schema.TransferNoticeRecord, "state"> {
  readonly state: NoticeState;
}

export type NewTransferNoticeInput = Omit<schema.NewTransferNoticeRecord, "state"> & {
  readonly state?: NoticeState;
};

export interface TransferNoticeListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly admissionId?: string;
  readonly state?: NoticeState;
  readonly action?: TransferNoticeAction;
}

/** Columns a transition (or a same-state, version-checked edit) may set. */
export type TransferNoticePatch = Partial<
  Pick<
    schema.NewTransferNoticeRecord,
    | "payerControlNumber"
    | "latestSubmissionId"
    | "latestAcknowledgmentId"
    | "cancelReason"
    | "admissionDate"
    | "attendingPhysicianId"
    | "certifyingPhysicianId"
    | "priorHospiceCcn"
    | "priorHospiceNpi"
    | "priorBillingConfirmedAt"
    | "priorBillingConfirmedByMembershipId"
    | "priorHospiceThroughDate"
    | "priorHospicePatientStatus"
  >
>;

/** States that no longer hold a transfer at Medicare or in flight. */
const DEAD_DB: schema.TransferNoticeRecord["state"][] = ["CANCELLED", "ACK_REJECTED"];

function toRecord(row: schema.TransferNoticeRecord): TransferNoticeRecord {
  return { ...row, state: noticeStateCodec.fromDb(row.state) };
}

export class TransferNoticeRepository {
  constructor(private readonly db: BillingDb) {}

  async create(input: NewTransferNoticeInput): Promise<TransferNoticeRecord> {
    const { state, ...rest } = input;
    const values: schema.NewTransferNoticeRecord = {
      ...rest,
      ...(state ? { state: noticeStateCodec.toDb(state) } : {}),
    };
    const [row] = await this.db.insert(T).values(values).returning();
    if (!row) throw new Error("transfer_notice_record insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<TransferNoticeRecord | null> {
    const [row] = await this.db.select().from(T).where(eq(T.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  /** The live (not cancelled / rejected) original for a transfer event — the `transfer_notice_original_uq` slice. */
  async findLiveOriginalByTransferEvent(
    transferEventId: string,
  ): Promise<TransferNoticeRecord | null> {
    const [row] = await this.db
      .select()
      .from(T)
      .where(
        and(
          eq(T.transferEventId, transferEventId),
          eq(T.action, "original"),
          notInArray(T.state, DEAD_DB),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  /** The live correction / void acting on `supersedesNoticeId`, if any (`transfer_notice_follow_up_uq`). */
  async findLiveFollowUp(supersedesNoticeId: string): Promise<TransferNoticeRecord | null> {
    const [row] = await this.db
      .select()
      .from(T)
      .where(and(eq(T.supersedesNoticeId, supersedesNoticeId), notInArray(T.state, DEAD_DB)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  /**
   * §20.1.3 "A beneficiary can change hospices only once per benefit period": the number of OTHER live
   * originals for this patient + benefit period. A voided transfer (an accepted 8xD acting on it) no longer
   * counts — Medicare removed it.
   */
  async countOtherLiveOriginalsInPeriod(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly benefitPeriodSequence: number;
    readonly excludeTransferEventId: string;
  }): Promise<number> {
    const originals = await this.db
      .select({ id: T.id })
      .from(T)
      .where(
        and(
          eq(T.organizationId, input.organizationId),
          eq(T.patientId, input.patientId),
          eq(T.benefitPeriodSequence, input.benefitPeriodSequence),
          eq(T.action, "original"),
          ne(T.transferEventId, input.excludeTransferEventId),
          notInArray(T.state, DEAD_DB),
        ),
      );
    if (originals.length === 0) return 0;
    const voided = await this.db
      .select({ supersedes: T.supersedesNoticeId })
      .from(T)
      .where(
        and(
          eq(T.action, "void"),
          eq(T.state, "ACK_ACCEPTED"),
          inArray(
            T.supersedesNoticeId,
            originals.map((o) => o.id),
          ),
        ),
      );
    const voidedIds = new Set(voided.map((v) => v.supersedes));
    return originals.filter((o) => !voidedIds.has(o.id)).length;
  }

  /** Every notice for an admission, newest first (the admission's 8xC status panel). */
  async listByAdmission(admissionId: string): Promise<readonly TransferNoticeRecord[]> {
    const rows = await this.db
      .select()
      .from(T)
      .where(eq(T.admissionId, admissionId))
      .orderBy(desc(T.createdAt), desc(T.id))
      .limit(100);
    return rows.map(toRecord);
  }

  async listByOrgPage(
    organizationId: string,
    filter: TransferNoticeListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TransferNoticeRecord>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(T.organizationId, organizationId),
      filter.providerEntityId ? eq(T.providerEntityId, filter.providerEntityId) : undefined,
      filter.patientId ? eq(T.patientId, filter.patientId) : undefined,
      filter.admissionId ? eq(T.admissionId, filter.admissionId) : undefined,
      filter.state ? eq(T.state, noticeStateCodec.toDb(filter.state)) : undefined,
      filter.action ? eq(T.action, filter.action) : undefined,
      keysetBefore(T.createdAt, T.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(T)
      .where(where)
      .orderBy(desc(T.createdAt), desc(T.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toRecord), size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * REDUCER-DRIVEN, version-checked write (§2.5). `nextState` may equal the current state for a same-state
   * edit (the prior-billing confirmation, an admission-date refresh). VERSION_CONFLICT carries the persisted
   * version (or null when the row vanished).
   */
  async transitionToState(
    id: string,
    expectedVersion: number,
    nextState: NoticeState,
    patch: TransferNoticePatch = {},
  ): Promise<VersionedUpdateResult<TransferNoticeRecord>> {
    const [row] = await this.db
      .update(T)
      .set({
        ...patch,
        state: noticeStateCodec.toDb(nextState),
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(T.id, id), eq(T.version, expectedVersion)))
      .returning();
    if (row) return versionOk(toRecord(row));
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}
