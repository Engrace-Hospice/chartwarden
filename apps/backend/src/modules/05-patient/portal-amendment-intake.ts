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
//
// DEDUPE (open duplicates). A same-key retry is replayed by the idempotency middleware, but a resubmit under
// a NEW key used to open a second §164.526 request for the same change. Each portal row now also carries
// `portalDedupeKey` — sha256 over (targetKind, targetRef, the requested change trimmed + whitespace-collapsed)
// — and migration 0323's partial UNIQUE index on (organization_id, patient_id, portalDedupeKey) WHERE
// status = 'pending' makes "one OPEN request per patient per change" a database invariant. The insert is
// `ON CONFLICT DO NOTHING`; on conflict the existing open row is read back and returned (same 202 shape).
// The index, not a pre-read, is the guarantee: two concurrent submits serialize on the index entry, the
// loser's insert does nothing, and — READ COMMITTED, so the follow-up SELECT is a fresh snapshot — it reads
// the winner's committed row. Once that row is decided or withdrawn it leaves the index predicate and the
// same change may be requested again.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, sql } from "drizzle-orm";

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
type NewRow = typeof schema.patientAmendmentRequests.$inferInsert;

/** The `requested_changes` key migration 0323's partial unique index is built on. */
export const PORTAL_DEDUPE_KEY_FIELD = "portalDedupeKey";

/**
 * Insert → conflict → read-back can lose one race: the open row we collided with is decided between our
 * insert and our read. Then the change is no longer open, so we insert again. Two attempts cover that;
 * a third failure means something else is wrong and is surfaced, not looped on.
 */
const MAX_SUBMIT_ATTEMPTS = 3;

/** Trim and collapse every whitespace run to one space — the comparison form of a requested change. */
export function normalizeRequestedChange(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The content key two submissions share iff they ask for the same change to the same target. */
export function portalAmendmentDedupeKey(input: {
  targetKind: string;
  targetRef: string;
  requestedChange: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.targetKind,
        input.targetRef,
        normalizeRequestedChange(input.requestedChange),
      ]),
    )
    .digest("hex");
}

/** The two statements a deduped submit runs, inside one org-scoped transaction. */
export interface PortalAmendmentWriteOps {
  /** INSERT … ON CONFLICT DO NOTHING — `null` when an OPEN row with the same dedupe key already exists. */
  insertUnlessOpenDuplicate(values: NewRow): Promise<Row | null>;
  /** The patient's OPEN (pending) portal row with this dedupe key, if any. */
  findOpenDuplicate(q: { patientId: string; dedupeKey: string }): Promise<Row | null>;
}

/** Submit one portal amendment, or return the patient's already-open request for the same change. */
export async function submitDedupedPortalAmendment(
  ops: PortalAmendmentWriteOps,
  input: PortalAmendmentSubmission,
  now: Date = new Date(),
): Promise<PortalAmendmentRecord> {
  const dedupeKey = portalAmendmentDedupeKey(input);
  const values: NewRow = {
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
      [PORTAL_DEDUPE_KEY_FIELD]: dedupeKey,
    },
    rationale: input.requestedChange,
    status: "pending",
    slaDueAt: new Date(now.getTime() + SIXTY_DAYS_MS),
  };
  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    const inserted = await ops.insertUnlessOpenDuplicate(values);
    if (inserted) return toRecord(inserted);
    const existing = await ops.findOpenDuplicate({ patientId: input.patientId, dedupeKey });
    if (existing) return toRecord(existing);
  }
  throw new Error(
    "portal amendment submit: conflicted on an open duplicate that was never readable",
  );
}

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
        async (tx) =>
          submitDedupedPortalAmendment(
            {
              async insertUnlessOpenDuplicate(values) {
                // No conflict target: the only other unique index is the random-uuid PK, so the one
                // conflict this can absorb is 0323's open-duplicate index.
                const [row] = await tx.insert(PAR).values(values).onConflictDoNothing().returning();
                return (row as Row | undefined) ?? null;
              },
              async findOpenDuplicate({ patientId, dedupeKey }) {
                const [row] = await tx
                  .select()
                  .from(PAR)
                  .where(
                    and(
                      eq(PAR.patientId, patientId),
                      eq(PAR.status, "pending"),
                      sql`${PAR.requestedChanges} ->> ${sql.raw(`'${PORTAL_DEDUPE_KEY_FIELD}'`)} = ${dedupeKey}`,
                    ),
                  )
                  .limit(1);
                return (row as Row | undefined) ?? null;
              },
            },
            input,
          ),
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
