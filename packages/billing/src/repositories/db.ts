// @wardenx/billing · repositories — the shared Drizzle surface + load-bearing conventions every M23
// repository builds on (the @wardenx/cost-report `repositories/db.ts` precedent, M27).
//
// CONVENTION (mirrors @wardenx/cost-report + @wardenx/quality + @wardenx/reporting): each repo takes the
// Drizzle client (`BillingDb`) in its constructor and issues plain Drizzle queries; the read/write SERVICE
// layer (P3 apps/backend) wraps each call in `withOrgContext` (M1 @wardenx/tenancy) so Postgres RLS scopes
// every statement to `app.org_id`. The repo therefore accepts either the pooled `DbClient` or a
// transaction handle opened by `withOrgContext` — both satisfy `BillingDb` structurally. The repo never
// opens its own transaction and never sets RLS GUCs: scoping is the service's job (single home).
//
// THREE conventions live HERE and HERE ONLY (the fan-out repos import them, never re-implement):
//   1. ENUM CASE/VALUE BOUNDARY — the domain (machines/contracts) speaks lowercase (`ClaimState`,
//      `NoticeState`, `LevelOfCare`, `EligibilityOutcome`); the DB pgEnums are UPPERCASE (claim/notice
//      state) or carry EXTRA values (eligibility: `mbi_invalid`/`unknown_response`/`hets_error`). The
//      `EnumCodec`s below are the SINGLE home of that mapping; repos call `codec.toDb(...)` on write and
//      `codec.fromDb(...)` on read so the case/value translation never leaks past the DB boundary.
//   2. KEYSET CURSOR PAGINATION — `(created_at DESC, id DESC)` opaque cursor codec + the `keysetBefore`
//      Drizzle predicate + `buildCursorPage` envelope every list repo paginates on.
//   3. OPTIMISTIC CONCURRENCY (§2.5 If-Match) — the `VersionedUpdateResult` shape + `versionOk` /
//      `versionConflict` constructors every version-checked `*WithVersion` update returns.
//
// No PHI / no MBI is ever read or written through these ports (D13 / §3.6 / §8.7).
// IMPORT BOUNDARY (M23 does NOT `dependsOn` M1/Foundation, so the `@wardenx/db` ROOT barrel —
// `packages/db/src/index.ts`, which carries the M1-owned client — is off-limits): the M23 repos source the
// runtime Drizzle table objects + row types from the `@wardenx/db/schema` SUBPATH, which resolves to
// `packages/db/src/schema` — a universal FOUNDATION_HELPER leaf every module may import. `BillingDb` is
// reconstructed from drizzle-orm's own `NodePgDatabase<typeof schema>` (identical to the M1 `DbClient`,
// so a `DbClient` / `withOrgContext` tx handle is structurally assignable) without taking the M1 edge.
import * as schema from "@wardenx/db/schema";
import { WardenXError } from "@wardenx/types";
import { type SQL, and, eq, lt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ClaimState, EligibilityOutcome, LevelOfCare, NoticeState } from "../contracts";

/**
 * The minimal Drizzle surface every M23 repository needs: the pooled client or a transaction handle opened
 * by `withOrgContext`. Reconstructed as `NodePgDatabase<typeof schema>` (the same shape as the M1
 * `DbClient`) so both the pooled client and a tx handle satisfy it structurally; the service decides which
 * to pass. (Mirrors `CostReportDb` — M27 — without the M1 barrel edge M23 may not take.)
 */
export type BillingDb = NodePgDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Enum case/value boundary — the SINGLE home of domain↔DB enum translation
// ─────────────────────────────────────────────────────────────────────────────

/** A bidirectional codec between a lowercase DOMAIN enum and its UPPERCASE-or-divergent DB pgEnum value. */
export interface EnumCodec<TDomain extends string, TDb extends string> {
  /** Domain value → DB pgEnum value (write boundary). Throws on an un-storable domain value (fail-closed). */
  toDb(value: TDomain): TDb;
  /** DB pgEnum value → domain value (read boundary). Throws on an unknown DB value (fail-closed). */
  fromDb(value: TDb): TDomain;
}

/** Fail-closed: a mapping table did not cover a value. A programming error (mirrors M27's repo `throw new Error`). */
function unmappable(kind: string, value: string): never {
  throw new Error(`@wardenx/billing enum codec: unmappable ${kind} value "${value}"`);
}

/**
 * Build a codec from a 1:1 forward map (domain → DB); the reverse is the inverse. Use for clean
 * semantic mappings (e.g. `level_of_care`: `routine_home_care ↔ RHC`).
 */
