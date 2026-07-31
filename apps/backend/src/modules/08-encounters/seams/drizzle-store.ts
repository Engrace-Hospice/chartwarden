// apps/backend/src/modules/08-encounters/seams/drizzle-store.ts — the Drizzle-backed EncounterReaderStore
// (#107). M8's §4.7 reader seams previously ran on the in-memory slice store (seeded empty in prod), so
// SignedEncountersReader.signedEncountersForPatientSince returned nothing — which zeroed M30's HVLDL numerator
// (the EVV-verified qualifying-discipline visit count) and any other signed-encounter consumer.
//
// This implements the signed-encounter digest read over the real `encounter` table. Like the other live
// getSeam'd Drizzle stores (M36 messaging, M40 mdm), the read SELF-SCOPES on `organizationId` via
// withOrgContext — its own pooled connection carries no ambient RLS context (the consumer's withOrgContext is
// on a different connection). The remaining EncounterReaderStore methods (encounterFacts / renderPayload /
// mileageForClinician / insertDraftEncounter) are NOT yet ported to Drizzle — they keep the in-memory slice's
// safe defaults (empty / null / mint) so this change does not regress their consumers; each awaits its own
// Drizzle impl. Only signedEncountersForPatientSince is live here.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { EvvBracketState, SignedEncounterDigest } from "@wardenx/types";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type EncounterReaderStore, createInMemoryEncounterReaderStore } from "./store";

const E = schema.encounters;

/** The actor id the read's withOrgContext envelope carries — the empty-string system sentinel the M4 audit
 *  trigger maps to a null actor (an aggregate read has no acting user; withOrgContext requires a userId). */
const ENCOUNTER_READER_SYSTEM_USER_ID = "";

/**
 * Build the production EncounterReaderStore. `signedEncountersForPatientSince` reads the real `encounter` table
 * inside a per-org withOrgContext envelope (RLS scopes by app.org_id; the explicit organization_id filter is
 * the second wall) and projects signed/cosigned rows to {@link SignedEncounterDigest} (the signer is the
 * authoring clinician — encounters are self-signed; cosign is a separate timestamp). evvBracketState is null
 * only for an un-finalized row (a signed row should carry it) — coalesced to the non-present state so it never
 * counts toward an EVV-verified measure. The other methods delegate to the in-memory slice (their Drizzle ports
 * are follow-ups).
 */
export function createDrizzleEncounterReaderStore(db: DbClient): EncounterReaderStore {
  const fallback = createInMemoryEncounterReaderStore().store;
  return {
    ...fallback,
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
              evvBracketState: (r.evvBracketState ?? "evv_missing_documented") as EvvBracketState,
            }),
          );
        },
      );
    },
  };
}
