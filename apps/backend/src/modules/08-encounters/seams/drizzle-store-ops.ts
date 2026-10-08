// apps/backend/src/modules/08-encounters/seams/drizzle-store-ops.ts — the three EncounterReaderStore methods
// that used to ride an in-memory fallback in production (GAP-069): `renderPayload`, `mileageForClinician`
// and `insertDraftEncounter`. Each runs over the real tables inside a withOrgContext envelope pinned to the
// ambient request tenant (the port carries no org argument to be explicit with — the M6 convention).
//
// The in-memory `insertDraftEncounter` minted a counter uuid and wrote nothing, so M19 triage persisted a
// phantom `linked_encounter_id`; the in-memory `mileageForClinician` read an empty list, so M17's route
// efficiency report always saw 0 actual miles.
import { type DbClient, schema } from "@wardenx/db";
import { getRequestContext, withOrgContext } from "@wardenx/tenancy";
import type { EncounterRenderPayload, MileagePayrollRow } from "@wardenx/types";
import { and, asc, between, desc, eq, inArray } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { checkEncounterDisciplinePair } from "../lifecycle/index";
import type { EncounterReaderStore } from "./store";

const E = schema.encounters;
const MILEAGE = schema.mileage;
const OUT = schema.hearthnoteAssembledOutputs;
const ADDENDUM = schema.encounterAddenda;
const MEM = schema.memberships;

/** Statuses whose mileage is payable: the author signed the visit (a draft's mileage may still change; a
 *  voided encounter's must not be paid). */
const PAYABLE_MILEAGE_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;

/** The outbox port the draft insert emits `m8.encounter.created` through (same shape as the route service's). */
export interface EncounterCreatedOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface EncounterStoreOpsDeps {
  /** Emits `m8.encounter.created` on the insert's tx; absent on slice/test boots. */
  readonly outbox?: EncounterCreatedOutboxPort;
  /** Opens the pinned (finalize-time) narrative; absent ⇒ a pinned render is refused, never emptied. */
  readonly narrativeCipher?: HearthnoteEnvelopeCipher;
}