export function makeEnumCodec<TDomain extends string, TDb extends string>(
  forward: Readonly<Record<TDomain, TDb>>,
): EnumCodec<TDomain, TDb> {
  const reverse = {} as Record<string, TDomain>;
  for (const domain of Object.keys(forward) as TDomain[]) reverse[forward[domain]] = domain;
  return {
    toDb(value) {
      const mapped = (forward as Record<string, TDb | undefined>)[value];
      return mapped ?? unmappable("toDb", value);
    },
    fromDb(value) {
      const mapped = reverse[value];
      return mapped ?? unmappable("fromDb", value);
    },
  };
}

/**
 * Build an ASYMMETRIC codec from explicit forward + reverse maps. Use when the reverse is NOT the inverse
 * of the forward — e.g. `eligibility_outcome`, where the DB has more values than the domain so two DB
 * values (`mbi_invalid`, `hets_error`) both fold back to the single domain `error`.
 */
export function makeBiCodec<TDomain extends string, TDb extends string>(
  toDbMap: Readonly<Record<TDomain, TDb>>,
  fromDbMap: Readonly<Record<TDb, TDomain>>,
): EnumCodec<TDomain, TDb> {
  return {
    toDb(value) {
      const mapped = (toDbMap as Record<string, TDb | undefined>)[value];
      return mapped ?? unmappable("toDb", value);
    },
    fromDb(value) {
      const mapped = (fromDbMap as Record<string, TDomain | undefined>)[value];
      return mapped ?? unmappable("fromDb", value);
    },
  };
}

/**
 * Build a CASE-ONLY codec from a DB pgEnum's value tuple: DB is UPPERCASE, domain is the lowercase of the
 * same token. Use for `claim.state` and `noe/notr.state`. A domain value with no UPPERCASE DB member (e.g.
 * the contracts-only `partial_paid`, which the lifecycle reducer never emits) fails closed on `toDb`.
 */
export function makeCaseCodec<TDomain extends string, TDb extends string>(
  dbValues: readonly TDb[],
): EnumCodec<TDomain, TDb> {
  const dbSet = new Set<string>(dbValues);
  return {
    toDb(value) {
      const upper = value.toUpperCase();
      return dbSet.has(upper) ? (upper as TDb) : unmappable("toDb", value);
    },
    fromDb(value) {
      return dbSet.has(value) ? (value.toLowerCase() as TDomain) : unmappable("fromDb", value);
    },
  };
}

// DB-side string-union aliases (derived from the frozen pgEnum tuples — never re-listed).
type ClaimStateDb = (typeof schema.m23ClaimState.enumValues)[number];
type NoeStateDb = (typeof schema.m23NoeState.enumValues)[number];
type LevelOfCareDb = (typeof schema.m23ClaimLineLevelOfCare.enumValues)[number];
type EligibilityOutcomeDb = (typeof schema.m23EligibilityOutcome.enumValues)[number];

/** `claim.state` — UPPERCASE DB ↔ lowercase domain `ClaimState` (case-only). */
export const claimStateCodec: EnumCodec<ClaimState, ClaimStateDb> = makeCaseCodec<
  ClaimState,
  ClaimStateDb
>(schema.m23ClaimState.enumValues);

/** `noe_record.state` / `notr_record.state` — UPPERCASE DB ↔ lowercase domain `NoticeState` (case-only). */
export const noticeStateCodec: EnumCodec<NoticeState, NoeStateDb> = makeCaseCodec<
  NoticeState,
  NoeStateDb
>(schema.m23NoeState.enumValues);

/** `claim_line.level_of_care` — DB abbreviation ↔ long-form domain `LevelOfCare` (1:1 semantic). */
export const levelOfCareCodec: EnumCodec<LevelOfCare, LevelOfCareDb> = makeEnumCodec<
  LevelOfCare,
  LevelOfCareDb
>({
  routine_home_care: "RHC",
  continuous_home_care: "CHC",
  inpatient_respite_care: "IRC",
  general_inpatient_care: "GIP",
});

/**
 * `eligibility_check.outcome` — DB (5 values) ↔ domain `EligibilityOutcome` (5 values): `unknown_response`
 * ↔ `indeterminate`, `hets_error` ↔ `error`, the rest 1:1 (`mbi_invalid` is its own domain value since the
 * HETS 271 parser distinguishes a beneficiary-match rejection from a system error).
 */
