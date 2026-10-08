// apps/backend/src/modules/08-encounters/seams/drizzle-store.ts — the Drizzle-backed EncounterReaderStore
// (#107, F-122/#251). M8's §4.7 reader seams previously ran on the in-memory slice store (seeded empty in
// prod), so SignedEncountersReader.signedEncountersForPatientSince returned nothing — which zeroed M30's
// HVLDL numerator (the EVV-verified qualifying-discipline visit count) and any other signed-encounter
// consumer.
//
// This implements the signed-encounter digest read over the real `encounter` table. Like the other live
// getSeam'd Drizzle stores (M36 messaging, M40 mdm), the read SELF-SCOPES on `organizationId` via
// withOrgContext — its own pooled connection carries no ambient RLS context (the consumer's withOrgContext is
// on a different connection). `encounterFacts` is now live too (F-122, #251) — it had been left on the
// in-memory fallback's empty default since this file was written, which zeroed `BillableEncounterReader.
// billability` for EVERY caller (not only M23), the F-093/F-100/F-103 shape again. The other
// EncounterReaderStore methods (renderPayload / mileageForClinician / insertDraftEncounter) live in
// ./drizzle-store-ops.ts (GAP-069) — no method of this store runs on an in-memory default. Below the store factory, two standalone
// ORG-EXPLICIT functions (`billableEncountersInRangeForOrg`, `signedEncounterSnapshotsInRangeForOrg`) are
// the M8 read-surface additions #251 named for M23's still-unbound `billableEncounters`/`signedEncounters`
// seams — the `admissionSchedulingContextForOrg` (M6) shape, for the same reason: M23's boot-time seam
// adapters have no ambient request context to read.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type { EncounterBillability, SignedEncounterDigest } from "@wardenx/types";
import { and, asc, between, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { evvStateOrMissing } from "../evv-at-sign";
import { COSIGN_REQUIRED_DISCIPLINES } from "../lifecycle/index";
import { deriveBillability } from "./readers";
import { type EncounterStoreOpsDeps, createEncounterStoreOps } from "./drizzle-store-ops";
import type { EncounterReaderStore } from "./store";

const E = schema.encounters;

const MS_PER_MINUTE = 60_000;

/** Whole minutes of a visit bracket; `null` (UNRESOLVED, never zero) when either end is missing or the span is not positive. */
function bracketMinutes(startedAt: Date | null, endedAt: Date | null): number | null {
  if (!startedAt || !endedAt) return null;
  const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / MS_PER_MINUTE);
  return minutes > 0 ? minutes : null;
}

/** Encounter statuses that reached at least primary sign — the billing-relevant lifecycle
 *  `billableEncountersInRangeForOrg` scopes to (F-122, #251). A pure `draft`/`finalized` row was never
 *  signed and has no clinical content a claim line could point at; `deriveBillability` itself does not
 *  gate on status='draft', so this filter — not a change to that function — is what keeps an
 *  unauthored note out of `forRange`'s result. */
const EVER_SIGNED_STATUSES = ["signed", "cosign_pending", "cosigned", "voided"] as const;

/** The `encounter_discipline` values that are SKILLED NURSING for the CMS HCI indicators (2, 8, 9). */
const SKILLED_NURSING_DISCIPLINES = ["rn", "lpn"] as const;

/** SSVI "skilled visit" disciplines (nursing + MSW; the encounter model has no therapy discipline). */
const SSVI_SKILLED_VISIT_DISCIPLINES = ["rn", "lpn", "msw"] as const;

/** Encounter statuses that count as a delivered, attested visit (`draft`/`finalized`/`voided` do not). */
const SIGNED_ENCOUNTER_STATUSES = ["signed", "cosigned"] as const;

/** The actor id the read's withOrgContext envelope carries — the empty-string system sentinel the M4 audit
 *  trigger maps to a null actor (an aggregate read has no acting user; withOrgContext requires a userId). */
const ENCOUNTER_READER_SYSTEM_USER_ID = "";

/**
 * Build the production EncounterReaderStore. `signedEncountersForPatientSince` reads the real `encounter` table
 * inside a per-org withOrgContext envelope (RLS scopes by app.org_id; the explicit organization_id filter is
 * the second wall) and projects signed/cosigned rows to {@link SignedEncounterDigest} (the signer is the
 * authoring clinician — encounters are self-signed; cosign is a separate timestamp). evvBracketState is null
 * only for an un-finalized row (a signed row should carry it) — coalesced to the non-present state so it never
 * counts toward an EVV-verified measure.
 */
