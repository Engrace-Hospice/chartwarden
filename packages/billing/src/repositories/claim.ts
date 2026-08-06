// @wardenx/billing · repositories — the EXEMPLAR org-scoped repo: `claim` (the Medicare-claim root, §3.3;
// the XState-free lifecycle lives in `machines/claim`, D2/D4/D14). ORG-SCOPED; the claim service wraps
// these in `withOrgContext` and owns the lifecycle guards + outbox emit. This file is the PATTERN the
// org-scoped fan-out repos mirror, demonstrating the THREE db.ts conventions in one place:
//   * ENUM CASE BOUNDARY — `claim.state` is UPPERCASE in the DB; this repo maps it through `claimStateCodec`
//     on EVERY read (`toClaimRecord`) and write (`create` / `transitionToState`), so callers only ever see
//     the lowercase domain `ClaimState`. The case translation never leaks past this boundary.
//   * KEYSET CURSOR PAGINATION — `listByOrgPage` over-fetches `size + 1` rows ordered `(created_at DESC,
//     id DESC)` with `keysetBefore` + `buildCursorPage`.
//   * OPTIMISTIC CONCURRENCY (§2.5) — `transitionToState` is the REDUCER-DRIVEN, version-checked update:
//     the service runs `reduce(state, event)` from `machines/claim` to obtain `nextState`, then calls this
//     with the If-Match `expectedVersion`; a stale version returns `VERSION_CONFLICT` (the service → 412).
//
// No PHI / no MBI is ever read or written here (D13 / §3.6 / §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { ClaimState } from "../contracts";
import {
  type BillingDb,
  type CursorPage,
  type VersionedUpdateResult,
  buildCursorPage,
  claimStateCodec,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
  versionConflict,
  versionOk,
} from "./db";

const C = schema.claim;

/** The domain-cased `claim` row: identical to `schema.Claim` except `state` is the lowercase `ClaimState`. */
export interface ClaimRecord extends Omit<schema.Claim, "state"> {
  readonly state: ClaimState;
}

/** Insert input: the Drizzle insert shape but with `state` as the optional lowercase domain `ClaimState`. */
export type NewClaimInput = Omit<schema.NewClaim, "state"> & { readonly state?: ClaimState };

/** List filter for {@link ClaimRepository.listByOrgPage} (all optional; combined with AND). */
export interface ClaimListFilter {
  readonly providerEntityId?: string;
  readonly patientId?: string;
  readonly state?: ClaimState;
  /**
   * SERVER-DERIVED provider-entity restriction — the set of ProviderEntities the ACTOR may see. This is
   * authorization, not a user filter: it is assembled from `context.providerEntityIds` at the route and
   * must never be read off the query string. `undefined` = unrestricted (an org-wide billing role or a
   * system principal); a present array restricts to exactly those ids, and an EMPTY array matches
   * NOTHING (an actor with no provider scope sees no claims — fail-closed).
   */
  readonly providerEntityScope?: readonly string[];
}

/** The columns a lifecycle transition may set alongside `state` (assembly/ack/submission back-refs). */
export type ClaimTransitionPatch = Partial<
  Pick<
    schema.NewClaim,
    | "payerClaimControlNumber"
    | "latestValidationRunId"
    | "latestSubmissionId"
    | "replacesClaimId"
    | "replacedByClaimId"
    | "replacementReason"
    | "acknowledgmentDocumentId"
    | "totalChargeCents"
    | "totalExpectedPaymentCents"
    | "sequestrationAppliedPct"
    | "sequestrationPolicyId"
  >
>;

/** Map a DB row to the domain-cased record (the single read-boundary case translation). */
function toClaimRecord(row: schema.Claim): ClaimRecord {
  return { ...row, state: claimStateCodec.fromDb(row.state) };
}

/** WX-PR-012 — M25's D3 auto-match candidate projection (no PHI: no MBI, no patient row). */
export interface ClaimMatchCandidateRow {
  readonly claimId: string;
  readonly claimControlNumber: string;
  readonly payerClaimControlNumber: string | null;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly totalChargeCents: number;
}

/** Data port for `claim` (the exemplar org-scoped read + version-checked write repo). */
export class ClaimRepository {
  constructor(private readonly db: BillingDb) {}

  /** Insert a claim (defaults to `draft`). Returns the domain-cased inserted record. */
  async create(input: NewClaimInput): Promise<ClaimRecord> {
    const { state, ...rest } = input;
    const values: schema.NewClaim = {
      ...rest,
      ...(state ? { state: claimStateCodec.toDb(state) } : {}),
    };
    const [row] = await this.db.insert(C).values(values).returning();
    if (!row) throw new Error("claim insert returned no row");
    return toClaimRecord(row);
  }

  /** Point read by id, or `null` (domain-cased). */
  async findById(id: string): Promise<ClaimRecord | null> {
    const [row] = await this.db.select().from(C).where(eq(C.id, id)).limit(1);
    return row ? toClaimRecord(row) : null;
  }

