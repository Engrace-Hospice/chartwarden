// apps/backend/src/modules/12-dosespot/tenant-config/config-store.ts — `dosespot_clinic_registration` over ONE open org-scoped
// transaction (the caller's `withOrgContext`; RLS scopes every statement to that tenant). The service takes a `ConfigStore` so
// its rules are tested without a database; this is the Drizzle implementation.
import { type DbClient, schema } from "@chartwarden/db";
import { and, count, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { UNCONFIRMED_OUTCOME_CLASS } from "../jobs/hold";
import { freshIdempotencyKey, lockVendorBindingsForClear } from "./registration-target";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;
const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;
const SYNC = schema.dosespotPatientSync;

/** The `last_error_class` a patient-sync row carries after its vendor id was cleared because the registration moved to another clinic. */
export const REGISTRATION_RETARGETED_CLASS = "registration_retargeted";

/** How many rows of each table {@link ConfigStore.clearVendorBindings} reset (counts only; never an id). */
export interface VendorBindingsCleared {
  readonly prescribers: number;
  readonly patients: number;
  readonly transmissions: number;
}

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
  /**
   * Forget every id DoseSpot issued under the clinic the registration used to name (ADR-0111 D6): the roster's vendor prescriber ids,
   * enrolment markers and NPIs, the patient-sync vendor patient ids, and the created-prescription id of every transmission still
   * waiting, which also gets a FRESH idempotency key so the new clinic never sees the old one. Those ids are scoped to ONE clinic of ONE
   * environment; sent under another, DoseSpot refuses them for good. Called in the SAME transaction as the registration change that moved the
   * target; it first takes the exclusive binding lock (registration-target.ts), so a vendor round trip that began under the old clinic can
   * neither be writing its id as this runs nor write it after. A transmission that finished, one whose vendor call has BEGUN (stamped, and so
   * possibly in flight or about to be held) and one HELD for a person (whose prescription may exist at the old clinic, where the administrator
   * has to look) keep their ids and their key.
   */
  clearVendorBindings(organizationId: string, at: Date): Promise<VendorBindingsCleared>;
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
    async clearVendorBindings(organizationId, at) {
      await lockVendorBindingsForClear(tx, organizationId);
      const prescribers = await tx
        .update(P)
        .set({
          dosespotPrescriberId: null,
          vendorEnrollmentRequestedAt: null,
          npi: null,
          updatedAt: at,
        })
        .where(
          and(
            eq(P.organizationId, organizationId),
            or(isNotNull(P.dosespotPrescriberId), isNotNull(P.vendorEnrollmentRequestedAt)),
          ),
        )
        .returning({ id: P.id });
      // `last_sync_outcome = 'success'` requires an id (a CHECK), so a cleared row reads `failed` with a class that says why: the worker
      // asks for a fresh sync (and DoseSpot creates the patient at the new clinic) the next time an order needs one.
      const patients = await tx
        .update(SYNC)
        .set({
          lastDosespotPatientId: null,
          lastSyncOutcome: "failed",
          lastErrorClass: REGISTRATION_RETARGETED_CLASS,
          retryCount: 0,
          updatedAt: at,
        })
        .where(and(eq(SYNC.organizationId, organizationId), isNotNull(SYNC.lastDosespotPatientId)))
        .returning({ id: SYNC.id });
      const transmissions = await tx
        .update(MOT)
        .set({
          dosespotPrescriptionId: null,
          // the key names the order at the OLD clinic: a fresh one (registration-target.ts says why)
          idempotencyKey: freshIdempotencyKey(MOT.idempotencyKey),
        })
        .where(
          and(
            eq(MOT.organizationId, organizationId),
            isNull(MOT.transmissionSucceededAt),
            // a call that has BEGUN may be in flight (its worker alive) or about to be held (its worker dead): the created id is what the
            // administrator looks for at the old clinic, so it stays, and so does the key. A worker that is alive drops BOTH itself when its call
            // ends and it sees the move (transmit-settle.ts), unless that call is held for a person.
            isNull(MOT.transmissionStartedAt),
            // a held order's prescription may exist at the old clinic: its id is what the administrator looks for
            sql`${MOT.lastErrorClass} IS DISTINCT FROM ${UNCONFIRMED_OUTCOME_CLASS}`,
            // only a transmission still waiting to go out: a finished or failed order is history
            exists(
              tx
                .select({ one: sql`1` })
                .from(MO)
                .where(
                  and(eq(MO.id, MOT.medicationOrderId), eq(MO.status, "queued_for_transmission")),
                ),
            ),
          ),
        )
        .returning({ id: MOT.id });
      return {
        prescribers: prescribers.length,
        patients: patients.length,
        transmissions: transmissions.length,
      };
    },
  };
}
