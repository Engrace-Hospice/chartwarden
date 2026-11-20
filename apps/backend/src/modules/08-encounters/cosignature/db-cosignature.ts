// apps/backend/src/modules/08-encounters/cosignature/db-cosignature.ts — the Drizzle half of the §2.4 cosignature workflow, written ONCE for both
// subjects (ADR-0114 VN-D30; ./subject.ts): the note's own request (`cosignature_request`) and the request an amending addendum opened
// (`addendum_cosignature_request`). The state machine is `transitionCosignature`, unchanged; what differs by subject is only where the row lives,
// who the author is (no self-cosign), and what a signature does: a note's cosignature moves the encounter to `cosigned` and publishes
// `m8.encounter.cosigned`; an amendment's leaves the encounter as it is (its status belongs to the note) and publishes
// `m8.encounter.addendum_cosigned`, which no billing consumer reads (an amendment never re-opens billing).
//
// Every request is locked `FOR UPDATE` before it is read for a decision, so two concurrent signs (or an acknowledge racing a sign) take turns and the
// second finds the request already `signed`: 409 `ILLEGAL_TRANSITION`, never a unique-index error. The two tables carry the same columns (pinned by
// visit-note-draft-migration-pins.test.ts), which is why one set of statements serves both.
import { type DbClient, schema } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import type { EncounterDiscipline, LocalDate } from "@chartwarden/types";
import { type SQL, and, eq } from "drizzle-orm";
import { transitionEncounter } from "../lifecycle/encounter";
import { EncounterStateError } from "../lifecycle/errors";
import { assertNotAuthor } from "../routes/service";
import { type CosignatureState, transitionCosignature } from "./cosignature";
import type { CosignSubject } from "./subject";

const ENC = schema.encounters;
const NOTE_REQUEST = schema.cosignatureRequests;
const ADDENDUM_REQUEST = schema.addendumCosignatureRequests;
const ADDENDUM = schema.encounterAddenda;
const SIG = schema.encounterSignatures;

/** The attestation presented to an RN cosigning a NOTE (§3.3 `attestation_text`, at least 50 characters; pending the final legal copy). */
export const COSIGNATURE_ATTESTATION_TEXT =
  "I attest, as the qualified RN cosigner, that I have reviewed this clinical documentation and concur with the care described (cosignature, pending final legal copy).";
/** The attestation presented to an RN cosigning an AMENDMENT of a signed note. */
export const ADDENDUM_COSIGNATURE_ATTESTATION_TEXT =
  "I attest, as the qualified RN cosigner, that I have reviewed this amendment to the signed clinical documentation and concur with it (amendment cosignature, pending final legal copy).";

/** The request row, whichever table holds it (both have these columns). */
export type CosignRequestRow = typeof NOTE_REQUEST.$inferSelect;
/** The one table type the shared statements are written against: `addendum_cosignature_request` has the same columns, plus `addendum_id`. */
type RequestTable = typeof NOTE_REQUEST;

/** The server-verified provenance of one sign (the service resolves it from M2's session seam; never a client claim). */
export interface CosignProvenance {
  readonly stepUpFresh: boolean;
  readonly method: (typeof schema.signatureMethod.enumValues)[number];
  readonly stepUpAuthAt: Date;
}