export function createDrizzleEncounterReaderStore(
  db: DbClient,
  deps: EncounterStoreOpsDeps = {},
): EncounterReaderStore {
  return {
    // GAP-069 — render / mileage / draft-insert are real too. NO in-memory fallback is spread in, so a
    // method missing here is a type error rather than a silent empty default.
    ...createEncounterStoreOps(db, deps),
    /**
     * F-122 (#251) — `BillableEncounterReader.billability` has been LIVE-REGISTERED since M8-T08
     * (`registerEncounterSeams` in `apps/backend/src/index.ts`) while this one method stayed on the
     * in-memory fallback's empty default: `createInMemoryEncounterReaderStore()` seeds no facts in
     * production, so `encounterFacts(ids)` — and therefore `billability(ids)` for EVERY caller, not only
     * M23 — has answered `[]` for any id, ever, in every deployment. The F-093/F-100/F-103 "declared live,
     * reads a no-op default" shape a fourth time. Runs on the CALLER's ambient request context
     * (`withOrgContext`'s `organizationId` is threaded per-row rather than assumed, since a batch of ids
     * is never asserted to share one org — RLS is still the wall; the explicit predicate is belt-and-
     * braces). Column-only: no join to `cosignature_request` is needed because `deriveBillability`'s own
     * rule keys the cosign gate on DISCIPLINE + `status`, not on the workflow-tracking row.
     *
     * Id-keyed, so this opens `withOrgContextFromRequest` — the M6 `listPeriodsForAdmission` convention —
     * rather than an org-explicit envelope: `billability(ids)` carries no org argument to be explicit
     * WITH, and every caller of this seam today runs inside an authenticated request.
     */
    async encounterFacts(encounterIds) {
      if (encounterIds.length === 0) return [];
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            encounterId: E.id,
            patientId: E.patientId,
            encounterType: E.encounterType,
            discipline: E.discipline,
            status: E.status,
            lateEntryTier: E.lateEntryTier,
            significantLateOverrideBy: E.significantLateOverrideBy,
            administrativeOverrideBy: E.administrativeOverrideBy,
          })
          .from(E)
          .where(inArray(E.id, encounterIds as string[]));
        return rows.map((r) => ({
          encounterId: r.encounterId,
          patientId: r.patientId,
          encounterType: r.encounterType,
          discipline: r.discipline,
          status: r.status,
          lateEntryTier: r.lateEntryTier,
          cosignatureResolved: r.status === "cosigned",
          lateEntryAttested: lateEntryAttestedOf(
            r.lateEntryTier,
            r.significantLateOverrideBy,
            r.administrativeOverrideBy,
          ),
        }));
      });
    },
    /**
     * The ORG-LEVEL late-entry tally M30's `late_encounter_entry_rate` reads. Denominator = encounters
     * SIGNED inside the window; numerator = those whose `late_entry_tier` is anything but `normal`.
     *
     * Returns the PAIR, never a rate: M30's kernel suppresses a measure whose denominator is under the CMS
     * reportable floor, so a quotient computed here would destroy the suppression signal. A window with no
     * signed encounters yields 0/0 and the measure suppresses — it does not score "zero late entries".
     */
    lateEntryCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .select({
              tier: E.lateEntryTier,
              n: sql<number>`count(*)::int`,
            })
            .from(E)
            .where(
              and(
                eq(E.organizationId, organizationId),
                gte(E.signedAt, new Date(window.from)),
                lt(E.signedAt, new Date(window.to)),
              ),
            )
            .groupBy(E.lateEntryTier);

          let denominator = 0;
          let numerator = 0;
          for (const r of rows) {
            const n = Number(r.n) || 0;
            denominator += n;
            if (r.tier !== "normal") numerator += n;
          }
          return { numerator, denominator };
        },
      );
    },
    /**
     * The ORG-LEVEL skilled-nursing day totals HCI indicators 2, 8 and 9 read (see the seam doc on
     * `SignedEncountersReader`). One grouped scan of `encounter`, no per-admission N+1.
     *
     * SIGNED only (`signed` / `cosigned`) — an unsigned note is not evidence a visit was delivered, and a
     * `voided` one is evidence it was retracted. Minutes come from the `started_at`/`ended_at` bracket
     * (EVV or clinician-entered); a row with no bracket contributes 0 minutes but still counts as a VISIT,
     * because indicator 2 asks only whether a nurse came, and letting a missing duration erase the visit
     * would turn a documentation gap into a fabricated care gap.
     */
    skilledNursingDayTotalsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .select({
              admissionId: E.admissionId,
              serviceDate: E.serviceDate,
              visits: sql<number>`count(*)::int`,
              // `epoch` on the interval → seconds; floor to whole minutes and sum. A null bracket
              // contributes 0 rather than nulling the whole day's total.
              minutes: sql<number>`coalesce(sum(
                floor(greatest(extract(epoch from (${E.endedAt} - ${E.startedAt})), 0) / 60)
              ), 0)::int`,
            })
            .from(E)
            .where(
              and(
                eq(E.organizationId, organizationId),
                inArray(E.discipline, SKILLED_NURSING_DISCIPLINES),
                inArray(E.status, SIGNED_ENCOUNTER_STATUSES),
                gte(E.serviceDate, window.from),
                lt(E.serviceDate, window.to),
              ),
            )
            .groupBy(E.admissionId, E.serviceDate);

          return rows.map((r) => ({
            admissionId: r.admissionId,
            serviceDate: r.serviceDate,
            visits: Number(r.visits) || 0,
            minutes: Number(r.minutes) || 0,
          }));
        },
      );
    },
    skilledVisitDaysForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .selectDistinct({ admissionId: E.admissionId, serviceDate: E.serviceDate })
            .from(E)
            .where(
              and(
                eq(E.organizationId, organizationId),
                inArray(E.discipline, SSVI_SKILLED_VISIT_DISCIPLINES),
                inArray(E.status, SIGNED_ENCOUNTER_STATUSES),
                gte(E.serviceDate, window.from),
                lt(E.serviceDate, window.to),
              ),
            );
          return rows.map((r) => ({ admissionId: r.admissionId, serviceDate: r.serviceDate }));
        },
      );
    },
    signedEncountersForPatientSince(organizationId, patientId, since) {
      return withOrgContext(
        db,
        { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .select({
              encounterId: E.id,
              patientId: E.patientId,
              admissionId: E.admissionId,
              encounterType: E.encounterType,
              discipline: E.discipline,
              serviceDate: E.serviceDate,
              signedAt: E.signedAt,
              authoredByMembershipId: E.authoredByMembershipId,
              lateEntryTier: E.lateEntryTier,
              status: E.status,
              evvBracketState: E.evvBracketState,
              startedAt: E.startedAt,
              endedAt: E.endedAt,
            })
            .from(E)
            .where(
              and(
                eq(E.organizationId, organizationId),
                eq(E.patientId, patientId),
                inArray(E.status, ["signed", "cosigned"]),
                gte(E.signedAt, new Date(since)),
              ),
            )
            .orderBy(asc(E.signedAt));
          return rows.map(
            (r): SignedEncounterDigest => ({
              encounterId: r.encounterId,
              patientId: r.patientId,
              admissionId: r.admissionId,
              encounterType: r.encounterType,
              discipline: r.discipline,
              serviceDate: r.serviceDate,
              signedAt: (r.signedAt ?? new Date(0)).toISOString(),
              signedByMembershipId: r.authoredByMembershipId,
              lateEntryTier: r.lateEntryTier,
              status: r.status,
              evvBracketState: evvStateOrMissing(r.evvBracketState),
              durationMinutes: bracketMinutes(r.startedAt, r.endedAt),
            }),
          );
        },
      );
    },
  };
}

