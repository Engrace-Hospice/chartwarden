// apps/backend/src/modules/05-patient/portal-amendment-intake.ts — GAP-006: the M5 side of the portal
// §164.526 amendment submit.
//
// M5 OWNS `patient_amendment_request` (the canonical record, the 60-day SLA, accept/deny). M31 hosts the
// portal SUBMIT surface, and until now it validated the request, answered 202 "submitted" with an id it made
// up, and persisted nothing — the 60-day clock never started and GET /portal/amendments was always empty.
// This intake is what M31's route now calls (bound by the composition root onto M31's
// `PortalAmendmentIntakePort`, so neither module imports the other): one real M5 row per submission, and
// the requester's own rows read back.
//
// The portal origin rides `requested_changes` (jsonb — the column's documented shape is a per-request object):
// `source: "portal"`, the originating portal account, and the lay target the caller named. No new column is
// needed to tell a portal request from a staff one, and the staff review queue sees the same row either way.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq } from "drizzle-orm";

const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

/** The lay target a portal caller names (M31 §7.9). */
export type PortalAmendmentTargetKind = "patient_demographic" | "encounter_narrative";

/** M5's `scope` vocabulary for each portal target. */
const SCOPE_FOR: Readonly<Record<PortalAmendmentTargetKind, string>> = {
  patient_demographic: "demographic",
  encounter_narrative: "narrative",
};

export interface PortalAmendmentSubmission {
  readonly organizationId: string;
  readonly patientId: string;
  /** The portal session's user — the requester of record (`requested_by_user_id`). */
  readonly requestedByUserId: string;
  readonly portalAccountId: string;
  readonly targetKind: PortalAmendmentTargetKind;
  readonly targetRef: string;
  readonly requestedChange: string;
}

export interface PortalAmendmentRecord {
  readonly id: string;
  readonly targetKind: string;
  readonly targetRef: string;
  readonly requestedChange: string;
  readonly status: string;
  readonly submittedAt: string;
  readonly slaDueAt: string;
  readonly decidedAt: string | null;
  readonly denialReason: string | null;
}

export interface PortalAmendmentIntake {
  submit(input: PortalAmendmentSubmission): Promise<PortalAmendmentRecord>;
  /** The requester's own portal-submitted requests for this patient, newest first. */
  listOwn(q: {
    organizationId: string;
    patientId: string;
    requestedByUserId: string;
  }): Promise<PortalAmendmentRecord[]>;
}

type Row = typeof schema.patientAmendmentRequests.$inferSelect;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toRecord(r: Row): PortalAmendmentRecord {
  const changes = (r.requestedChanges ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    targetKind: str(changes.targetKind),
    targetRef: str(changes.targetRef),
    requestedChange: str(changes.requestedChange) || r.rationale,
    status: r.status,
    submittedAt: r.receivedAt.toISOString(),
    slaDueAt: r.slaDueAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    denialReason: r.denialReason,
  };
}

/** The Drizzle intake over `patient_amendment_request`, under `withOrgContext` (RLS-scoped to the org). */
export function createDbPortalAmendmentIntake(db: DbClient): PortalAmendmentIntake {
  const PAR = schema.patientAmendmentRequests;
  return {
    async submit(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.requestedByUserId },
        async (tx) => {
          const [row] = await tx
            .insert(PAR)
            .values({
              organizationId: input.organizationId,
              patientId: input.patientId,
              requestedByUserId: input.requestedByUserId,
              scope: SCOPE_FOR[input.targetKind],
              requestedChanges: {
                source: "portal",
                originatingPortalAccountId: input.portalAccountId,
                targetKind: input.targetKind,
                targetRef: input.targetRef,
                requestedChange: input.requestedChange,
              },
              rationale: input.requestedChange,
              status: "pending",
              slaDueAt: new Date(Date.now() + SIXTY_DAYS_MS),
            })
            .returning();
          return toRecord(row as Row);
        },
      );
    },
    async listOwn(q) {
      return withOrgContext(
        db,
        { organizationId: q.organizationId, userId: q.requestedByUserId },
        async (tx) => {
          const rows = await tx
            .select()
            .from(PAR)
            .where(
              and(eq(PAR.patientId, q.patientId), eq(PAR.requestedByUserId, q.requestedByUserId)),
            )
            .orderBy(desc(PAR.receivedAt));
          return (rows as Row[])
            .filter((r) => (r.requestedChanges as { source?: unknown } | null)?.source === "portal")
            .map(toRecord);
        },
      );
    },
  };
}
