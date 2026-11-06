// apps/backend/src/modules/12-dosespot/tenant-config/config-store.ts — `dosespot_clinic_registration` over ONE open org-scoped
// transaction (the caller's `withOrgContext`; RLS scopes every statement to that tenant). The service takes a `ConfigStore` so
// its rules are tested without a database; this is the Drizzle implementation.
import { type DbClient, schema } from "@chartwarden/db";
import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;
const MO = schema.medicationOrders;

export type ConfigRow = schema.DosespotClinicRegistrationRow;
export type NewConfigRow = Omit<schema.NewDosespotClinicRegistrationRow, "id" | "createdAt">;
/** Every column an update may touch (the migration's column-level UPDATE grant). */
export type ConfigPatch = Partial<Omit<ConfigRow, "id" | "organizationId" | "createdAt">>;

export interface ConfigStore {
  /** The open org-scoped transaction this store reads and writes on; absent on the in-memory store. */
  readonly tx?: DbClient;
  /** The org's row, locked for the rest of the transaction; null when it has none. */
  findForUpdate(organizationId: string): Promise<ConfigRow | null>;
  find(organizationId: string): Promise<ConfigRow | null>;
  insert(row: NewConfigRow): Promise<ConfigRow>;
  /** Compare-and-set on `version`; null when another writer moved it first. */
  update(
    organizationId: string,
    expectedVersion: number,
    patch: ConfigPatch,
  ): Promise<ConfigRow | null>;
  /** Roster rows already linked to DoseSpot (a vendor prescriber id, not revoked): a fact on the view, never a gate. */
  vendorEnrolledPrescribers(organizationId: string): Promise<number>;
  /** Signed orders still waiting to transmit (`queued` / `in_flight`): they pause while the registration is not active. */
  queuedTransmissions(organizationId: string): Promise<number>;
}

export const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The Drizzle store over a transaction already scoped to the org (the tenant's own, or a platform operator's on its behalf). */
export function createDrizzleConfigStore(tx: DbClient): ConfigStore {
  return {
    tx,
    async findForUpdate(organizationId) {
      const [row] = await tx
        .select()
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .for("update");
      return row ?? null;
    },
    async find(organizationId) {
      const [row] = await tx.select().from(R).where(eq(R.organizationId, organizationId)).limit(1);
      return row ?? null;
    },
    async insert(row) {
      const [created] = await tx.insert(R).values(row).returning();
      if (!created) throw new Error("dosespot clinic registration insert returned no row");
      return created;
    },
    async update(organizationId, expectedVersion, patch) {
      const [row] = await tx
        .update(R)
        .set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(R.organizationId, organizationId), eq(R.version, expectedVersion)))
        .returning();
      return row ?? null;
    },
    async vendorEnrolledPrescribers(organizationId) {
      const [row] = await tx
        .select({ n: count() })
        .from(P)
        .where(
          and(
            eq(P.organizationId, organizationId),
            isNotNull(P.dosespotPrescriberId),
            isNull(P.revokedAt),
          ),
        );
      return row?.n ?? 0;
    },
    async queuedTransmissions(organizationId) {
      const [row] = await tx
        .select({ n: count() })
        .from(MO)
        .where(
          and(
            eq(MO.organizationId, organizationId),
            inArray(MO.dosespotSendState, ["queued", "in_flight"]),
          ),
        );
      return row?.n ?? 0;
    },
  };
}