/** The `lateEntryAttested` derivation both new range reads below share with `encounterFacts` above —
 *  the two override-by columns the `encounter_significant_late_consistency`/`_administrative_override_
 *  consistency` CHECK constraints already tie to the matching tier, read rather than re-decided. */
function lateEntryAttestedOf(
  lateEntryTier: string,
  significantLateOverrideBy: string | null,
  administrativeOverrideBy: string | null,
): boolean {
  if (lateEntryTier === "significant_late_entry") return significantLateOverrideBy !== null;
  if (lateEntryTier === "administrative_override") return administrativeOverrideBy !== null;
  return true;
}

/**
 * F-121-shaped gap the same way M6's was — the CLAIM-ASSEMBLY range read #251 named as needing "a new
 * org-explicit M8 read-surface, not an M23-side adapter": M23's `BillableEncounterReader.forRange` needs
 * the CANDIDATE encounter ids for (provider entity, patient, range) before it can ask `billability(ids)`
 * for them at all — `billability` takes ids already in hand. Org-explicit for the same reason as M6's
 * `admissionSchedulingContextForOrg`: M23's boot-time seam adapters have no ambient request context to
 * read. Reuses the SAME `deriveBillability` pure rule `billability()` calls (`./readers.ts`), fed by a
 * fresh org-explicit read, so the verdict cannot drift between the two callers of the one rule.
 */
