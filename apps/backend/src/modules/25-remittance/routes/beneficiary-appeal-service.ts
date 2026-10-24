// apps/backend/src/modules/25-remittance/routes/beneficiary-appeal-service.ts - M25 milestone 13a: the BENEFICIARY APPEAL record,
// keyed on the claim. An appeal the beneficiary (or their representative) filed and the hospice learned of or supports.
// ChartWarden RECORDS it: it computes no deadline (a due date is a recorded_deadline typed from a notice), files nothing, never
// auto-spawns a next tier, and never changes the hospice's own appeal_case or denial_case. Patient and provider entity come
// from the claim (never the request). A linked denial must be on the same claim, a linked appointment the same patient.
// Documents are validated (org, patient, admission, active version, not Part 2) before linking and the validated version id is
// persisted. Every transition is a conditional UPDATE (version and state in the WHERE).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type BeneficiaryAppealState,
  type BeneficiaryIntakeRefusal,
  type BeneficiaryOutcomeRefusal,
  MAX_BENEFICIARY_APPEAL_DOCUMENTS,
  type RepresentativeFlag,
  canTransitionBeneficiaryAppeal,
  checkBeneficiaryIntake,
  checkBeneficiaryOutcome,
  noticeDayOf,
  representativeFlag,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import {
  type LinkedDocumentPort,
  UNBOUND_LINKED_DOCUMENTS,
  validateLinkedDocument,
} from "./linked-document";
import { type RecordedDeadlineView, viewRecordedDeadline } from "./recorded-deadline-view";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Row = typeof schema.beneficiaryAppeal.$inferSelect;

export interface BeneficiaryAppealView {
  readonly id: string;
  readonly claimId: string;
  /** Top level so the read audit can attribute the read to the patient. */
  readonly patientId: string;
  readonly denialCaseId: string | null;
  readonly filerKind: string;
  readonly representativeAppointmentId: string | null;
  /** The linked appointment's status, ids and kind only (never the representative's name). */
  readonly appointment: {
    readonly id: string;
    readonly state: string;
    readonly status: string;
    readonly validThroughOn: string | null;
    readonly representativeKind: string;
  } | null;
  readonly representativeStatus: RepresentativeFlag | null;
  readonly tierLabel: string;
  readonly filedOn: string | null;
  readonly externalReference: string | null;
  readonly sourceNote: string;
  readonly state: string;
  readonly outcomeLabel: string | null;
  readonly outcomeNote: string | null;
  readonly closedAt: string | null;
  readonly version: number;
  readonly documents: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly attachedAt: string;
  }[];
  readonly deadlines: RecordedDeadlineView[];
}

export interface ClaimBeneficiaryAppeals {
  readonly claimId: string;
  readonly patientId: string;
  readonly items: BeneficiaryAppealView[];
}

export interface BeneficiaryIntakeBody {
  readonly filerKind: string;
  readonly tierLabel: string;
  readonly filedOn?: string | null;
  readonly externalReference?: string | null;
  readonly sourceNote: string;
  readonly denialCaseId?: string | null;
  readonly representativeAppointmentId?: string | null;
}
export type BeneficiaryPatchBody = Partial<BeneficiaryIntakeBody>;

export type BeneficiaryMove = "support" | "decide" | "close" | "withdraw";

