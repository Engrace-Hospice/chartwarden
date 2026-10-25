// apps/backend/src/modules/23-billing-medicare/routes/edi-profile-service.ts — M23 tenant-entered EDI PROFILE service
// (migration 1269): list a provider entity's profiles, upsert one per (provider entity, route).
//
// The profile holds the interchange parties the chart cannot supply (submitter + receiver). Nothing is defaulted: no row, no
// profile, and the 837I loader reports a typed gap. An upsert is a compare-and-set on `version`: a first insert carries no
// `If-Match`; an update of an existing row requires the version the caller last read (428 absent, 412 stale).
import type { repositories } from "@chartwarden/billing";
import { billingEdiProfile } from "@chartwarden/db/schema";
import type * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, asc, eq } from "drizzle-orm";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type { EdiProfileView, UpsertEdiProfileBody } from "./edi-profile-typebox";

type BillingDb = repositories.BillingDb;

export interface EdiProfileRouteService {
  listProfiles(actor: M23ReadActor, providerEntityId: string): Promise<readonly EdiProfileView[]>;
  /** Insert (`expectedVersion` undefined) or update (`expectedVersion` = the version last read). */
  upsertProfile(
    actor: M23WriteActor,
    key: { readonly providerEntityId: string; readonly routeKey: string },
    body: UpsertEdiProfileBody,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly profile: EdiProfileView }>;
}

export function mapEdiProfile(row: schema.BillingEdiProfile): EdiProfileView {
  return {
    profileId: row.id,
    providerEntityId: row.providerEntityId,
    routeKey: row.routeKey,
    submitterName: row.submitterName,
    submitterId: row.submitterId,
    submitterContactName: row.submitterContactName,
    submitterContactPhone: row.submitterContactPhone,
    receiverName: row.receiverName,
    receiverId: row.receiverId,
    receiverApplicationCode: row.receiverApplicationCode,
    setByMembershipId: row.setByMembershipId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export function buildDrizzleEdiProfileService(
  db: BillingDb,
  now: () => Date = () => new Date(),
): EdiProfileRouteService {
  const inCtx = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  return {
    listProfiles: (actor, providerEntityId) =>
      inCtx(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(billingEdiProfile)
          .where(
            and(
              eq(billingEdiProfile.organizationId, actor.organizationId),
              eq(billingEdiProfile.providerEntityId, providerEntityId),
            ),
          )
          .orderBy(asc(billingEdiProfile.routeKey));
        return rows.map(mapEdiProfile);
      }),

    upsertProfile: (actor, key, body, expectedVersion) =>
      inCtx(actor, async (tx) => {
        const [existing] = await tx
          .select()
          .from(billingEdiProfile)
          .where(
            and(
              eq(billingEdiProfile.organizationId, actor.organizationId),
              eq(billingEdiProfile.providerEntityId, key.providerEntityId),
              eq(billingEdiProfile.routeKey, key.routeKey),
            ),
          )
          .for("update");

        if (!existing) {
          if (expectedVersion !== undefined) {
            throw new ChartWardenError(
              "VERSION_CONFLICT",
              "no EDI profile exists for this provider entity and route; omit If-Match to create it",
              412,
            );
          }
          try {
            const [row] = await tx
              .insert(billingEdiProfile)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: key.providerEntityId,
                routeKey: key.routeKey,
                ...body,
                setByMembershipId: actor.membershipId,
              })
              .returning();
            if (!row) throw new Error("EDI profile insert returned no row");
            return { created: true, profile: mapEdiProfile(row) };
          } catch (err) {
            // A concurrent first insert: the caller must re-read and send the version.
            if (!isUniqueViolation(err)) throw err;
            throw new ChartWardenError(
              "VERSION_CONFLICT",
              "an EDI profile was created concurrently; read it and send its version in If-Match",
              412,
            );
          }
        }

        if (expectedVersion === undefined) {
          throw new ChartWardenError(
            "IF_MATCH_REQUIRED",
            "an If-Match version is required to update an existing EDI profile",
            428,
          );
        }
        if (existing.version !== expectedVersion) {
          throw new ChartWardenError(
            "VERSION_CONFLICT",
            `the EDI profile is at version ${existing.version}, not ${expectedVersion}`,
            412,
          );
        }
        const [row] = await tx
          .update(billingEdiProfile)
          .set({
            ...body,
            setByMembershipId: actor.membershipId,
            version: existing.version + 1,
            updatedAt: now(),
          })
          .where(eq(billingEdiProfile.id, existing.id))
          .returning();
        if (!row) throw new Error("EDI profile update returned no row");
        return { created: false, profile: mapEdiProfile(row) };
      }),
  };
}
