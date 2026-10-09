// apps/backend/src/modules/05-patient/wristband-db.ts -- GAP-020: the DB side of issuing, reading and voiding a
// patient wristband generation. Every statement runs under `withOrgContext` (RLS scopes it; the explicit
// organization_id predicate is the belt) and the writes hold the patient row `FOR UPDATE`, so two prints (a
// double-click, two nurses) serialise and the second hits the `expectedCurrentGeneration` precondition.
//
// The RAW token is minted here, returned ONCE to the caller to print, and never stored, logged, audited or put
// on an outbox event: only its org-salted digest is persisted (`wristband-digest.ts`). Issue / void / supersede
// are audited by the `patient_wristband` M4 write-audit trigger (which scrubs the digest). No outbox event is
// emitted: nothing downstream consumes a print.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  NotFoundError,
  WardenXError,
  type WristbandIssueReason,
  type WristbandVoidReason,
  parseWristbandPayload,
} from "@wardenx/types";
import { and, desc, eq, sql } from "drizzle-orm";
import { mintWristbandPayload, wristbandDigest } from "./wristband-digest";
import {
  type WristbandGenerationState,
  planWristbandIssue,
  planWristbandVoid,
} from "./wristband-plan";

const P = schema.patients;
const W = schema.patientWristbands;

/** A digest collision on a 128-bit token is astronomically unlikely; one retry, then fail loudly. */
const MAX_MINT_ATTEMPTS = 2;
/** Statuses that can no longer wear a band: a merged source or a deceased patient. */
const UNBANDABLE_STATUSES = new Set(["merged", "deceased"]);

export interface WristbandActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface IssuedWristband {
  readonly generation: number;
  /** The RAW printable payload. Shown once; not recoverable afterwards. */
  readonly payload: string;
  readonly issuedAt: string;
  /** The human-readable line printed beside the code. The code itself carries none of this. */
  readonly label: { readonly name: string; readonly mrn: string; readonly dob: string };
}

export interface WristbandStatusView {
  readonly state: "none" | "active";
  readonly generation: number | null;
  readonly issuedAt: string | null;
  /** Any generation exists, voided or superseded included: the planner then refuses `first_issue`. */
  readonly everIssued: boolean;
}

const asDb = (tx: unknown): DbClient => tx as DbClient;

function labelName(p: {
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  legalNameSuffix: string | null;
}): string {
  return [p.legalFirstName, p.legalMiddleName, p.legalLastName, p.legalNameSuffix]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

async function lockPatient(tx: DbClient, organizationId: string, patientId: string) {
  const [patient] = await tx
    .select({
      id: P.id,
      providerEntityId: P.providerEntityId,
      locationId: P.locationId,
      status: P.status,
      mrn: P.mrn,
      dob: P.dob,
      legalFirstName: P.legalFirstName,
      legalMiddleName: P.legalMiddleName,
      legalLastName: P.legalLastName,
      legalNameSuffix: P.legalNameSuffix,
    })
    .from(P)
    .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
    .for("update")
    .limit(1);
  if (!patient) throw new NotFoundError("patient", patientId);
  return patient;
}

async function generationsOf(
  tx: DbClient,
  organizationId: string,
  patientId: string,
): Promise<WristbandGenerationState[]> {
  return tx
    .select({ generation: W.generation, supersededAt: W.supersededAt, voidedAt: W.voidedAt })
    .from(W)
    .where(and(eq(W.organizationId, organizationId), eq(W.patientId, patientId)))
    .orderBy(desc(W.generation));
}

/** Print: mint a token, supersede the active generation, insert the next. One transaction. */
export async function issuePatientWristband(
  db: DbClient,
  actor: WristbandActor,
  input: {
    readonly patientId: string;
    readonly reason: WristbandIssueReason;
    readonly expectedCurrentGeneration: number | null;
  },
): Promise<IssuedWristband> {
  return withOrgContext(db, actor, async (txRaw) => {
    const tx = asDb(txRaw);
    const patient = await lockPatient(tx, actor.organizationId, input.patientId);
    if (UNBANDABLE_STATUSES.has(patient.status))
      throw new WardenXError(
        "PATIENT_NOT_BANDABLE",
        `a ${patient.status} patient cannot be issued a wristband`,
        409,
      );

    const generations = await generationsOf(tx, actor.organizationId, input.patientId);
    const plan = planWristbandIssue({
      generations,
      expectedCurrentGeneration: input.expectedCurrentGeneration,
      reason: input.reason,
    });
    if (!plan.ok) {
      if (plan.code === "WRISTBAND_GENERATION_CONFLICT")
        throw new ConflictError(
          "another wristband was printed for this patient first; refresh before printing again",
        );
      throw new WardenXError(
        "WRISTBAND_REASON_INVALID",
        input.reason === "first_issue"
          ? "this patient already has a wristband; choose a reprint reason"
          : "this patient has no wristband yet; the first print is 'first_issue'",
        422,
      );
    }

    if (plan.supersedeGeneration !== null)
      await tx
        .update(W)
        .set({ supersededAt: sql`now()` })
        .where(
          and(
            eq(W.organizationId, actor.organizationId),
            eq(W.patientId, input.patientId),
            eq(W.generation, plan.supersedeGeneration),
          ),
        );

    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt++) {
      const payload = mintWristbandPayload();
      const parsed = parseWristbandPayload(payload);
      if (!parsed.ok) throw new Error("minted wristband payload failed its own codec");
      const digest = wristbandDigest(actor.organizationId, parsed.token);
      const inserted = await tx
        .insert(W)
        .values({
          organizationId: actor.organizationId,
          providerEntityId: patient.providerEntityId,
          locationId: patient.locationId,
          patientId: input.patientId,
          generation: plan.nextGeneration,
          payloadDigest: digest,
          issuedByUserId: actor.userId,
          issueReason: input.reason,
        })
        .onConflictDoNothing({ target: [W.organizationId, W.payloadDigest] })
        .returning({ generation: W.generation, issuedAt: W.issuedAt });
      const row = inserted[0];
      if (row)
        return {
          generation: row.generation,
          payload,
          issuedAt: row.issuedAt.toISOString(),
          label: { name: labelName(patient), mrn: patient.mrn, dob: String(patient.dob) },
        };
    }
    throw new Error("could not mint a unique wristband token");
  });
}