export interface BeneficiaryAppealService {
  listForClaim(actor: M25ReadActor, claimId: string): Promise<ClaimBeneficiaryAppeals>;
  get(actor: M25ReadActor, id: string): Promise<BeneficiaryAppealView | null>;
  create(
    actor: M25WriteActor,
    claimId: string,
    input: BeneficiaryIntakeBody,
  ): Promise<{ id: string; version: number }>;
  update(
    actor: M25WriteActor,
    id: string,
    patch: BeneficiaryPatchBody,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  move(
    actor: M25WriteActor,
    id: string,
    move: BeneficiaryMove,
    input: { outcomeLabel?: string; outcomeNote?: string | null },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  attachDocument(
    actor: M25WriteActor,
    id: string,
    doc: { documentId: string; documentVersionId: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  detachDocument(
    actor: M25WriteActor,
    id: string,
    documentId: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface BeneficiaryAppealPorts {
  readonly claims?: ClaimFactsPort;
  readonly documents?: () => LinkedDocumentPort;
  readonly today?: () => string;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);
const conflict = (code: string, message: string) => new ChartWardenError(code, message, 409);
const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const INTAKE_MESSAGES: Readonly<Record<BeneficiaryIntakeRefusal, string>> = {
  FILER_INVALID: "the filer must be the beneficiary or their representative",
  TIER_INVALID: "pick the level the notice names, or 'other'",
  SOURCE_NOTE_REQUIRED: "say how the hospice learned of this appeal",
  DATE_INVALID: "the filed-on date is not a real date",
  DATE_IN_FUTURE: "the filed-on date cannot be in the future",
  APPOINTMENT_NEEDS_REPRESENTATIVE_FILER:
    "an appointment can be linked only when a representative filed",
  TEXT_TOO_LONG: "a text field is too long",
  MBI_IN_FREE_TEXT: "do not type a Medicare number into a text field",
};

const OUTCOME_MESSAGES: Readonly<Record<BeneficiaryOutcomeRefusal, string>> = {
  OUTCOME_REQUIRED: "record the outcome the notice states",
  OUTCOME_INVALID: "the outcome must be favorable, partial, unfavorable, dismissed or other",
  OUTCOME_NOTE_REQUIRED: "describe the outcome when it is 'other'",
  TEXT_TOO_LONG: "the note is too long",
  MBI_IN_FREE_TEXT: "do not type a Medicare number into a text field",
};

const MOVE_TARGET: Readonly<Record<BeneficiaryMove, BeneficiaryAppealState>> = {
  support: "supporting",
  decide: "decided",
  close: "closed",
  withdraw: "withdrawn",
};

export function buildDrizzleBeneficiaryAppealService(
  db: DbClient,
  ports: BeneficiaryAppealPorts = {},
): BeneficiaryAppealService {
  const claims = ports.claims ?? m23ClaimFactsPort;
  const documents = ports.documents ?? UNBOUND_LINKED_DOCUMENTS;
  const today = ports.today ?? (() => noticeDayOf(new Date()));
  const BA = schema.beneficiaryAppeal;
  const DOC = schema.beneficiaryAppealDocument;
  const EV = schema.beneficiaryAppealEvent;
  const RA = schema.representativeAppointment;
  const RD = schema.recordedDeadline;
  const DC = schema.denialCase;

  async function viewsOf(tx: Tx, rows: readonly Row[]): Promise<BeneficiaryAppealView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const now = today();
    const apptIds = [
      ...new Set(
        rows.flatMap((r) => (r.representativeAppointmentId ? [r.representativeAppointmentId] : [])),
      ),
    ];
    const appts =
      apptIds.length > 0 ? await tx.select().from(RA).where(inArray(RA.id, apptIds)) : [];
    const docs = await tx
      .select()
      .from(DOC)
      .where(and(inArray(DOC.beneficiaryAppealId, ids), isNull(DOC.removedAt)))
      .orderBy(asc(DOC.attachedAt));
    const deadlines = await tx
      .select()
      .from(RD)
      .where(inArray(RD.beneficiaryAppealId, ids))
      .orderBy(asc(RD.dueOn));
    const nowDate = new Date();
    return rows.map((r) => {
      const appt = appts.find((a) => a.id === r.representativeAppointmentId) ?? null;
      const apptState = appt ? { state: appt.state, validThroughOn: appt.validThroughOn } : null;
      const flag = representativeFlag({ filerKind: r.filerKind, appointment: apptState }, now);
      return {
        id: r.id,
        claimId: r.claimId,
        patientId: r.patientId,
        denialCaseId: r.denialCaseId,
        filerKind: r.filerKind,
        representativeAppointmentId: r.representativeAppointmentId,
        appointment: appt
          ? {
              id: appt.id,
              state: appt.state,
              status: flag ?? appt.state,
              validThroughOn: appt.validThroughOn,
              representativeKind: appt.representativeKind,
            }
          : null,
        representativeStatus: flag,
        tierLabel: r.tierLabel,
        filedOn: r.filedOn,
        externalReference: r.externalReference,
        sourceNote: r.sourceNote,
        state: r.state,
        outcomeLabel: r.outcomeLabel,
        outcomeNote: r.outcomeNote,
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
        version: r.version,
        documents: docs
          .filter((d) => d.beneficiaryAppealId === r.id)
          .map((d) => ({
            id: d.id,
            documentId: d.documentId,
            documentVersionId: d.documentVersionId,
            attachedAt: d.attachedAt.toISOString(),
          })),
        deadlines: deadlines
          .filter((d) => d.beneficiaryAppealId === r.id)
          .map((d) => viewRecordedDeadline(d, nowDate)),
      };
    });
  }

  async function claimOf(tx: Tx, actor: M25ReadActor, claimId: string) {
    const claim = await claims.byId(tx, claimId);
    const scope = actor.providerEntityScope;
    if (!claim || (scope !== undefined && !scope.includes(claim.providerEntityId))) {
      throw new NotFoundError("claim");
    }
    return claim;
  }

  async function loadAppeal(tx: Tx, actor: M25ReadActor, id: string): Promise<Row> {
    const scope = providerEntityScopeCondition(BA.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(BA)
      .where(scope ? and(eq(BA.id, id), scope) : eq(BA.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("beneficiary appeal");
    return rows[0];
  }

  /** A linked denial must be this actor's, in scope, and on the same claim; otherwise it reads as absent (404). */
  async function checkDenialLink(
    tx: Tx,
    actor: M25ReadActor,
    denialCaseId: string,
    claimId: string,
  ) {
    const scope = providerEntityScopeCondition(DC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select({ claimId: DC.claimId })
      .from(DC)
      .where(scope ? and(eq(DC.id, denialCaseId), scope) : eq(DC.id, denialCaseId))
      .limit(1);
    if (!rows[0] || rows[0].claimId !== claimId) throw new NotFoundError("denial case");
  }

  /** A linked appointment must be in scope (else 404) and the same patient (else 422). */
  async function checkAppointmentLink(
    tx: Tx,
    actor: M25ReadActor,
    appointmentId: string,
    patientId: string,
  ) {
    const scope = providerEntityScopeCondition(RA.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select({ patientId: RA.patientId, state: RA.state })
      .from(RA)
      .where(scope ? and(eq(RA.id, appointmentId), scope) : eq(RA.id, appointmentId))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("representative appointment");
    if (rows[0].patientId !== patientId) {
      throw unprocessable(
        "APPOINTMENT_PATIENT_MISMATCH",
        "that appointment belongs to a different patient than this claim's",
      );
    }
    if (rows[0].state !== "active") {
      throw unprocessable(
        "APPOINTMENT_NOT_ACTIVE",
        "only an active appointment can be linked; a second person activates it first",
      );
    }
  }

  const event = (
    tx: Tx,
    actor: M25WriteActor,
    id: string,
    eventKind: string,
    eventPayload?: Record<string, unknown>,
  ) =>
    tx.insert(EV).values({
      organizationId: actor.organizationId,
      beneficiaryAppealId: id,
      eventKind,
      eventPayload: eventPayload ?? null,
      actorMembershipId: actor.membershipId,
    });

  async function bump(
    tx: Tx,
    cur: Row,
    ifMatch: number,
    set: Partial<typeof BA.$inferInsert>,
  ): Promise<{ id: string; version: number }> {
    const updated = await tx
      .update(BA)
      .set({ ...set, version: sql`${BA.version} + 1`, updatedAt: new Date() })
      .where(and(eq(BA.id, cur.id), eq(BA.version, ifMatch), eq(BA.state, cur.state)))
      .returning({ id: BA.id, version: BA.version });
    if (!updated[0]) throw new VersionConflictError(cur.version);
    return updated[0];
  }

  const requireLive = (cur: Row) => {
    if (cur.state === "closed" || cur.state === "withdrawn") {
      throw conflict(
        "BENEFICIARY_APPEAL_TERMINAL",
        `a ${cur.state} beneficiary appeal cannot change`,
      );
    }
  };

  return {
    async listForClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await claimOf(tx, actor, claimId);
        const scope = providerEntityScopeCondition(BA.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(BA)
          .where(scope ? and(eq(BA.claimId, claimId), scope) : eq(BA.claimId, claimId))
          .orderBy(desc(BA.createdAt))
          .limit(200);
        return { claimId, patientId: claim.patientId, items: await viewsOf(tx, rows) };
      });
    },

    async get(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(BA.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(BA)
          .where(scope ? and(eq(BA.id, id), scope) : eq(BA.id, id))
          .limit(1);
        if (!rows[0]) return null;
        return (await viewsOf(tx, rows))[0] ?? null;
      });
    },

    async create(actor, claimId, input) {
      const normalized = {
        filerKind: input.filerKind,
        tierLabel: input.tierLabel,
        filedOn: input.filedOn ?? null,
        externalReference: clean(input.externalReference),
        sourceNote: input.sourceNote,
        hasAppointment: Boolean(input.representativeAppointmentId),
      };
      const refusal = checkBeneficiaryIntake(normalized, today());
      if (refusal) throw unprocessable(`BENEFICIARY_${refusal}`, INTAKE_MESSAGES[refusal]);
      return withOrgContext(db, actor, async (tx) => {
        const claim = await claimOf(tx, actor, claimId);
        if (input.denialCaseId) await checkDenialLink(tx, actor, input.denialCaseId, claimId);
        if (input.representativeAppointmentId) {
          await checkAppointmentLink(tx, actor, input.representativeAppointmentId, claim.patientId);
        }
        const inserted = await tx
          .insert(BA)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            claimId,
            patientId: claim.patientId,
            denialCaseId: input.denialCaseId ?? null,
            filerKind: normalized.filerKind,
            representativeAppointmentId: input.representativeAppointmentId ?? null,
            tierLabel: normalized.tierLabel,
            filedOn: normalized.filedOn,
            externalReference: normalized.externalReference,
            sourceNote: normalized.sourceNote.trim(),
            state: "recorded",
            createdByMembershipId: actor.membershipId,
          })
          .returning({ id: BA.id, version: BA.version });
        const id = inserted[0]!.id;
        await event(tx, actor, id, "recorded", {
          filerKind: normalized.filerKind,
          appointmentLinked: normalized.hasAppointment,
        });
        return inserted[0]!;
      });
    },

    async update(actor, id, patch, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppeal(tx, actor, id);
        requireLive(cur);
        const appointmentId =
          patch.representativeAppointmentId !== undefined
            ? patch.representativeAppointmentId
            : cur.representativeAppointmentId;
        const denialId = patch.denialCaseId !== undefined ? patch.denialCaseId : cur.denialCaseId;
        const merged = {
          filerKind: patch.filerKind ?? cur.filerKind,
          tierLabel: patch.tierLabel ?? cur.tierLabel,
          filedOn: patch.filedOn !== undefined ? patch.filedOn : cur.filedOn,
          externalReference:
            patch.externalReference !== undefined
              ? clean(patch.externalReference)
              : cur.externalReference,
          sourceNote: patch.sourceNote ?? cur.sourceNote,
          hasAppointment: Boolean(appointmentId),
        };
        const refusal = checkBeneficiaryIntake(merged, today());
        if (refusal) throw unprocessable(`BENEFICIARY_${refusal}`, INTAKE_MESSAGES[refusal]);
        if (denialId && denialId !== cur.denialCaseId) {
          await checkDenialLink(tx, actor, denialId, cur.claimId);
        }
        if (appointmentId && appointmentId !== cur.representativeAppointmentId) {
          await checkAppointmentLink(tx, actor, appointmentId, cur.patientId);
        }
        const result = await bump(tx, cur, ifMatch, {
          filerKind: merged.filerKind,
          tierLabel: merged.tierLabel,
          filedOn: merged.filedOn,
          externalReference: merged.externalReference,
          sourceNote: merged.sourceNote.trim(),
          denialCaseId: denialId ?? null,
          representativeAppointmentId: appointmentId ?? null,
        });
        await event(tx, actor, id, "updated", { appointmentLinked: Boolean(appointmentId) });
        return result;
      });
    },

    async move(actor, id, move, input, ifMatch) {
      const to = MOVE_TARGET[move];
      if (move === "decide") {
        const refusal = checkBeneficiaryOutcome(input);
        if (refusal) throw unprocessable(`BENEFICIARY_${refusal}`, OUTCOME_MESSAGES[refusal]);
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppeal(tx, actor, id);
        if (!canTransitionBeneficiaryAppeal(cur.state as BeneficiaryAppealState, to)) {
          throw conflict("INVALID_STATE", `a ${cur.state} beneficiary appeal cannot move to ${to}`);
        }
        const now = new Date();
        const result = await bump(tx, cur, ifMatch, {
          state: to,
          ...(move === "decide"
            ? { outcomeLabel: input.outcomeLabel as string, outcomeNote: clean(input.outcomeNote) }
            : {}),
          ...(move === "close" || move === "withdraw" ? { closedAt: now } : {}),
        });
        await event(
          tx,
          actor,
          id,
          to,
          move === "decide" ? { outcomeLabel: input.outcomeLabel } : undefined,
        );
        return result;
      });
    },

    async attachDocument(actor, id, doc, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppeal(tx, actor, id);
        requireLive(cur);
        const claim = await claimOf(tx, actor, cur.claimId);
        const live = await tx
          .select({ documentId: DOC.documentId })
          .from(DOC)
          .where(and(eq(DOC.beneficiaryAppealId, id), isNull(DOC.removedAt)));
        if (live.length >= MAX_BENEFICIARY_APPEAL_DOCUMENTS) {
          throw unprocessable(
            "BENEFICIARY_TOO_MANY_DOCUMENTS",
            `a beneficiary appeal carries at most ${MAX_BENEFICIARY_APPEAL_DOCUMENTS} documents`,
          );
        }
        if (live.some((d) => d.documentId === doc.documentId)) {
          throw conflict("BENEFICIARY_DUPLICATE_DOCUMENT", "that document is already attached");
        }
        const valid = await validateLinkedDocument(
          documents(),
          actor.organizationId,
          { patientId: cur.patientId, admissionId: claim.admissionId ?? null },
          doc,
          "beneficiary appeal",
        );
        const result = await bump(tx, cur, ifMatch, {});
        try {
          await tx.insert(DOC).values({
            organizationId: actor.organizationId,
            beneficiaryAppealId: id,
            documentId: valid.documentId,
            documentVersionId: valid.documentVersionId,
            attachedByMembershipId: actor.membershipId,
          });
        } catch (e) {
          // Two attaches of one document racing past the pre-check meet the live-unique index; the transaction rolls back.
          if (isUniqueViolation(e)) {
            throw conflict("BENEFICIARY_DUPLICATE_DOCUMENT", "that document is already attached");
          }
          throw e;
        }
        await event(tx, actor, id, "document_attached", { documentId: valid.documentId });
        return result;
      });
    },

    async detachDocument(actor, id, documentId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppeal(tx, actor, id);
        requireLive(cur);
        const removed = await tx
          .update(DOC)
          .set({ removedAt: new Date() })
          .where(
            and(
              eq(DOC.beneficiaryAppealId, id),
              eq(DOC.documentId, documentId),
              isNull(DOC.removedAt),
            ),
          )
          .returning({ id: DOC.id });
        if (!removed[0]) throw new NotFoundError("attached document");
        const result = await bump(tx, cur, ifMatch, {});
        await event(tx, actor, id, "document_removed", { documentId });
        return result;
      });
    },
  };
}
