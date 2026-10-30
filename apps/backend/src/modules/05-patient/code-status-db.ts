// apps/backend/src/modules/05-patient/code-status-db.ts — the Drizzle `PatientCodeStatusPort` (ADR-0104).
// Every call runs under `withOrgContext` as the acting user (RLS scopes it, the M4 trigger attributes it). The
// table is append-only for the app role (column-level UPDATE grant): a set INSERTs, a retraction stamps the
// entered-in-error columns. A set locks the patient row FOR UPDATE so concurrent sets serialise and `recordedAt`
// (the DB's clock_timestamp(), taken after the lock) orders them.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  CodeStatusAlreadyEnteredInErrorError,
  CodeStatusEntryNotFoundError,
  type CodeStatusList,
  CodeStatusPatientNotFoundError,
  CodeStatusSourceDocumentInvalidError,
  type CodeStatusView,
  type PatientCodeStatusPort,
} from "./code-status";

const CS = schema.patientCodeStatuses;
const P = schema.patients;

/** True when the document is this patient's readable code-status directive (answered by the M22 reader seam). */
export type SourceDirectiveCheck = (
  organizationId: string,
  patientId: string,
  documentId: string,
) => Promise<boolean>;

export function toCodeStatusView(r: typeof CS.$inferSelect): CodeStatusView {
  return {
    id: r.id,
    patientId: r.patientId,
    codeStatus: r.codeStatus,
    reason: r.reason,
    sourceDocumentId: r.sourceDocumentId,
    recordedByMembershipId: r.recordedByMembershipId,
    recordedAt: r.recordedAt.toISOString(),
    enteredInErrorAt: r.enteredInErrorAt ? r.enteredInErrorAt.toISOString() : null,
  };
}

/** Newest-first rows → the list; the current status is the first row that is not entered-in-error. */
export function toCodeStatusList(rows: readonly (typeof CS.$inferSelect)[]): CodeStatusList {
  const history = rows.map(toCodeStatusView);
  return { current: history.find((v) => v.enteredInErrorAt === null) ?? null, history };
}

export function createDbCodeStatusPort(
  db: DbClient,
  isSourceDirective: SourceDirectiveCheck,
): PatientCodeStatusPort {
  async function lockPatient(tx: DbClient, patientId: string): Promise<void> {
    const [p] = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).for("update");
    if (!p) throw new CodeStatusPatientNotFoundError();
  }

  return {
    async list(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [p] = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
        if (!p) return null;
        const rows = await tx
          .select()
          .from(CS)
          .where(eq(CS.patientId, patientId))
          .orderBy(desc(CS.recordedAt), desc(CS.id));
        return toCodeStatusList(rows);
      });
    },

    async set(organizationId, patientId, input, actor) {
      // Checked BEFORE the transaction: the M22 seam opens its own connection, and the patient row lock below must
      // not be held across it (pool pressure). The check is idempotent; the lock only orders the writes.
      if (
        input.sourceDocumentId &&
        !(await isSourceDirective(organizationId, patientId, input.sourceDocumentId))
      ) {
        throw new CodeStatusSourceDocumentInvalidError();
      }
      return withOrgContext(db, { organizationId, userId: actor.userId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        await lockPatient(tx, patientId);
        const [row] = await tx
          .insert(CS)
          .values({
            organizationId,
            patientId,
            codeStatus: input.codeStatus,
            reason: input.reason.trim(),
            sourceDocumentId: input.sourceDocumentId ?? null,
            recordedByMembershipId: actor.membershipId,
            // The DB clock, taken after the lock: ordering must not depend on an API instance's skewed clock.
            recordedAt: sql`clock_timestamp()`,
          })
          .returning();
        if (!row) throw new CodeStatusPatientNotFoundError();
        return toCodeStatusView(row);
      });
    },

    async enterInError(organizationId, patientId, entryId, input, actor) {
      return withOrgContext(db, { organizationId, userId: actor.userId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        await lockPatient(tx, patientId);
        const [row] = await tx
          .select()
          .from(CS)
          .where(and(eq(CS.id, entryId), eq(CS.patientId, patientId)))
          .for("update")
          .limit(1);
        if (!row) throw new CodeStatusEntryNotFoundError();
        if (row.enteredInErrorAt) throw new CodeStatusAlreadyEnteredInErrorError();
        const now = new Date();
        const [updated] = await tx
          .update(CS)
          .set({
            enteredInErrorByMembershipId: actor.membershipId,
            enteredInErrorAt: now,
            enteredInErrorReason: input.reason.trim(),
            updatedAt: now,
          })
          .where(eq(CS.id, entryId))
          .returning();
        if (!updated) throw new CodeStatusEntryNotFoundError();
        return toCodeStatusView(updated);
      });
    },
  };
}