  /** The claim for a deterministic `(provider_entity, claim_control_number)` (the D4 unique surface), or `null`. */
  async findByControlNumber(
    providerEntityId: string,
    claimControlNumber: string,
  ): Promise<ClaimRecord | null> {
    const [row] = await this.db
      .select()
      .from(C)
      .where(
        and(eq(C.providerEntityId, providerEntityId), eq(C.claimControlNumber, claimControlNumber)),
      )
      .limit(1);
    return row ? toClaimRecord(row) : null;
  }

  /**
   * WX-PR-012 — M25's 835-to-claim D3 auto-match candidates: claims in this org+provider entity whose
   * `claim_control_number` (CLP01) or `payer_claim_control_number` (CLP07/ICN) matches one of the line's
   * keys. Returns the UNION of both — `autoMatch`'s own precedence/ambiguity logic (payer-ICN first, then
   * claim-control-number, each requiring an UNAMBIGUOUS single hit) decides which strategy, if any, binds.
   * Neither key present → empty (never scans the whole provider entity).
   */
  async findMatchCandidates(
    organizationId: string,
    providerEntityId: string,
    keys: { readonly payerClaimControlNumber?: string; readonly claimControlNumber?: string },
  ): Promise<ClaimMatchCandidateRow[]> {
    if (!keys.payerClaimControlNumber && !keys.claimControlNumber) return [];
    const rows = await this.db
      .select({
        claimId: C.id,
        claimControlNumber: C.claimControlNumber,
        payerClaimControlNumber: C.payerClaimControlNumber,
        serviceFrom: C.serviceFrom,
        serviceTo: C.serviceTo,
        totalChargeCents: C.totalChargeCents,
      })
      .from(C)
      .where(
        and(
          eq(C.organizationId, organizationId),
          eq(C.providerEntityId, providerEntityId),
          or(
            keys.payerClaimControlNumber
              ? eq(C.payerClaimControlNumber, keys.payerClaimControlNumber)
              : undefined,
            keys.claimControlNumber ? eq(C.claimControlNumber, keys.claimControlNumber) : undefined,
          ),
        ),
      );
    return rows;
  }

  /** WX-PR-012 — the claim's `patient_id` only (PR-ledger seeding), narrower than {@link findById}. */
  async patientIdForId(claimId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ patientId: C.patientId })
      .from(C)
      .where(eq(C.id, claimId))
      .limit(1);
    return row?.patientId ?? null;
  }

  /**
   * One keyset page of an org's claims (optionally narrowed by provider/patient/state), `(created_at DESC,
   * id DESC)`. Over-fetches `size + 1` rows so {@link buildCursorPage} can reveal `hasMore` + mint the next
   * cursor. RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listByOrgPage(
    organizationId: string,
    filter: ClaimListFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ClaimRecord>> {
    const size = pageSizeOf(limit);
    // `inArray(col, [])` is not portable shorthand for "match nothing" — spell the refusal out, so an
    // actor with an EMPTY provider scope gets an empty page rather than the whole org's claims.
    const scope = filter.providerEntityScope;
    const scopeClause =
      scope === undefined
        ? undefined
        : scope.length === 0
          ? sql`false`
          : inArray(C.providerEntityId, scope);
    const where = and(
      eq(C.organizationId, organizationId),
      scopeClause,
      filter.providerEntityId ? eq(C.providerEntityId, filter.providerEntityId) : undefined,
      filter.patientId ? eq(C.patientId, filter.patientId) : undefined,
      filter.state ? eq(C.state, claimStateCodec.toDb(filter.state)) : undefined,
      keysetBefore(C.createdAt, C.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(C)
      .where(where)
      .orderBy(desc(C.createdAt), desc(C.id))
      .limit(size + 1);
    return buildCursorPage(rows.map(toClaimRecord), size, (r) => ({
      createdAt: r.createdAt.toISOString(),
      id: r.id,
    }));
  }

  /**
   * REDUCER-DRIVEN, version-checked transition (§2.5). The service computes `nextState` via
   * `reduce(state, event)` (machines/claim) and passes the current `expectedVersion` (If-Match); this
   * applies `state = nextState` + `patch` only when the persisted version matches, bumping `version` +
   * `updated_at`. On a version mismatch returns `VERSION_CONFLICT` carrying the current persisted version
   * (or `null` when the row vanished) so the service can surface a 412. The state value is mapped to the
   * DB enum here — the caller speaks only the lowercase domain `ClaimState`.
   */
  async transitionToState(
    id: string,
    expectedVersion: number,
    nextState: ClaimState,
    patch: ClaimTransitionPatch = {},
  ): Promise<VersionedUpdateResult<ClaimRecord>> {
    const [row] = await this.db
      .update(C)
      .set({
        ...patch,
        state: claimStateCodec.toDb(nextState),
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(C.id, id), eq(C.version, expectedVersion)))
      .returning();
    if (row) return versionOk(toClaimRecord(row));
    const current = await this.findById(id);
    return versionConflict(current?.version ?? null);
  }
}