export async function billableEncountersInRangeForOrg(
  db: DbClient,
  organizationId: string,
  providerEntityId: string,
  patientId: string,
  range: { readonly from: string; readonly to: string },
): Promise<ReadonlyArray<EncounterBillability & { readonly serviceDate: string }>> {
  return withOrgContext(
    db,
    { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({
          encounterId: E.id,
          patientId: E.patientId,
          encounterType: E.encounterType,
          discipline: E.discipline,
          status: E.status,
          lateEntryTier: E.lateEntryTier,
          significantLateOverrideBy: E.significantLateOverrideBy,
          administrativeOverrideBy: E.administrativeOverrideBy,
          serviceDate: E.serviceDate,
        })
        .from(E)
        .where(
          and(
            eq(E.organizationId, organizationId),
            eq(E.providerEntityId, providerEntityId),
            eq(E.patientId, patientId),
            inArray(E.status, EVER_SIGNED_STATUSES),
            between(E.serviceDate, range.from, range.to),
          ),
        );
      return rows.map((r) => {
        const verdict = deriveBillability({
          encounterId: r.encounterId,
          patientId: r.patientId,
          encounterType: r.encounterType,
          discipline: r.discipline,
          status: r.status,
          lateEntryTier: r.lateEntryTier,
          cosignatureResolved: r.status === "cosigned",
          lateEntryAttested: lateEntryAttestedOf(
            r.lateEntryTier,
            r.significantLateOverrideBy,
            r.administrativeOverrideBy,
          ),
        });
        return { ...verdict, serviceDate: r.serviceDate };
      });
    },
  );
}

/**
 * The `signedEncountersForPatientSince` sibling (F-121-shaped gap #251 named for `signedEncounters`): a TO
 * bound (M23's SIA window is `[deceasedDate-6, deceasedDate]`, not an open-ended tail) plus the fields
 * `SignedEncounterSnapshot` needs that the digest never carried — `durationMinutes` (the
 * `skilledNursingDayTotalsForOrg` bracket-to-minutes rule above), and `cosignRequired`/`cosigned`, which —
 * checked against `claim-assembly.ts`'s actual read, not assumed — are NOT read by the SIA calculator
 * today (only `encounterId`/`serviceDate`/`discipline`/`durationMinutes`/`signed` are); they are still
 * derived honestly here rather than omitted, because the published `SignedEncounterSnapshot` contract
 * requires them and a future consumer may read them. `cosignRequired` keys on DISCIPLINE
 * (`COSIGN_REQUIRED_DISCIPLINES`), the same authoritative source `deriveBillability` uses, not a join to
 * the `cosignature_request` workflow-tracking row. Org-explicit, the same M6 boot-time-closure reason.
 */
export async function signedEncounterSnapshotsInRangeForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  range: { readonly from: string; readonly to: string },
): Promise<
  ReadonlyArray<{
    readonly encounterId: string;
    readonly serviceDate: string;
    readonly discipline: string;
    readonly signed: true;
    readonly cosignRequired: boolean;
    readonly cosigned: boolean;
    readonly durationMinutes: number;
  }>
> {
  return withOrgContext(
    db,
    { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({
          encounterId: E.id,
          serviceDate: E.serviceDate,
          discipline: E.discipline,
          status: E.status,
          startedAt: E.startedAt,
          endedAt: E.endedAt,
        })
        .from(E)
        .where(
          and(
            eq(E.organizationId, organizationId),
            eq(E.patientId, patientId),
            inArray(E.status, SIGNED_ENCOUNTER_STATUSES),
            between(E.serviceDate, range.from, range.to),
          ),
        )
        .orderBy(asc(E.serviceDate));
      return rows.map((r) => ({
        encounterId: r.encounterId,
        serviceDate: r.serviceDate,
        discipline: r.discipline,
        signed: true as const,
        cosignRequired: COSIGN_REQUIRED_DISCIPLINES.includes(r.discipline),
        cosigned: r.status === "cosigned",
        // Same "a row with no bracket contributes 0" rule as `skilledNursingDayTotalsForOrg` — a
        // documentation gap is never fabricated into a duration.
        durationMinutes:
          r.startedAt && r.endedAt
            ? Math.max(0, Math.floor((r.endedAt.getTime() - r.startedAt.getTime()) / 60000))
            : 0,
      }));
    },
  );
}

/** Statuses at which the author's primary signature is on the note and it has not been voided. */
const PRIMARY_SIGNED_STATUSES: readonly string[] = ["signed", "cosign_pending", "cosigned"];