/** The chart badge: is there an active band, and which generation. Never returns a token or a digest. */
export async function getPatientWristbandStatus(
  db: DbClient,
  actor: WristbandActor,
  patientId: string,
): Promise<WristbandStatusView> {
  return withOrgContext(db, actor, async (txRaw) => {
    const tx = asDb(txRaw);
    const [patient] = await tx
      .select({ id: P.id })
      .from(P)
      .where(and(eq(P.organizationId, actor.organizationId), eq(P.id, patientId)))
      .limit(1);
    if (!patient) throw new NotFoundError("patient", patientId);
    const rows = await tx
      .select({
        generation: W.generation,
        issuedAt: W.issuedAt,
        supersededAt: W.supersededAt,
        voidedAt: W.voidedAt,
      })
      .from(W)
      .where(and(eq(W.organizationId, actor.organizationId), eq(W.patientId, patientId)))
      .orderBy(desc(W.generation));
    const active = rows.find((r) => r.supersededAt === null && r.voidedAt === null);
    const everIssued = rows.length > 0;
    return active
      ? {
          state: "active",
          generation: active.generation,
          issuedAt: active.issuedAt.toISOString(),
          everIssued,
        }
      : { state: "none", generation: null, issuedAt: null, everIssued };
  });
}

/** Hard-kill one named generation (identity error / compromise). Operator route; step-up is the route's guard. */
export async function voidPatientWristband(
  db: DbClient,
  actor: WristbandActor,
  input: {
    readonly patientId: string;
    readonly generation: number;
    readonly reason: WristbandVoidReason;
  },
): Promise<void> {
  await withOrgContext(db, actor, async (txRaw) => {
    const tx = asDb(txRaw);
    await lockPatient(tx, actor.organizationId, input.patientId);
    const generations = await generationsOf(tx, actor.organizationId, input.patientId);
    const plan = planWristbandVoid({ generations, generation: input.generation });
    if (!plan.ok) {
      if (plan.code === "NOT_FOUND") throw new NotFoundError("wristband generation");
      throw new ConflictError("that wristband generation is already voided");
    }
    await tx
      .update(W)
      .set({
        voidedAt: sql`now()`,
        voidedByUserId: actor.userId.length > 0 ? actor.userId : null,
        voidReason: input.reason,
      })
      .where(
        and(
          eq(W.organizationId, actor.organizationId),
          eq(W.patientId, input.patientId),
          eq(W.generation, input.generation),
        ),
      );
  });
}

/**
 * Void EVERY not-yet-voided generation of a patient inside the caller's transaction (merge source, death,
 * destruction certificate). A lifecycle event that makes a printed band untrustworthy kills it in the same
 * commit, so there is no window in which the old band still verifies. Returns how many rows it voided.
 */
export async function voidPatientWristbandsInTx(
  tx: DbClient,
  args: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly reason: WristbandVoidReason;
    /** The acting user, or null/"" for a system actor. */
    readonly actorUserId: string | null;
  },
): Promise<number> {
  const voided = await tx
    .update(W)
    .set({
      voidedAt: sql`now()`,
      voidedByUserId: args.actorUserId && args.actorUserId.length > 0 ? args.actorUserId : null,
      voidReason: args.reason,
    })
    .where(
      and(
        eq(W.organizationId, args.organizationId),
        eq(W.patientId, args.patientId),
        sql`${W.voidedAt} IS NULL`,
      ),
    )
    .returning({ id: W.id });
  return voided.length;
}
