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
import type { ClaimState, TypeOfBill } from "../contracts";
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
    | "clearinghouseAcceptedAt"
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
   * F-153 (#248) — the §4.8 `revalidate.consumer` target resolver's read. Every claim in `VALIDATING` or
   * `READY` (a claim not yet submitted, where a re-run can still change the outcome) matching ANY of the
   * supplied facts: `patientId` / `admissionId` exact match on `claim`'s own logical-FK columns, or
   * `encounterId` via a jsonb containment scan of `claim_line.backing_encounter_ids` (the only fact shape
   * that needs the child table — an encounter-signed/cosigned event carries no patient or admission id).
   * All three are OR'd: a fact resolver is intentionally permissive about WHICH claims it flags for
   * re-validation, since a false positive here costs one no-op rule re-run and a false negative costs a
   * claim submitted against a stale fact. Returns `[]` (not an error) when `fact` carries none of the three
   * — a resolver call with no matchable id is a caller bug the empty result surfaces rather than masks.
   */
  async listRevalidationTargets(
    organizationId: string,
    fact: {
      readonly patientId?: string;
      readonly admissionId?: string;
      readonly encounterId?: string;
    },
  ): Promise<readonly { readonly claimId: string }[]> {
    const activeStates = [claimStateCodec.toDb("validating"), claimStateCodec.toDb("ready")];
    const factClauses = [
      fact.patientId ? eq(C.patientId, fact.patientId) : undefined,
      fact.admissionId ? eq(C.admissionId, fact.admissionId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const ids = new Set<string>();

    if (factClauses.length > 0) {
      const rows = await this.db
        .select({ id: C.id })
        .from(C)
        .where(
          and(
            eq(C.organizationId, organizationId),
            inArray(C.state, activeStates),
            or(...factClauses),
          ),
        );
      for (const r of rows) ids.add(r.id);
    }

    if (fact.encounterId) {
      const L = schema.claimLine;
      const rows = await this.db
        .select({ id: C.id })
        .from(C)
        .innerJoin(L, eq(L.claimId, C.id))
        .where(
          and(
            eq(C.organizationId, organizationId),
            inArray(C.state, activeStates),
            sql`${L.backingEncounterIds} @> ${JSON.stringify([fact.encounterId])}::jsonb`,
          ),
        );
      for (const r of rows) ids.add(r.id);
    }

    return [...ids].map((claimId) => ({ claimId }));
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

  /**
   * Refresh the DERIVED discharge claim codes (migration 0371) after a re-validation re-derived them from
   * current M6 facts (e.g. a biller recorded the missing place of death). These columns are a projection of
   * clinical facts, not a user edit, so the write does NOT bump `version` (an If-Match holder is not
   * invalidated by a fact refresh) and is a no-op when nothing changed. Returns whether a row was updated.
   */
  async refreshDischargeCodes(
    id: string,
    codes: {
      readonly patientStatusCode: string | null;
      readonly conditionCodes: string[];
      readonly occurrenceCodes: { code: string; date: string }[];
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(C)
      .set({
        patientStatusCode: codes.patientStatusCode,
        conditionCodes: codes.conditionCodes,
        occurrenceCodes: codes.occurrenceCodes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(C.id, id),
          sql`(${C.patientStatusCode} IS DISTINCT FROM ${codes.patientStatusCode}
            OR ${C.conditionCodes} IS DISTINCT FROM ${JSON.stringify(codes.conditionCodes)}::jsonb
            OR ${C.occurrenceCodes} IS DISTINCT FROM ${JSON.stringify(codes.occurrenceCodes)}::jsonb)`,
        ),
      )
      .returning({ id: C.id });
    return rows.length > 0;
  }

  /**
   * Keep the claim's derived occurrence spans (migration 0378; today the late-NOE OSC 77) in step with the facts
   * the latest validation run saw. A derived projection like {@link refreshDischargeCodes}: no version bump, a
   * no-op when unchanged; the write-audit trigger records the change. Returns whether the row changed.
   */
  async refreshOccurrenceSpans(
    id: string,
    spans: readonly { readonly code: string; readonly from: string; readonly through: string }[],
  ): Promise<boolean> {
    const value = spans.map((s) => ({ code: s.code, from: s.from, through: s.through }));
    const rows = await this.db
      .update(C)
      .set({ occurrenceSpans: value, updatedAt: new Date() })
      .where(
        and(
          eq(C.id, id),
          sql`${C.occurrenceSpans} IS DISTINCT FROM ${JSON.stringify(value)}::jsonb`,
        ),
      )
      .returning({ id: C.id });
    return rows.length > 0;
  }

  /**
   * Keep the claim's physician NPIs (migration 1054; UB-04 FL 76 attending / FL 78 certifying) in step with the M40
   * resolution the latest validation run saw. A derived projection like {@link refreshDischargeCodes}: no version
   * bump, a no-op when unchanged; the write-audit trigger records the change. Returns whether the row changed.
   */
  async refreshPhysicianNpis(
    id: string,
    npis: {
      readonly attendingPhysicianNpi: string | null;
      readonly certifyingPhysicianNpi: string | null;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(C)
      .set({
        attendingPhysicianNpi: npis.attendingPhysicianNpi,
        certifyingPhysicianNpi: npis.certifyingPhysicianNpi,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(C.id, id),
          sql`(${C.attendingPhysicianNpi} IS DISTINCT FROM ${npis.attendingPhysicianNpi}
            OR ${C.certifyingPhysicianNpi} IS DISTINCT FROM ${npis.certifyingPhysicianNpi})`,
        ),
      )
      .returning({ id: C.id });
    return rows.length > 0;
  }

  /**
   * Keep the claim's wage-index value codes (migration 1059; UB-04 FL 39-41 — 61 residence CBSA, G8 inpatient-facility
   * CBSA) in step with the ZIP-to-CBSA resolution the latest validation run saw. A derived projection like
   * {@link refreshAdmissionCodes}: no version bump, no-op when unchanged. Returns whether the row changed.
   */
  async refreshValueCodes(
    id: string,
    valueCodes: readonly { readonly code: "61" | "G8"; readonly cbsaCode: string }[],
  ): Promise<boolean> {
    const next = valueCodes.map((v) => ({ code: v.code, cbsaCode: v.cbsaCode }));
    const rows = await this.db
      .update(C)
      .set({ valueCodes: next, updatedAt: new Date() })
      .where(
        and(eq(C.id, id), sql`${C.valueCodes} IS DISTINCT FROM ${JSON.stringify(next)}::jsonb`),
      )
      .returning({ id: C.id });
    return rows.length > 0;
  }

  /**
   * Keep the claim's Type of Admission / Point of Origin (migration 1057; UB-04 FL 14 / FL 15) in step with the
   * M6 admission the latest validation run read — a biller recording the missing codes after assembly must not
   * need a new claim. A derived projection like {@link refreshPhysicianNpis}: no version bump, no-op when unchanged.
   */
  async refreshAdmissionCodes(
    id: string,
    codes: {
      readonly admissionTypeCode: string | null;
      readonly admissionSourceCode: string | null;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(C)
      .set({
        admissionTypeCode: codes.admissionTypeCode,
        admissionSourceCode: codes.admissionSourceCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(C.id, id),
          sql`(${C.admissionTypeCode} IS DISTINCT FROM ${codes.admissionTypeCode}
            OR ${C.admissionSourceCode} IS DISTINCT FROM ${codes.admissionSourceCode})`,
        ),
      )
      .returning({ id: C.id });
    return rows.length > 0;
  }

  /**
   * Re-type an UNSUBMITTED normal-cadence claim whose stored Type of Bill no longer matches the one the resolver
   * derives from current M6 facts (e.g. assembled as interim 812/813 before a revocation or transfer-out was
   * counted as the end of the stay; now final 811/814). Guarded on the stored value (`fromTob`) so a concurrent
   * replace/void builder or a second refresh cannot double-apply. Like {@link refreshDischargeCodes} this is a
   * derived projection, not a user edit: no version bump; the write-audit trigger records the change.
   */
  async refreshTypeOfBill(id: string, fromTob: TypeOfBill, toTob: TypeOfBill): Promise<boolean> {
    const rows = await this.db
      .update(C)
      .set({ tob: toTob, updatedAt: new Date() })
      .where(and(eq(C.id, id), eq(C.tob, fromTob)))
      .returning({ id: C.id });
    return rows.length > 0;
  }
}
