// apps/backend/src/modules/05-patient/assignments-db.ts — the real Drizzle-backed M5 §4.3 assignment
// writer (GAP-015) — the FIRST production code that writes `patient_assignment`.
//
// Every operation runs in ONE `withOrgContext` transaction as the acting user (RLS scopes by app.org_id;
// the M4 PHI-write trigger attributes the row), and publishes `m5.patient.assignment_created` /
// `.assignment_ended` through the injected m5 outbox port in that same transaction, so a rejected
// payload rolls the write back.
//
// Open = `unassigned_at IS NULL`. The table's only constraint is the partial unique index on
// (patient_id, role) WHERE role='primary_rn' AND open, so the "no duplicate open (patient, clinician,
// role)" rule is enforced HERE, serialised per patient by `SELECT … FOR UPDATE` on the patient row (a
// concurrent assign on the same patient waits, then sees the committed row). The primary_rn index
// remains the backstop and surfaces as the same typed 409.
//
// CACHE: the durable caseload read (`createDrizzleCaseloadStore`) queries `patient_assignment` on every
// call — there is no durable-set cache to invalidate. The only cache (M17's shift Valkey set) is a
// separate additive union keyed by visit, not by this table.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  type AssignClinicianInput,
  AssignmentAlreadyEndedError,
  AssignmentAlreadyOpenError,
  AssignmentEndBeforeStartError,
  AssignmentNotFoundError,
  AssignmentPatientNotFoundError,
  type AssignmentView,
  ClinicianNotInOrgError,
  type EndAssignmentInput,
  type PatientAssignmentsPort,
  PrimaryRnAlreadyAssignedError,
} from "./assignments";
import type { M5OutboxPort } from "./deceased-db";
import { ADMITTING_STAFF_ASSIGNMENT_ROLE } from "./seams/care-team-provider";

const PA = schema.patientAssignments;
const P = schema.patients;
const MB = schema.memberships;

const PRIMARY_RN = "primary_rn";
const UNIQUE_VIOLATION = "23505";
const PRIMARY_RN_INDEX = "patient_assignment_primary_rn_unique";

const todayIso = (): string => new Date().toISOString().slice(0, 10);

function toView(row: typeof PA.$inferSelect): AssignmentView {
  return {
    id: row.id,
    patientId: row.patientId,
    clinicianUserId: row.clinicianUserId,
    role: row.role,
    assignedAt: row.assignedAt,
    unassignedAt: row.unassignedAt,
    reason: row.reason,
    current: row.unassignedAt === null,
  };
}

/** True for the Postgres unique violation on the primary_rn partial index (driver error or its cause). */
function isPrimaryRnViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === UNIQUE_VIOLATION && e.constraint === PRIMARY_RN_INDEX) return true;
  return e.cause !== undefined && isPrimaryRnViolation(e.cause);
}

/**
 * Put the actor who created a patient from a referral on that patient's caseload, in the caller's
 * transaction (the one that inserts the patient; the referral update is a separate outer transaction): an OPEN
 * `admitting_staff` row, which is what `caseload_or_scope` / `admission.scope` read. Idempotent — an
 * already-open row for (patient, user, role) is left alone. The caller's `withOrgContext` carries the actor,
 * so the M4 write-audit trigger attributes the row.
 *
 * `admitting_staff` is an access grant only: care-team rosters (CareTeamProvider.careTeamMembers, which drives
 * the M36 care-team channel sync, and the displayed care team) exclude it, and no outbox event is published
 * for the same reason. It is system-issued (the manual assign route rejects the role) and is ended by
 * {@link endAdmittingAssignments} when the admission activates (every delivery path) or is discharged, when the
 * referral is declined / marked duplicate / withdrawn (M5's `m6-referral-closed` consumer), and by the daily
 * `admitting-grant-expiry` sweep once it is 14 days old; until then
 * it stays open. It is CASELOAD-WIDE by design: like any open assignment it opens the patient's chart and
 * every `caseload_or_scope` surface for the holder, not only the admission they were creating.
 */