export interface CosignatureDeps {
  /** Publishes one `m8.*` event on the caller's transaction (the bound publisher validates it against the catalog). */
  readonly emit: (
    tx: DbClient,
    organizationId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  readonly resolveProvenance: (
    organizationId: string,
    sessionId: string,
  ) => Promise<CosignProvenance>;
}

/** The acting member of a cosign or release: the session's membership and the step-up session (the machine's `stepUpFresh` guard). */
export interface CosignActor {
  readonly membershipId: string;
  readonly sessionId: string;
}

const requestTableOf = (subject: CosignSubject): RequestTable =>
  subject.kind === "note" ? NOTE_REQUEST : (ADDENDUM_REQUEST as unknown as RequestTable);

const subjectWhere = (subject: CosignSubject): SQL | undefined =>
  subject.kind === "note"
    ? eq(NOTE_REQUEST.encounterId, subject.encounterId)
    : and(
        eq(ADDENDUM_REQUEST.addendumId, subject.addendumId),
        eq(ADDENDUM_REQUEST.encounterId, subject.encounterId),
      );

/** The subject's request, locked `FOR UPDATE`, or the non-leaking 404. */
async function loadRequest(
  tx: DbClient,
  subject: CosignSubject,
  lock: boolean,
): Promise<CosignRequestRow> {
  const table = requestTableOf(subject);
  const query = tx.select().from(table).where(subjectWhere(subject)).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new NotFoundError("cosignature_request");
  return row;
}

async function loadEncounter(tx: DbClient, encounterId: string) {
  const [row] = await tx.select().from(ENC).where(eq(ENC.id, encounterId)).limit(1);
  if (!row) throw new NotFoundError("encounter");
  return row;
}

/**
 * No self-cosign (GAP-029), by MEMBERSHIP id, for what the request is about: the note's author, and for an amendment its addendum's author as
 * well. The route's `m8.cosigner_role_match` predicate says the same; this is the service-level guard a caller that bypasses the route meets.
 */
async function assertNotTheAuthor(
  tx: DbClient,
  subject: CosignSubject,
  noteAuthorMembershipId: string,
  actorMembershipId: string,
): Promise<void> {
  assertNotAuthor(noteAuthorMembershipId, actorMembershipId);
  if (subject.kind === "note") return;
  const [addendum] = await tx
    .select({ authoredByMembershipId: ADDENDUM.authoredByMembershipId })
    .from(ADDENDUM)
    .where(and(eq(ADDENDUM.id, subject.addendumId), eq(ADDENDUM.encounterId, subject.encounterId)))
    .limit(1);
  if (!addendum) throw new NotFoundError("addendum");
  assertNotAuthor(addendum.authoredByMembershipId, actorMembershipId);
}

/** The request's state (route 18): `null` before any routing. */
export async function readCosignatureStatus(
  tx: DbClient,
  subject: CosignSubject,
): Promise<{ status: CosignatureState | null }> {
  const [encounter] = await tx
    .select({ id: ENC.id })
    .from(ENC)
    .where(eq(ENC.id, subject.encounterId))
    .limit(1);
  if (!encounter) throw new NotFoundError("encounter"); // 404 before status
  if (subject.kind === "addendum") {
    const [addendum] = await tx
      .select({ id: ADDENDUM.id })
      .from(ADDENDUM)
      .where(
        and(eq(ADDENDUM.id, subject.addendumId), eq(ADDENDUM.encounterId, subject.encounterId)),
      )
      .limit(1);
    if (!addendum) throw new NotFoundError("addendum");
  }
  const table = requestTableOf(subject);
  const [request] = await tx
    .select({ status: table.status })
    .from(table)
    .where(subjectWhere(subject))
    .limit(1);
  return { status: request ? (request.status as CosignatureState) : null };
}

/** The cosigner opens the request from their queue (§7.2). */
export async function acknowledgeCosignature(
  tx: DbClient,
  subject: CosignSubject,
  actor: CosignActor,
  at: LocalDate,
): Promise<{ status: CosignatureState }> {
  const request = await loadRequest(tx, subject, true);
  const encounter = await loadEncounter(tx, subject.encounterId);
  await assertNotTheAuthor(tx, subject, encounter.authoredByMembershipId, actor.membershipId);
  const trans = transitionCosignature(request.status, { type: "acknowledge", at });
  const table = requestTableOf(subject);
  const now = new Date();
  await tx
    .update(table)
    .set({ status: trans.to, acknowledgedAt: now, updatedAt: now })
    .where(eq(table.id, request.id));
  return { status: trans.to };
}

export interface SignCosignatureArgs {
  readonly isQualifiedRn: boolean;
  readonly at: LocalDate;
}

/**
 * A qualified RN signs as cosigner, with fresh step-up (CoP 418.104(c)). A NOTE's request then moves the encounter to `cosigned`; an AMENDMENT's
 * leaves the encounter's status alone. The provenance row is `cosignature` for a note and `addendum_cosignature` for an amendment (migration 1524,
 * the addendum named in `addendum_id`). Answers the encounter's status as it stands.
 */
export async function signCosignature(
  tx: DbClient,
  deps: CosignatureDeps,
  organizationId: string,
  subject: CosignSubject,
  actor: CosignActor,
  args: SignCosignatureArgs,
): Promise<{ status: (typeof ENC.$inferSelect)["status"]; cosignedAt: string }> {
  const request = await loadRequest(tx, subject, true);
  const encounter = await loadEncounter(tx, subject.encounterId);
  await assertNotTheAuthor(tx, subject, encounter.authoredByMembershipId, actor.membershipId);
  const now = new Date();
  const provenance = await deps.resolveProvenance(organizationId, actor.sessionId);
  const transition = transitionCosignature(request.status, {
    type: "sign",
    isQualifiedRn: args.isQualifiedRn,
    stepUpFresh: provenance.stepUpFresh,
    at: args.at,
  });
  const table = requestTableOf(subject);
  await tx
    .update(table)
    .set({ status: transition.to, signedAt: now, updatedAt: now })
    .where(eq(table.id, request.id));
  if (!encounter.providerEntityId || !encounter.locationId) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      "encounter must be sited (provider entity + location) before it can be cosigned",
    );
  }
  let status = encounter.status;
  if (subject.kind === "note") {
    status = transitionEncounter(encounter.status, { type: "recordCosignature", at: args.at }).to;
    await tx
      .update(ENC)
      .set({ status, cosignedAt: now, updatedAt: now })
      .where(eq(ENC.id, encounter.id));
  }
  await tx.insert(SIG).values({
    organizationId,
    providerEntityId: encounter.providerEntityId,
    locationId: encounter.locationId,
    encounterId: encounter.id,
    ...(subject.kind === "addendum" ? { addendumId: subject.addendumId } : {}),
    kind: subject.kind === "note" ? "cosignature" : "addendum_cosignature",
    // The RN cosigner's discipline: the transition above already required isQualifiedRn, so 'rn' is the only discipline a cosignature can carry.
    signedByMembershipId: actor.membershipId,
    signedByDiscipline: "rn" satisfies EncounterDiscipline,
    signedAt: now,
    method: provenance.method,
    sessionId: actor.sessionId,
    stepUpAuthAt: provenance.stepUpAuthAt,
    attestationText:
      subject.kind === "note"
        ? COSIGNATURE_ATTESTATION_TEXT
        : ADDENDUM_COSIGNATURE_ATTESTATION_TEXT,
    layer2InvolvedAtSigning: false,
  });
  const base = { encounterId: encounter.id, cosignedByMembershipId: actor.membershipId };
  if (subject.kind === "note") {
    await deps.emit(tx, organizationId, "m8.encounter.cosigned", "encounter", encounter.id, {
      ...base,
      cosignedAt: now.toISOString(),
    });
  } else {
    await deps.emit(
      tx,
      organizationId,
      "m8.encounter.addendum_cosigned",
      "addendum_cosignature_request",
      request.id,
      { ...base, addendumId: subject.addendumId, cosignedAt: now.toISOString() },
    );
  }
  return { status, cosignedAt: now.toISOString() };
}

export interface ReleaseCosignatureArgs {
  readonly isSupervisor: boolean;
  readonly reason: string;
  readonly at: LocalDate;
  /** The releasing supervisor's membership (the session's); falls back to the request's cosigner when a caller names none. */
  readonly actorMembershipId?: string;
}

/** A clinical supervisor / DON releases a request past the 48h hard cap with a documented reason; the cosigner still has to sign (§7.3). */
export async function releaseCosignature(
  tx: DbClient,
  subject: CosignSubject,
  args: ReleaseCosignatureArgs,
): Promise<{ status: CosignatureState }> {
  const request = await loadRequest(tx, subject, true);
  const trans = transitionCosignature(request.status, {
    type: "release",
    isSupervisor: args.isSupervisor,
    reason: args.reason,
    at: args.at,
  });
  const table = requestTableOf(subject);
  const now = new Date();
  await tx
    .update(table)
    .set({
      status: trans.to,
      supervisorReleasedAt: now,
      supervisorReleasedBy: args.actorMembershipId ?? request.routedToMembershipId,
      supervisorReleasedReason: args.reason,
      updatedAt: now,
    })
    .where(eq(table.id, request.id));
  return { status: trans.to };
}
