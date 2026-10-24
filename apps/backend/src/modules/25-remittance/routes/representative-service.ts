// apps/backend/src/modules/25-remittance/routes/representative-service.ts - M25 milestone 13a: the organization's APPOINTMENT
// FORM VERSIONS and the APPOINTMENT OF REPRESENTATIVE record. RECORD-KEEPING ONLY, nothing seeded:
//
//   - A form version is the organization's own data (label, identifier and edition AS ENTERED, a source note, the required-element
//     labels). With none configured the intake says so. Edit = retire and add a new one.
//   - An appointment is patient-level but ALWAYS recorded from a claim: the patient and provider entity are resolved from the claim
//     server-side and never taken from the request. It is born a draft; a SECOND person with step-up activates it. The
//     author != activator rule, the signed-document requirement and the element checklist are enforced by the database trigger
//     atomically with the UPDATE (the checks here only give a friendly error first). Revocation is never blocked by a second person.
//   - The signed copy is an M22 document: validated (org, patient, active version, not Part 2) before it is linked, and the
//     validated version id is persisted. Activation validates it again.
//   - Every date is typed; the validity end is a typed date with a source note and is never computed. The status shown on
//     read is derived from typed dates only (a passed end reads "validity end passed (as recorded)" and changes nothing).
//   - An appointment writes no portal, consent or caregiver row, and no appeal_case / denial_case state.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type ActivationRefusal,
  type AppointmentDraftRefusal,
  type AppointmentStatus,
  type ElementStatus,
  type FormVersionRefusal,
  type RevocationRefusal,
  appointmentStatus,
  checkActivation,
  checkAppointmentDraft,
  checkFormVersionInput,
  checkRevocation,
  confirmElements,
  noticeDayOf,
  snapshotElements,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import {
  type LinkedDocumentPort,
  UNBOUND_LINKED_DOCUMENTS,
  validateLinkedDocument,
} from "./linked-document";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type AppointmentRow = typeof schema.representativeAppointment.$inferSelect;
type FormRow = typeof schema.representativeFormVersion.$inferSelect;

export interface FormVersionView {
  readonly id: string;
  readonly label: string;
  readonly formIdentifier: string | null;
  readonly editionText: string | null;
  readonly sourceNote: string;
  readonly verifiedOn: string | null;
  readonly verifiedByMembershipId: string | null;
  readonly requiredElements: readonly string[];
  readonly retiredAt: string | null;
  readonly version: number;
}

export interface FormVersionInputBody {
  readonly label: string;
  readonly formIdentifier?: string | null;
  readonly editionText?: string | null;
  readonly sourceNote: string;
  readonly verifiedOn?: string | null;
  readonly requiredElements: readonly string[];
}

export interface AppointmentView {
  readonly id: string;
  /** Top level so the read audit can attribute the read to the patient. */
  readonly patientId: string;
  readonly recordedFromClaimId: string;
  readonly instrumentKind: string;
  readonly formVersionId: string | null;
  readonly formLabel: string | null;
  readonly instrumentNote: string | null;
  readonly representativeName: string;
  readonly relationshipLabel: string | null;
  readonly representativeKind: string;
  readonly beneficiarySignedOn: string | null;
  readonly representativeSignedOn: string | null;
  /** Typed; null = "Validity end not recorded". Never computed. */
  readonly validThroughOn: string | null;
  readonly validitySourceNote: string | null;
  readonly elements: readonly ElementStatus[];
  readonly documentId: string | null;
  readonly documentVersionId: string | null;
  readonly state: string;
  /** Derived on read from typed dates only. */
  readonly status: AppointmentStatus;
  readonly recordedByMembershipId: string;
  readonly verifiedByMembershipId: string | null;
  readonly verifiedAt: string | null;
  readonly revokedOn: string | null;
  readonly revocationNote: string | null;
  readonly version: number;
}

export interface ClaimAppointments {
  readonly claimId: string;
  readonly patientId: string;
  readonly items: AppointmentView[];
}