export const eligibilityOutcomeCodec: EnumCodec<EligibilityOutcome, EligibilityOutcomeDb> =
  makeBiCodec<EligibilityOutcome, EligibilityOutcomeDb>(
    {
      active_part_a: "active_part_a",
      inactive_part_a: "inactive_part_a",
      mbi_invalid: "mbi_invalid",
      indeterminate: "unknown_response",
      error: "hets_error",
    },
    {
      active_part_a: "active_part_a",
      inactive_part_a: "inactive_part_a",
      mbi_invalid: "mbi_invalid",
      unknown_response: "indeterminate",
      hets_error: "error",
    },
  );

// ─────────────────────────────────────────────────────────────────────────────
// 2. Keyset cursor pagination — `(created_at DESC, id DESC)`
// ─────────────────────────────────────────────────────────────────────────────

/** The keyset a cursor encodes — `(createdAt DESC, id DESC)`. Opaque to clients. */
export interface CursorKeyset {
  /** The anchor timestamp (a row's `created_at` / `started_at` — the deterministic list sort key). */
  readonly createdAt: string;
  readonly id: string;
}

/** Encode a keyset into an opaque base64url cursor (HMAC-signed in prod; shape identical). */
export function encodeCursor(keyset: CursorKeyset): string {
  return Buffer.from(JSON.stringify(keyset), "utf8").toString("base64url");
}

const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode an opaque cursor → keyset, or throw 400 VALIDATION_FAILED on a malformed/tampered value. The fields are
 * validated by SHAPE (an ISO-8601 UTC instant that is a real date, and a uuid), because they are bound straight into
 * the keyset predicate: a forged but well-formed-JSON cursor would otherwise reach Postgres as an invalid timestamp or
 * uuid and come back as a 500. Every cursor this module mints is `toISOString()` + a row uuid, so valid cursors are
 * unaffected.
 */
export function decodeCursor(cursor: string): CursorKeyset {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorKeyset>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("missing keyset fields");
    }
    if (
      !CURSOR_TIMESTAMP_RE.test(parsed.createdAt) ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !CURSOR_UUID_RE.test(parsed.id)
    ) {
      throw new Error("bad keyset field shape");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new WardenXError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
}

/** The default + maximum page size for the M23 list routes (default 50, max 100). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Clamp a requested page size into the [1, MAX] range, defaulting to {@link DEFAULT_PAGE_SIZE}. */
export function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
}

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every list repo returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * The Drizzle WHERE predicate for the keyset "strictly before the cursor" on a `(createdAt DESC, id DESC)`
 * order: `created_at < ts OR (created_at = ts AND id < id)`. Returns `undefined` (no predicate — first
 * page) when `cursor` is absent. Centralizes the keyset SQL so every list repo writes it identically.
 */
export function keysetBefore(
  createdAtCol: AnyPgColumn,
  idCol: AnyPgColumn,
  cursor: CursorKeyset | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  const ts = new Date(cursor.createdAt);
  return or(lt(createdAtCol, ts), and(eq(createdAtCol, ts), lt(idCol, cursor.id)));
}

/**
 * Build a {@link CursorPage} from a DB-keyset fetch of `size + 1` rows (the over-fetch reveals `hasMore`).
 * `keyOf` extracts the `(createdAt, id)` anchor from the LAST KEPT row for `nextCursor`. The caller fetches
 * `pageSizeOf(limit) + 1` rows ordered `(createdAt DESC, id DESC)` with {@link keysetBefore}; this trims to
 * the page and mints the next cursor.
 */
export function buildCursorPage<T>(
  fetched: readonly T[],
  size: number,
  keyOf: (item: T) => CursorKeyset,
): CursorPage<T> {
  const hasMore = fetched.length > size;
  const items = hasMore ? fetched.slice(0, size) : fetched;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
    hasMore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Optimistic concurrency (§2.5 If-Match)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The optimistic-concurrency outcome of a version-checked update (§2.5): the freshly-updated row, or a
 * `VERSION_CONFLICT` signal carrying the CURRENT persisted version so the service can surface a 412 and the
 * client can re-read + retry. `claim` (and the other versioned roots) use `WHERE id = ? AND version = ?`.
 */
export type VersionedUpdateResult<TRow> =
  | { readonly ok: true; readonly row: TRow }
  | {
      readonly ok: false;
      readonly conflict: "VERSION_CONFLICT";
      readonly currentVersion: number | null;
    };

/** Success constructor for {@link VersionedUpdateResult}. */
export function versionOk<TRow>(row: TRow): VersionedUpdateResult<TRow> {
  return { ok: true, row };
}

/** Conflict constructor for {@link VersionedUpdateResult} (carries the current persisted version, or `null`). */
export function versionConflict<TRow>(currentVersion: number | null): VersionedUpdateResult<TRow> {
  return { ok: false, conflict: "VERSION_CONFLICT", currentVersion };
}