/** The ambient request tenant — the port methods are id-keyed and carry no org argument. */
function ambientOrg(operation: string): { organizationId: string; userId: string } {
  const ctx = getRequestContext();
  if (!ctx) throw new Error(`${operation}: no ambient request context to pin the tenant`);
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

type StoreOps = Pick<
  EncounterReaderStore,
  "renderPayload" | "mileageForClinician" | "insertDraftEncounter"
>;

/** Build the Drizzle-backed render / mileage / draft-insert operations. */
export function createEncounterStoreOps(db: DbClient, deps: EncounterStoreOpsDeps = {}): StoreOps {
  return {
    async renderPayload(encounterId): Promise<EncounterRenderPayload | null> {
      const scope = ambientOrg("EncounterReaderStore.renderPayload");
      return withOrgContext(db, scope, async (tx) => {
        const [enc] = await tx
          .select({ id: E.id, organizationId: E.organizationId })
          .from(E)
          .where(eq(E.id, encounterId))
          .limit(1);
        if (!enc) return null;
        const [pinned] = await tx
          .select({ finalCipher: OUT.finalCipher })
          .from(OUT)
          .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
          .orderBy(desc(OUT.createdAt))
          .limit(1);
        // No pin ⇒ nothing was finalized: the seam serves SIGNED records only, so "not found" is the answer
        // (route 31 owns the unpinned preview). Never an empty string a renderer would print as a note.
        if (!pinned) return null;
        const cipher = deps.narrativeCipher;
        if (!cipher) {
          throw new Error(
            "renderPayload: the encounter narrative is pinned but no cipher is bound",
          );
        }
        const final = await cipher.open(enc.organizationId, pinned.finalCipher);
        const addendumRows = await tx
          .select({
            addendumId: ADDENDUM.id,
            reason: ADDENDUM.reason,
            signedAt: ADDENDUM.signedAt,
            finalCipher: OUT.finalCipher,
          })
          .from(ADDENDUM)
          .leftJoin(OUT, and(eq(OUT.addendumId, ADDENDUM.id), eq(OUT.kind, "addendum_finalize")))
          .where(and(eq(ADDENDUM.encounterId, encounterId), eq(ADDENDUM.status, "signed")))
          .orderBy(asc(ADDENDUM.signedAt));
        const addenda = [];
        for (const a of addendumRows) {
          addenda.push({
            addendumId: a.addendumId,
            reason: a.reason,
            text: a.finalCipher ? await cipher.open(enc.organizationId, a.finalCipher) : "",
            signedAt: (a.signedAt ?? new Date(0)).toISOString(),
          });
        }
        return { encounterId: enc.id, final, addenda };
      });
    },

    async mileageForClinician(clinicianMembershipId, range): Promise<MileagePayrollRow[]> {
      const scope = ambientOrg("EncounterReaderStore.mileageForClinician");
      return withOrgContext(db, scope, async (tx) => {
        const rows = await tx
          .select({
            mileageId: MILEAGE.id,
            encounterId: MILEAGE.encounterId,
            clinicianMembershipId: E.authoredByMembershipId,
            serviceDate: E.serviceDate,
            milesDriven: MILEAGE.milesDriven,
          })
          .from(MILEAGE)
          .innerJoin(E, eq(E.id, MILEAGE.encounterId))
          .where(
            and(
              eq(E.authoredByMembershipId, clinicianMembershipId),
              between(E.serviceDate, range.from, range.to),
              inArray(E.status, [...PAYABLE_MILEAGE_STATUSES]),
            ),
          )
          .orderBy(asc(E.serviceDate), asc(MILEAGE.createdAt));
        return rows.map((r) => ({
          mileageId: r.mileageId,
          encounterId: r.encounterId,
          clinicianMembershipId: r.clinicianMembershipId,
          serviceDate: r.serviceDate,
          milesDriven: Number(r.milesDriven),
        }));
      });
    },

    async insertDraftEncounter(input) {
      const scope = ambientOrg("EncounterCreator.createDraftEncounter");
      checkEncounterDisciplinePair({
        encounterType: input.encounterType,
        discipline: input.discipline,
      });
      // Resolved BEFORE the write tx (a seam read opens its own tenant context; nesting it would set the
      // GUC on an already-bound connection) — the route service's `createDraft` follows the same rule.
      const admission = await getSeam("AdmissionStatusReader").getAdmissionSummary(
        scope.organizationId,
        input.admissionId,
      );
      return withOrgContext(db, scope, async (tx) => {
        const siting = await resolveSiting(
          tx as unknown as DbClient,
          admission,
          input.authorMembershipId,
        );
        const [row] = await tx
          .insert(E)
          .values({
            organizationId: scope.organizationId,
            ...siting,
            patientId: input.patientId,
            admissionId: input.admissionId,
            visitId: input.visitId ?? null,
            encounterType: input.encounterType,
            discipline: input.discipline,
            authoredByMembershipId: input.authorMembershipId,
            serviceDate: input.serviceDate,
            status: "draft",
          })
          .returning({ id: E.id });
        if (!row) throw new Error("EncounterCreator: encounter insert returned no row");
        await deps.outbox?.publish(tx, {
          eventName: "m8.encounter.created",
          organizationId: scope.organizationId,
          aggregateKind: "encounter",
          aggregateId: row.id,
          payload: {
            encounterId: row.id,
            patientId: input.patientId,
            admissionId: input.admissionId,
            ...(input.visitId ? { visitId: input.visitId } : {}),
            encounterType: input.encounterType,
            discipline: input.discipline,
            authoredByMembershipId: input.authorMembershipId,
            serviceDate: input.serviceDate,
          },
        });
        return { encounterId: row.id };
      });
    },
  };
}

/** Siting from the admission, else the author's default membership siting, else unsited (the column is
 *  nullable since 0128; signing refuses an unsited row, so nothing unsited can become a legal record). */
async function resolveSiting(
  t: DbClient,
  admission: { readonly providerEntityId?: string | null; readonly locationId?: string | null },
  authorMembershipId: string,
): Promise<{ providerEntityId: string | null; locationId: string | null }> {
  if (admission.providerEntityId && admission.locationId) {
    return { providerEntityId: admission.providerEntityId, locationId: admission.locationId };
  }
  const [m] = await t
    .select({ providerEntityId: MEM.defaultProviderEntityId, locationIds: MEM.defaultLocationIds })
    .from(MEM)
    .where(eq(MEM.id, authorMembershipId))
    .limit(1);
  const locs = Array.isArray(m?.locationIds) ? (m.locationIds as string[]) : [];
  return { providerEntityId: m?.providerEntityId ?? null, locationId: locs[0] ?? null };
}