export async function ensureAdmittingAssignment(
  tx: DbClient,
  grant: { organizationId: string; patientId: string; userId: string; reason?: string },
): Promise<void> {
  const existing = await tx
    .select({ id: PA.id })
    .from(PA)
    .where(
      and(
        eq(PA.patientId, grant.patientId),
        eq(PA.clinicianUserId, grant.userId),
        eq(PA.role, ADMITTING_STAFF_ASSIGNMENT_ROLE),
        isNull(PA.unassignedAt),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await tx.insert(PA).values({
    patientId: grant.patientId,
    organizationId: grant.organizationId,
    clinicianUserId: grant.userId,
    role: ADMITTING_STAFF_ASSIGNMENT_ROLE,
    assignedAt: todayIso(),
    reason: grant.reason ?? "Created the patient from a referral",
  });
}

/**
 * End every open `admitting_staff` grant on a patient (the admission activated: from here access comes from the
 * care team or an org-wide role, not from having created the patient). Org-explicit, idempotent (a second call
 * finds nothing open) and a no-op when there is no grant. Runs in the caller's transaction.
 *
 * `clinicianUserId` narrows the end to one holder (a closed referral ends only its patient creator's grant,
 * not a colleague's); omitted, every open grant on the patient ends (activation, discharge).
 */
export async function endAdmittingAssignments(
  tx: DbClient,
  scope: { organizationId: string; patientId: string; clinicianUserId?: string },
): Promise<void> {
  await tx
    .update(PA)
    .set({ unassignedAt: todayIso() })
    .where(
      and(
        eq(PA.organizationId, scope.organizationId),
        eq(PA.patientId, scope.patientId),
        eq(PA.role, ADMITTING_STAFF_ASSIGNMENT_ROLE),
        isNull(PA.unassignedAt),
        ...(scope.clinicianUserId ? [eq(PA.clinicianUserId, scope.clinicianUserId)] : []),
      ),
    );
}

export function createDbAssignmentsPort(
  db: DbClient,
  outbox: M5OutboxPort,
  now: () => string = todayIso,
): PatientAssignmentsPort {
  /** Lock the patient row (serialises assignment writes per patient); throws when absent / out of org. */
  async function lockPatient(tx: DbClient, patientId: string): Promise<void> {
    const [patient] = await tx
      .select({ id: P.id })
      .from(P)
      .where(eq(P.id, patientId))
      .for("update")
      .limit(1);
    if (!patient) throw new AssignmentPatientNotFoundError(patientId);
  }

  return {
    async list(organizationId, patientId) {
      return withOrgContext<DbClient, readonly AssignmentView[] | null>(
        db,
        { organizationId, userId: "" },
        async (tx) => {
          const [patient] = await tx
            .select({ id: P.id })
            .from(P)
            .where(eq(P.id, patientId))
            .limit(1);
          if (!patient) return null;
          const rows = await tx
            .select()
            .from(PA)
            .where(eq(PA.patientId, patientId))
            .orderBy(desc(PA.assignedAt), asc(PA.id));
          // Open rows first (Postgres sorts NULL last under asc), newest assignment first within each.
          const views = rows.map(toView);
          return [...views.filter((v) => v.current), ...views.filter((v) => !v.current)];
        },
      );
    },

    async assign(organizationId, patientId, input: AssignClinicianInput, actorUserId) {
      try {
        return await withOrgContext<DbClient, AssignmentView>(
          db,
          { organizationId, userId: actorUserId },
          async (tx) => {
            await lockPatient(tx, patientId);

            const [member] = await tx
              .select({ id: MB.id })
              .from(MB)
              .where(
                and(
                  eq(MB.organizationId, organizationId),
                  eq(MB.userId, input.clinicianUserId),
                  eq(MB.status, "active"),
                ),
              )
              .limit(1);
            if (!member) throw new ClinicianNotInOrgError(input.clinicianUserId);

            const open = await tx
              .select({ clinicianUserId: PA.clinicianUserId, role: PA.role })
              .from(PA)
              .where(and(eq(PA.patientId, patientId), isNull(PA.unassignedAt)));
            if (
              open.some((r) => r.clinicianUserId === input.clinicianUserId && r.role === input.role)
            ) {
              throw new AssignmentAlreadyOpenError(input.clinicianUserId, input.role);
            }
            if (input.role === PRIMARY_RN && open.some((r) => r.role === PRIMARY_RN)) {
              throw new PrimaryRnAlreadyAssignedError(patientId);
            }

            const [row] = await tx
              .insert(PA)
              .values({
                patientId,
                organizationId,
                clinicianUserId: input.clinicianUserId,
                role: input.role as typeof PA.$inferInsert.role,
                assignedAt: input.assignedAt ?? now(),
                reason: input.reason ?? null,
              })
              .returning();
            if (!row) throw new Error("patient_assignment insert returned no row");

            await outbox.publish(tx, {
              eventName: "m5.patient.assignment_created",
              payload: {
                patientId,
                organizationId,
                clinicianUserId: input.clinicianUserId,
                role: input.role,
              },
              organizationId,
              aggregateKind: "patient",
              aggregateId: patientId,
            });
            return toView(row);
          },
        );
      } catch (err) {
        if (isPrimaryRnViolation(err)) throw new PrimaryRnAlreadyAssignedError(patientId);
        throw err;
      }
    },

    async end(organizationId, patientId, assignmentId, input: EndAssignmentInput, actorUserId) {
      return withOrgContext<DbClient, AssignmentView>(
        db,
        { organizationId, userId: actorUserId },
        async (tx) => {
          await lockPatient(tx, patientId);
          const [row] = await tx
            .select()
            .from(PA)
            .where(and(eq(PA.id, assignmentId), eq(PA.patientId, patientId)))
            .for("update")
            .limit(1);
          if (!row) throw new AssignmentNotFoundError(assignmentId);
          if (row.unassignedAt !== null) throw new AssignmentAlreadyEndedError(assignmentId);

          const unassignedAt = input.unassignedAt ?? now();
          if (unassignedAt < row.assignedAt) {
            throw new AssignmentEndBeforeStartError(row.assignedAt, unassignedAt);
          }

          const [updated] = await tx
            .update(PA)
            .set({ unassignedAt })
            .where(and(eq(PA.id, assignmentId), isNull(PA.unassignedAt)))
            .returning();
          if (!updated) throw new AssignmentAlreadyEndedError(assignmentId);

          await outbox.publish(tx, {
            eventName: "m5.patient.assignment_ended",
            payload: {
              patientId,
              organizationId,
              clinicianUserId: row.clinicianUserId,
              role: row.role,
            },
            organizationId,
            aggregateKind: "patient",
            aggregateId: patientId,
          });
          return toView(updated);
        },
      );
    },
  };
}