/**
 * FY2027 R-F2F-06 (42 CFR 418.22(b)(4)) — the facts of ONE clinical note, for M6's signed-note
 * face-to-face attestation: which patient it belongs to, the visit date, whether the author's signature is
 * on it (and when), and the M1 USER who authored + signed it (encounters are self-signed; `signed_at` is the
 * author's signature instant). No narrative crosses (minimum necessary). `null` when no such encounter is in
 * this org. Org-explicit with its own `withOrgContext`, bound into M6's `F2fSignedNotePort` at the
 * composition root (M6 does not import M8).
 */
export async function signedEncounterNoteForOrg(
  db: DbClient,
  organizationId: string,
  encounterId: string,
): Promise<{
  readonly encounterId: string;
  readonly patientId: string;
  readonly serviceDate: string;
  readonly signed: boolean;
  readonly signedAt: string | null;
  readonly signerUserId: string | null;
} | null> {
  const MEM = schema.memberships;
  return withOrgContext(
    db,
    { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({
          encounterId: E.id,
          patientId: E.patientId,
          serviceDate: E.serviceDate,
          status: E.status,
          signedAt: E.signedAt,
          authorUserId: MEM.userId,
        })
        .from(E)
        .leftJoin(MEM, eq(MEM.id, E.authoredByMembershipId))
        .where(and(eq(E.organizationId, organizationId), eq(E.id, encounterId)))
        .limit(1);
      if (!row) return null;
      const signed = PRIMARY_SIGNED_STATUSES.includes(row.status) && row.signedAt !== null;
      return {
        encounterId: row.encounterId,
        patientId: row.patientId,
        serviceDate: row.serviceDate,
        signed,
        signedAt: row.signedAt ? row.signedAt.toISOString() : null,
        signerUserId: row.authorUserId ?? null,
      };
    },
  );
}

/**
 * F-123 (#251) — the encounter→visit map `evvCompliance.bracketsForEncounters` needs before it can even
 * ask M18 anything: M23's contract is ENCOUNTER-keyed, M18's `EvvComplianceReader.bracketStateForVisit` is
 * VISIT-keyed, and `encounter.visit_id` — the only place that link lives — is M8-owned, so M18 cannot
 * resolve it (M18's manifest `dependsOn` is `[17]`, not `[8]`). An encounter with no visit (an ad-hoc note,
 * §3.3's own "nullable for ad-hoc encounters") has no EVV path at all — the M23 adapter maps that to
 * `not_required`, the same default M18's own `classify()` uses for "no events, no resolution trail".
 * Org-explicit for the composition-root injection (no ambient request context at M23's boot-time seams).
 */
export async function encounterVisitIdsForOrg(
  db: DbClient,
  organizationId: string,
  encounterIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  if (encounterIds.length === 0) return new Map();
  return withOrgContext(
    db,
    { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({ encounterId: E.id, visitId: E.visitId })
        .from(E)
        .where(and(eq(E.organizationId, organizationId), inArray(E.id, encounterIds as string[])));
      return new Map(rows.map((r) => [r.encounterId, r.visitId]));
    },
  );
}

/**
 * F-162 (#248) — the reverse of {@link encounterVisitIdsForOrg}: given a set of M17 visit ids, returns the
 * (at most one) M8 encounter attached to each. The mapping is genuinely 1:1, never a fan-out —
 * `encounter_org_visit_unique` (this table's own schema) is a partial UNIQUE index on
 * `(organization_id, visit_id) WHERE visit_id IS NOT NULL`. A visit with no attached encounter (a real,
 * legal state — an EVV correction on a visit that was never converted into a clinical encounter) is simply
 * ABSENT from the returned map, not present with a null value, since there is no encounter id to represent.
 * Org-explicit for the same reason as `encounterVisitIdsForOrg` — a relay tick / boot-time seam adapter has
 * no ambient request context to read through withOrgContextFromRequest.
 */
export async function encounterIdsForVisitsForOrg(
  db: DbClient,
  organizationId: string,
  visitIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (visitIds.length === 0) return new Map();
  return withOrgContext(
    db,
    { organizationId, userId: ENCOUNTER_READER_SYSTEM_USER_ID },
    async (tx) => {
      const rows = await tx
        .select({ encounterId: E.id, visitId: E.visitId })
        .from(E)
        .where(and(eq(E.organizationId, organizationId), inArray(E.visitId, visitIds as string[])));
      return new Map(
        rows
          .filter((r): r is { encounterId: string; visitId: string } => r.visitId !== null)
          .map((r) => [r.visitId, r.encounterId]),
      );
    },
  );
}
