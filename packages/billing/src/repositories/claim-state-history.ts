// @wardenx/billing · repositories — `claim_state_history` (M23 Billing-Medicare §3.3; retention class
// `compliance`). APPEND-ONLY: one row per `claim.state` transition (D4 lifecycle) — the claim service
// appends a row inside the SAME transaction as each `transitionToState`, capturing the from/to states,
// the actor, and the transition-context pointers. Mirrors the `validation_run` append-only exemplar
// (INSERT + READ only; NO update/delete surface — the P1 DB append-only trigger is mirrored by the repo
// offering no mutating method) and the `claim` enum-case exemplar (both `from_state`/`to_state` are the
// UPPERCASE DB `m23_claim_state` and pass through `claimStateCodec`, so callers only ever see the
// lowercase domain `ClaimState`). The per-claim timeline (§3.4) is the `(at DESC, id DESC)` keyset list.
//
// `from_state` is NULL on the initial creation row. No PHI / MBI is ever stored here (D13, §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { ClaimState } from "../contracts";
import {
  type BillingDb,
  type CursorPage,
  buildCursorPage,
  claimStateCodec,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
} from "./db";

const H = schema.claimStateHistory;

/**
 * The domain-cased `claim_state_history` row: identical to `schema.ClaimStateHistory` except `from_state`
 * (NULL on the creation row) and `to_state` are the lowercase domain `ClaimState`.
 */
export interface ClaimStateHistoryRecord
  extends Omit<schema.ClaimStateHistory, "fromState" | "toState"> {
  readonly fromState: ClaimState | null;
  readonly toState: ClaimState;
}

/** Insert input: the Drizzle insert shape with `fromState`/`toState` as the lowercase domain `ClaimState`. */
export type NewClaimStateHistoryInput = Omit<
  schema.NewClaimStateHistory,
  "fromState" | "toState"
> & {
  readonly fromState?: ClaimState | null;
  readonly toState: ClaimState;
};

/** Map a DB row to the domain-cased record (the single read-boundary case translation). */
function toRecord(row: schema.ClaimStateHistory): ClaimStateHistoryRecord {
  return {
    ...row,
    fromState: row.fromState ? claimStateCodec.fromDb(row.fromState) : null,
    toState: claimStateCodec.fromDb(row.toState),
  };
}

/** Data port for `claim_state_history` (APPEND-ONLY: append + read; NO update/delete surface). */
export class ClaimStateHistoryRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append one transition row (the service calls this inside the `transitionToState` transaction). Maps the
   * domain `fromState`/`toState` to the UPPERCASE DB enum. Returns the domain-cased persisted record.
   */
  async append(input: NewClaimStateHistoryInput): Promise<ClaimStateHistoryRecord> {
    const { fromState, toState, ...rest } = input;
    const values: schema.NewClaimStateHistory = {
      ...rest,
      ...(fromState ? { fromState: claimStateCodec.toDb(fromState) } : {}),
      toState: claimStateCodec.toDb(toState),
    };
    const [row] = await this.db.insert(H).values(values).returning();
    if (!row) throw new Error("claim_state_history insert returned no row");
    return toRecord(row);
  }

  /** Point read by id, or `null` (domain-cased). */
  async findById(id: string): Promise<ClaimStateHistoryRecord | null> {
    const [row] = await this.db.select().from(H).where(eq(H.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  /**
   * One keyset page of a claim's transition timeline (§3.4 `claim_state_history_recent_per_claim`),
   * `(at DESC, id DESC)` newest-first. Over-fetches `size + 1` rows so {@link buildCursorPage} can reveal
   * `hasMore` + mint the next cursor. RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listForClaimPage(
    claimId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ClaimStateHistoryRecord>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(H.claimId, claimId),
      keysetBefore(H.at, H.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(H)
      .where(where)
      .orderBy(desc(H.at), desc(H.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toRecord), size, (r) => ({
      createdAt: r.at.toISOString(),
      id: r.id,
    }));
  }

  /** The most-recent transition for a claim (the timeline head / current-state derivation), or `null`. */
  async findLatestForClaim(claimId: string): Promise<ClaimStateHistoryRecord | null> {
    const [row] = await this.db
      .select()
      .from(H)
      .where(eq(H.claimId, claimId))
      .orderBy(desc(H.at), desc(H.id))
      .limit(1);
    return row ? toRecord(row) : null;
  }
}