export interface AppointmentDraftBody {
  readonly instrumentKind: string;
  readonly formVersionId?: string | null;
  readonly instrumentNote?: string | null;
  readonly representativeName: string;
  readonly relationshipLabel?: string | null;
  readonly representativeKind: string;
  readonly beneficiarySignedOn?: string | null;
  readonly representativeSignedOn?: string | null;
  readonly validThroughOn?: string | null;
  readonly validitySourceNote?: string | null;
}

/** An edit of a draft: undefined keeps the stored value, null clears it. The instrument and form version never change. */
export type AppointmentPatchBody = Partial<
  Omit<AppointmentDraftBody, "instrumentKind" | "formVersionId">
>;

export interface RepresentativeService {
  listFormVersions(actor: M25ReadActor): Promise<{ items: FormVersionView[] }>;
  createFormVersion(
    actor: M25WriteActor,
    input: FormVersionInputBody,
  ): Promise<{ id: string; version: number }>;
  retireFormVersion(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  listForClaim(actor: M25ReadActor, claimId: string): Promise<ClaimAppointments>;
  getAppointment(actor: M25ReadActor, id: string): Promise<AppointmentView | null>;
  createDraft(
    actor: M25WriteActor,
    claimId: string,
    input: AppointmentDraftBody,
  ): Promise<{ id: string; version: number }>;
  updateDraft(
    actor: M25WriteActor,
    id: string,
    patch: AppointmentPatchBody,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  attachDocument(
    actor: M25WriteActor,
    id: string,
    doc: { documentId: string; documentVersionId: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  confirmElements(
    actor: M25WriteActor,
    id: string,
    confirmedLabels: readonly string[],
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  activate(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number; validityEndPassed: boolean }>;
  revoke(
    actor: M25WriteActor,
    id: string,
    input: { revokedOn: string; note: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface RepresentativePorts {
  readonly claims?: ClaimFactsPort;
  readonly documents?: () => LinkedDocumentPort;
  /** Overridable clock (UTC day), for tests. */
  readonly today?: () => string;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);
const conflict = (code: string, message: string) => new ChartWardenError(code, message, 409);
const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

const DRAFT_MESSAGES: Readonly<Record<AppointmentDraftRefusal, string>> = {
  INSTRUMENT_INVALID:
    "the instrument must be an organization form version or another written instrument",
  FORM_VERSION_REQUIRED: "pick the organization's form version this appointment was made on",
  FORM_VERSION_NOT_ALLOWED: "another written instrument has no form version",
  INSTRUMENT_NOTE_REQUIRED: "describe the other written instrument",
  NAME_REQUIRED: "enter the representative's name",
  KIND_INVALID:
    "the representative kind must be family_or_friend, legal_representative, attorney or other",
  LABEL_REQUIRED_FOR_OTHER: "describe the relationship when the kind is 'other'",
  DATE_INVALID: "a signature date is not a real date",
  DATE_IN_FUTURE: "a signature date cannot be in the future",
  VALIDITY_PAIR_REQUIRED: "record the validity end together with where it came from, or neither",
  VALIDITY_DATE_INVALID: "the validity end is not a real date",
  TEXT_TOO_LONG: "a text field is too long",
  MBI_IN_FREE_TEXT:
    "do not type a Medicare number into a text field; it stays on the signed document",
};

const FORM_MESSAGES: Readonly<Record<FormVersionRefusal, string>> = {
  LABEL_REQUIRED: "name this form version",
  SOURCE_NOTE_REQUIRED: "say where this form version came from (the compliance source)",
  VERIFIED_ON_INVALID: "the verified-on date must be a real date, not in the future",
  ELEMENTS_TOO_MANY: "the form version lists too many elements",
  ELEMENT_BLANK: "an element label is blank",
  ELEMENT_DUPLICATE: "an element label is listed twice",
  TEXT_TOO_LONG: "a text field is too long",
  MBI_IN_FREE_TEXT: "do not type a Medicare number into a text field",
};

const ACTIVATION_MESSAGES: Readonly<Record<ActivationRefusal, string>> = {
  NOT_DRAFT: "only a draft appointment can be activated",
  ACTIVATOR_IS_RECORDER:
    "an appointment is activated by someone other than the person who recorded it",
  ACTIVATOR_IS_EDITOR:
    "an appointment is activated by someone other than the person who last edited it",
  NO_DOCUMENT: "attach the signed appointment document before activating",
  ELEMENTS_INCOMPLETE: "confirm every required element before activating",
};

const REVOCATION_MESSAGES: Readonly<Record<RevocationRefusal, string>> = {
  NOT_REVOCABLE: "only a draft or an active appointment can be revoked",
  REVOKED_ON_INVALID: "the revocation date must be a real date, not in the future",
  NOTE_REQUIRED: "say how the revocation was received",
  TEXT_TOO_LONG: "the note is too long",
  MBI_IN_FREE_TEXT: "do not type a Medicare number into a text field",
};

/** A `M25_REP_*` exception raised by the appointment trigger (a race the pre-checks could not see), as a 409. */
function databaseRefusal(e: unknown): ChartWardenError | null {
  const message =
    (e as { cause?: { message?: string }; message?: string }).cause?.message ??
    (e as Error).message ??
    "";
  const m = /M25_REP_([A-Z_]+): (.*)/.exec(message);
  return m ? conflict(`APPOINTMENT_${m[1]}`, m[2] ?? "the appointment cannot be activated") : null;
}

export function elementsOf(value: unknown): ElementStatus[] {
  return Array.isArray(value)
    ? (value as ElementStatus[]).map((e) => ({ label: e.label, state: e.state }))
    : [];
}

export function buildDrizzleRepresentativeService(
  db: DbClient,
  ports: RepresentativePorts = {},
): RepresentativeService {
  const claims = ports.claims ?? m23ClaimFactsPort;
  const documents = ports.documents ?? UNBOUND_LINKED_DOCUMENTS;
  const today = ports.today ?? (() => noticeDayOf(new Date()));
  const RA = schema.representativeAppointment;
  const FV = schema.representativeFormVersion;

  const formView = (r: FormRow): FormVersionView => ({
    id: r.id,
    label: r.label,
    formIdentifier: r.formIdentifier,
    editionText: r.editionText,
    sourceNote: r.sourceNote,
    verifiedOn: r.verifiedOn,
    verifiedByMembershipId: r.verifiedByMembershipId,
    requiredElements: Array.isArray(r.requiredElements) ? (r.requiredElements as string[]) : [],
    retiredAt: r.retiredAt ? r.retiredAt.toISOString() : null,
    version: r.version,
  });

  const appointmentView = (
    r: AppointmentRow,
    formLabel: string | null,
    now: string,
  ): AppointmentView => ({
    id: r.id,
    patientId: r.patientId,
    recordedFromClaimId: r.recordedFromClaimId,
    instrumentKind: r.instrumentKind,
    formVersionId: r.formVersionId,
    formLabel,
    instrumentNote: r.instrumentNote,
    representativeName: r.representativeName,
    relationshipLabel: r.relationshipLabel,
    representativeKind: r.representativeKind,
    beneficiarySignedOn: r.beneficiarySignedOn,
    representativeSignedOn: r.representativeSignedOn,
    validThroughOn: r.validThroughOn,
    validitySourceNote: r.validitySourceNote,
    elements: elementsOf(r.elementsConfirmed),
    documentId: r.documentId,
    documentVersionId: r.documentVersionId,
    state: r.state,
    status: appointmentStatus(r, now),
    recordedByMembershipId: r.recordedByMembershipId,
    verifiedByMembershipId: r.verifiedByMembershipId,
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    revokedOn: r.revokedOn,
    revocationNote: r.revocationNote,
    version: r.version,
  });

  async function formLabels(tx: Tx, rows: readonly AppointmentRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.formVersionId ? [r.formVersionId] : [])))];
    if (ids.length === 0) return new Map();
    const forms = await tx
      .select({ id: FV.id, label: FV.label })
      .from(FV)
      .where(inArray(FV.id, ids));
    return new Map(forms.map((f) => [f.id, f.label]));
  }

  async function loadAppointment(tx: Tx, actor: M25ReadActor, id: string): Promise<AppointmentRow> {
    const scope = providerEntityScopeCondition(RA.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(RA)
      .where(scope ? and(eq(RA.id, id), scope) : eq(RA.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("representative appointment");
    return rows[0];
  }

  async function claimOf(tx: Tx, actor: M25ReadActor, claimId: string) {
    const claim = await claims.byId(tx, claimId);
    const scope = actor.providerEntityScope;
    if (!claim || (scope !== undefined && !scope.includes(claim.providerEntityId))) {
      throw new NotFoundError("claim");
    }
    return claim;
  }

  const draftInputOf = (r: AppointmentRow, patch: AppointmentPatchBody) => ({
    instrumentKind: r.instrumentKind,
    formVersionId: r.formVersionId,
    instrumentNote:
      patch.instrumentNote !== undefined ? clean(patch.instrumentNote) : r.instrumentNote,
    representativeName: patch.representativeName ?? r.representativeName,
    relationshipLabel:
      patch.relationshipLabel !== undefined ? clean(patch.relationshipLabel) : r.relationshipLabel,
    representativeKind: patch.representativeKind ?? r.representativeKind,
    beneficiarySignedOn:
      patch.beneficiarySignedOn !== undefined ? patch.beneficiarySignedOn : r.beneficiarySignedOn,
    representativeSignedOn:
      patch.representativeSignedOn !== undefined
        ? patch.representativeSignedOn
        : r.representativeSignedOn,
    validThroughOn: patch.validThroughOn !== undefined ? patch.validThroughOn : r.validThroughOn,
    validitySourceNote:
      patch.validitySourceNote !== undefined
        ? clean(patch.validitySourceNote)
        : r.validitySourceNote,
  });

  /** One conditional UPDATE: the version and the expected state are in the statement itself. */
  async function bump(
    tx: Tx,
    cur: AppointmentRow,
    ifMatch: number,
    states: readonly string[],
    set: Partial<typeof RA.$inferInsert>,
  ): Promise<{ id: string; version: number }> {
    const updated = await tx
      .update(RA)
      .set({ ...set, version: sql`${RA.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(RA.id, cur.id),
          eq(RA.version, ifMatch),
          sql`${RA.state} in (${sql.join(
            states.map((s) => sql`${s}`),
            sql`, `,
          )})`,
        ),
      )
      .returning({ id: RA.id, version: RA.version });
    if (!updated[0]) throw new VersionConflictError(cur.version);
    return updated[0];
  }

  const requireDraft = (cur: AppointmentRow) => {
    if (cur.state !== "draft") {
      throw conflict("APPOINTMENT_NOT_DRAFT", "only a draft appointment can be edited");
    }
  };

  return {
    async listFormVersions(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(FV).orderBy(desc(FV.createdAt)).limit(200);
        return { items: rows.map(formView) };
      });
    },

    async createFormVersion(actor, input) {
      const normalized = {
        label: input.label,
        formIdentifier: clean(input.formIdentifier),
        editionText: clean(input.editionText),
        sourceNote: input.sourceNote,
        verifiedOn: input.verifiedOn ?? null,
        requiredElements: input.requiredElements,
      };
      const refusal = checkFormVersionInput(normalized, today());
      if (refusal) throw unprocessable(`FORM_${refusal}`, FORM_MESSAGES[refusal]);
      return withOrgContext(db, actor, async (tx) => {
        const inserted = await tx
          .insert(FV)
          .values({
            organizationId: actor.organizationId,
            label: normalized.label.trim(),
            formIdentifier: normalized.formIdentifier,
            editionText: normalized.editionText,
            sourceNote: normalized.sourceNote.trim(),
            verifiedOn: normalized.verifiedOn,
            verifiedByMembershipId: normalized.verifiedOn ? actor.membershipId : null,
            requiredElements: normalized.requiredElements.map((e) => e.trim()),
            createdByMembershipId: actor.membershipId,
          })
          .returning({ id: FV.id, version: FV.version });
        return inserted[0]!;
      });
    },

    async retireFormVersion(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = (await tx.select().from(FV).where(eq(FV.id, id)).limit(1))[0];
        if (!cur) throw new NotFoundError("representative form version");
        if (cur.retiredAt) throw conflict("FORM_RETIRED", "this form version is already retired");
        const updated = await tx
          .update(FV)
          .set({ retiredAt: new Date(), version: sql`${FV.version} + 1`, updatedAt: new Date() })
          .where(and(eq(FV.id, id), eq(FV.version, ifMatch), sql`${FV.retiredAt} is null`))
          .returning({ id: FV.id, version: FV.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        return updated[0];
      });
    },

    async listForClaim(actor, claimId) {
      return withOrgContext(db, actor, async (tx) => {
        const claim = await claimOf(tx, actor, claimId);
        const scope = providerEntityScopeCondition(RA.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(RA)
          .where(
            scope
              ? and(eq(RA.patientId, claim.patientId), scope)
              : eq(RA.patientId, claim.patientId),
          )
          .orderBy(desc(RA.createdAt))
          .limit(200);
        const labels = await formLabels(tx, rows);
        const now = today();
        return {
          claimId,
          patientId: claim.patientId,
          items: rows.map((r) =>
            appointmentView(r, r.formVersionId ? (labels.get(r.formVersionId) ?? null) : null, now),
          ),
        };
      });
    },

    async getAppointment(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(RA.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(RA)
          .where(scope ? and(eq(RA.id, id), scope) : eq(RA.id, id))
          .limit(1);
        if (!rows[0]) return null;
        const labels = await formLabels(tx, rows);
        return appointmentView(
          rows[0],
          rows[0].formVersionId ? (labels.get(rows[0].formVersionId) ?? null) : null,
          today(),
        );
      });
    },

    async createDraft(actor, claimId, input) {
      const normalized = {
        instrumentKind: input.instrumentKind,
        formVersionId: input.formVersionId ?? null,
        instrumentNote: clean(input.instrumentNote),
        representativeName: input.representativeName,
        relationshipLabel: clean(input.relationshipLabel),
        representativeKind: input.representativeKind,
        beneficiarySignedOn: input.beneficiarySignedOn ?? null,
        representativeSignedOn: input.representativeSignedOn ?? null,
        validThroughOn: input.validThroughOn ?? null,
        validitySourceNote: clean(input.validitySourceNote),
      };
      const refusal = checkAppointmentDraft(normalized, today());
      if (refusal) throw unprocessable(`APPOINTMENT_${refusal}`, DRAFT_MESSAGES[refusal]);
      return withOrgContext(db, actor, async (tx) => {
        const claim = await claimOf(tx, actor, claimId);
        let elements: ElementStatus[] = [];
        if (normalized.formVersionId) {
          const form = (
            await tx.select().from(FV).where(eq(FV.id, normalized.formVersionId)).limit(1)
          )[0];
          if (!form || form.retiredAt) {
            throw unprocessable(
              "FORM_VERSION_UNAVAILABLE",
              "that form version is not available; pick one of the organization's current versions",
            );
          }
          elements = snapshotElements(formView(form).requiredElements);
        }
        const inserted = await tx
          .insert(RA)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            patientId: claim.patientId,
            recordedFromClaimId: claimId,
            instrumentKind: normalized.instrumentKind,
            formVersionId: normalized.formVersionId,
            instrumentNote: normalized.instrumentNote,
            representativeName: normalized.representativeName.trim(),
            relationshipLabel: normalized.relationshipLabel,
            representativeKind: normalized.representativeKind,
            beneficiarySignedOn: normalized.beneficiarySignedOn,
            representativeSignedOn: normalized.representativeSignedOn,
            validThroughOn: normalized.validThroughOn,
            validitySourceNote: normalized.validitySourceNote,
            elementsConfirmed: elements,
            state: "draft",
            recordedByMembershipId: actor.membershipId,
            lastEditedByMembershipId: actor.membershipId,
          })
          .returning({ id: RA.id, version: RA.version });
        return inserted[0]!;
      });
    },

    async updateDraft(actor, id, patch, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppointment(tx, actor, id);
        requireDraft(cur);
        const merged = draftInputOf(cur, patch);
        const refusal = checkAppointmentDraft(merged, today());
        if (refusal) throw unprocessable(`APPOINTMENT_${refusal}`, DRAFT_MESSAGES[refusal]);
        return bump(tx, cur, ifMatch, ["draft"], {
          lastEditedByMembershipId: actor.membershipId,
          representativeName: merged.representativeName.trim(),
          relationshipLabel: merged.relationshipLabel,
          representativeKind: merged.representativeKind,
          instrumentNote: merged.instrumentNote,
          beneficiarySignedOn: merged.beneficiarySignedOn,
          representativeSignedOn: merged.representativeSignedOn,
          validThroughOn: merged.validThroughOn,
          validitySourceNote: merged.validitySourceNote,
        });
      });
    },

    async attachDocument(actor, id, doc, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppointment(tx, actor, id);
        requireDraft(cur);
        const valid = await validateLinkedDocument(
          documents(),
          actor.organizationId,
          { patientId: cur.patientId },
          doc,
          "appointment of representative",
        );
        return bump(tx, cur, ifMatch, ["draft"], {
          lastEditedByMembershipId: actor.membershipId,
          documentId: valid.documentId,
          documentVersionId: valid.documentVersionId,
        });
      });
    },

    async confirmElements(actor, id, confirmedLabels, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppointment(tx, actor, id);
        requireDraft(cur);
        const result = confirmElements(elementsOf(cur.elementsConfirmed), confirmedLabels);
        if (!result.ok) {
          throw unprocessable(
            "ELEMENT_UNKNOWN",
            "that element is not on this appointment's checklist",
          );
        }
        return bump(tx, cur, ifMatch, ["draft"], {
          lastEditedByMembershipId: actor.membershipId,
          elementsConfirmed: result.elements,
        });
      });
    },

    async activate(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppointment(tx, actor, id);
        const refusal = checkActivation({
          state: cur.state,
          recordedBy: cur.recordedByMembershipId,
          lastEditedBy: cur.lastEditedByMembershipId,
          activator: actor.membershipId,
          hasDocument: cur.documentId !== null && cur.documentVersionId !== null,
          elements: elementsOf(cur.elementsConfirmed),
        });
        if (refusal) throw conflict(`APPOINTMENT_${refusal}`, ACTIVATION_MESSAGES[refusal]);
        // The signed copy must still be the document's active version and still attachable (it may have changed since).
        await validateLinkedDocument(
          documents(),
          actor.organizationId,
          { patientId: cur.patientId },
          {
            documentId: cur.documentId as string,
            documentVersionId: cur.documentVersionId as string,
          },
          "appointment of representative",
        );
        // One conditional UPDATE; the trigger re-decides recorder != activator, membership, document and elements under the row lock.
        try {
          const done = await bump(tx, cur, ifMatch, ["draft"], {
            state: "active",
            verifiedByMembershipId: actor.membershipId,
            verifiedAt: new Date(),
          });
          // A warning, not a block: the typed validity end had already passed when this was activated.
          return {
            ...done,
            validityEndPassed: cur.validThroughOn !== null && cur.validThroughOn < today(),
          };
        } catch (e) {
          throw databaseRefusal(e) ?? e;
        }
      });
    },

    async revoke(actor, id, input, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadAppointment(tx, actor, id);
        const refusal = checkRevocation({ state: cur.state, ...input }, today());
        if (refusal) throw unprocessable(`APPOINTMENT_${refusal}`, REVOCATION_MESSAGES[refusal]);
        return bump(tx, cur, ifMatch, ["draft", "active"], {
          state: "revoked",
          revokedOn: input.revokedOn,
          revokedByMembershipId: actor.membershipId,
          revocationNote: input.note.trim(),
        });
      });
    },
  };
}
