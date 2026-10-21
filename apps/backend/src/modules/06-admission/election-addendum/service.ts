// apps/backend/src/modules/06-admission/election-addendum/service.ts — the FY2027 election statement addendum
// service (42 CFR 418.24(b)(6), (c), (d) as amended by CMS-1851-F). The route operations (draft, edit, furnish,
// acknowledge) and the ONE generic plan-of-care-change entry point, {@link ElectionAddendumService.openAddendumUpdateWindow},
// that every relatedness-change consumer calls (M7 problems / care-plan versions today; M12 medications and M21
// DME tomorrow) — so the 3-day (d)(2) rule lives in exactly one place.
//
// Source reads (non-covered determinations, diagnoses, patient identity) happen BEFORE the write transaction:
// they cross module boundaries through injected readers that open their own org-scoped reads.
import { audit } from "@wardenx/audit";
import { type DbClient, organizationTimezone, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type AddendumDiagnosesReader,
  type ElectionAddendumAcknowledgementSource,
  type ElectionAddendumContentSource,
  type ElectionAddendumExemptionReason,
  type ElectionAddendumFurnishMethod,
  type ElectionAddendumSignerKind,
  type NonCoveredItemsReader,
  ChartWardenError,
} from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import type { AdmissionEvidenceDocumentValidator } from "../admission-evidence-service";
import { ResourceNotFoundError } from "../routes/service";
import {
  type AddendumContentFacts,
  type ElectionAddendumEvent,
  addendumContentGaps,
  planUploadedAcknowledgement,
  transitionElectionAddendum,
} from "../state-machines/election-addendum";
import { AdmissionStateError } from "../state-machines/errors";
import type { AddendumOutboxPort as AdmissionWriteOutboxPort } from "./outbox-port";
import { type ScannedCopyRef, buildAddendumRenderPayload } from "./render-payload";
import {
  ADDENDUM_WINDOW_KINDS,
  type AddendumAdmissionFacts,
  type AddendumItem,
  type AddendumPrefill,
  type AddendumRow,
  EMPTY_PREFILL,
  carrySourceReasons,
  closeAddendumWindows,
  createUpdateVersionInTx,
  listAddendumVersions,
  loadAddendum,
  loadAddendumAdmissionFacts,
  openAddendumWindows,
  openInitialAddendumInTx,
  refreshDraftInTx,
  sourceItemsDiffer,
  supersedePriorVersionsInTx,
} from "./store";

const EA = schema.electionAddenda;

/** The cross-module sources an addendum is pre-filled from. Each is optional: an unbound source leaves the
 *  matching content for the clinician to enter. */
export interface ElectionAddendumSources {
  readonly nonCoveredItems?: NonCoveredItemsReader;
  readonly diagnoses?: AddendumDiagnosesReader;
  /** M5 identity: the name and hospice medical record number the addendum prints ((c)(3)). */
  readonly patientIdentity?: (
    organizationId: string,
    patientId: string,
  ) => Promise<{ readonly name: string; readonly mrn: string } | null>;
}

export interface ElectionAddendumServiceDeps {
  readonly db: DbClient;
  readonly outbox: AdmissionWriteOutboxPort;
  readonly sources?: ElectionAddendumSources;
  /** M22 document-version check for a scanned signed paper copy (same org / patient / admission, ACTIVE
   *  version). Unbound, the uploaded-acknowledgement path refuses with 503. */
  readonly documentValidator?: AdmissionEvidenceDocumentValidator;
  readonly now?: () => Date;
}

/** A scanned signed (or refused) paper copy of the addendum, already uploaded to M22. */
export type UploadedAcknowledgementInput = {
  readonly documentId: string;
  readonly documentVersionId: string;
  /** When the paper was handed over — required when the version was never furnished in WardenX. */
  readonly furnishedAt?: string;
} & (
  | {
      readonly outcome: "signed";
      readonly signerKind: ElectionAddendumSignerKind;
      readonly representativeName?: string | null;
      readonly representativeRelationship?: string | null;
      readonly signedAt: string;
    }
  | { readonly outcome: "refused"; readonly reason: string; readonly refusedAt?: string }
);

/** One addendum version as the API returns it. */
export interface ElectionAddendumView {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly electionStatementId: string | null;
  readonly versionNumber: number;
  readonly trigger: AddendumRow["trigger"];
  readonly triggerCause: string | null;
  readonly triggeredAt: string;
  readonly status: AddendumRow["status"];
  readonly hospiceName: string | null;
  readonly patientName: string | null;
  readonly medicalRecordNumber: string | null;
  readonly terminalDiagnosis: AddendumRow["terminalDiagnosis"];
  readonly relatedDiagnoses: AddendumRow["relatedDiagnoses"];
  readonly items: AddendumRow["items"];
  readonly noNonCoveredItems: boolean;
  readonly clinicalExplanation: string | null;
  readonly guidelineReferences: string | null;
  readonly dueAt: string | null;
  readonly furnishedAt: string | null;
  readonly furnishMethod: AddendumRow["furnishMethod"];
  readonly signedAt: string | null;
  readonly signerKind: AddendumRow["signerKind"];
  readonly representativeName: string | null;
  readonly representativeRelationship: string | null;
  /** How the (c)(9) acknowledgement was captured; null until signed / refused. */
  readonly acknowledgementSource: ElectionAddendumAcknowledgementSource | null;
  /** The scanned signed paper copy (M22), when `acknowledgementSource` is `uploaded`. */
  readonly acknowledgementDocumentId: string | null;
  readonly acknowledgementDocumentVersionId: string | null;
  /** Where the (c) content lives: `scanned_paper` = the signed paper copy is the addendum. */
  readonly contentSource: ElectionAddendumContentSource;
  readonly refusedAt: string | null;
  readonly refusalReason: string | null;
  readonly signatureNotRequiredReason: AddendumRow["signatureNotRequiredReason"];
  readonly signatureNotRequiredNote: string | null;
  readonly signatureNotRequiredAt: string | null;
  readonly documentId: string | null;
  readonly supersededById: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The addendum panel's read model for one admission. */
export interface ElectionAddendumOverview {
  readonly admissionId: string;
  /** True when the election is effective on/after 2026-10-01 (the addendum is mandatory). */
  readonly required: boolean;
  readonly electionEffectiveDate: string | null;
  readonly inCare: boolean;
  /** The newest version (the one being worked or most recently on file), or null. */
  readonly current: ElectionAddendumView | null;
  /** Every version, newest first. */
  readonly history: readonly ElectionAddendumView[];
  /** The open 418.24(d) windows. */
  readonly openWindows: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly dueAt: string;
  }[];
}

/** What a plan-of-care change did to the addendum. */
export type AddendumUpdateOutcome =
  | "initial_opened"
  | "update_opened"
  | "draft_refreshed"
  | "unchanged"
  | "not_applicable"
  | "not_in_care"
  | "not_found";

/** The patch a clinician sends while the version is a draft. */
export interface ElectionAddendumDraftPatch {
  readonly items?: readonly AddendumItem[];
  readonly noNonCoveredItems?: boolean;
  readonly clinicalExplanation?: string | null;
  readonly guidelineReferences?: string | null;
  readonly terminalDiagnosis?: AddendumRow["terminalDiagnosis"];
  readonly relatedDiagnoses?: AddendumRow["relatedDiagnoses"];
  readonly hospiceName?: string | null;
  readonly patientName?: string | null;
  readonly medicalRecordNumber?: string | null;
}

export interface ElectionAddendumService {
  overview(organizationId: string, admissionId: string): Promise<ElectionAddendumOverview | null>;
  /** POST — create the initial draft, refresh the in-progress draft, or (after a furnished version) start the
   *  next version as a clinician-initiated plan-of-care update. */
  draft(
    organizationId: string,
    admissionId: string,
    actorUserId: string,
  ): Promise<ElectionAddendumOverview>;
  updateDraft(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    patch: ElectionAddendumDraftPatch,
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  furnish(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    input: { readonly method: ElectionAddendumFurnishMethod; readonly furnishedAt?: string },
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  recordSignature(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    input: {
      readonly signerKind: ElectionAddendumSignerKind;
      readonly representativeName?: string | null;
      readonly representativeRelationship?: string | null;
      readonly signedAt?: string;
    },
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  recordRefusal(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    input: { readonly reason: string },
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  /**
   * 418.24(c)(9) on paper — attach a scanned signed (or refused) paper copy uploaded to M22. From `furnished`
   * it is the acknowledgement; from `draft` the paper was furnished outside WardenX, so the version is
   * furnished (paper, at `furnishedAt`) and acknowledged in one transaction. Same events and audit as the
   * structured paths; the scanned copy is linked in `acknowledgementDocument*`, never over the rendered PDF.
   */
  attachUploadedAcknowledgement(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    input: UploadedAcknowledgementInput,
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  recordSignatureNotRequired(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    input: { readonly reason: ElectionAddendumExemptionReason; readonly note?: string | null },
    actorUserId: string,
  ): Promise<ElectionAddendumView>;
  /**
   * THE generic 418.24(d)(2) entry point: a plan-of-care change at `triggeredAt` that may affect the addendum's
   * determinations. Creates the next version (copied from the latest, re-filled from the sources) and opens /
   * tightens the 3-day update window; while a draft is still in progress the draft absorbs the change instead.
   * `cause` is a non-PHI tag (an event name or `manual`). With `requireDiff`, a change whose source
   * determinations equal the latest version's is a no-op (`unchanged`). Idempotent under redelivery.
   */
  openAddendumUpdateWindow(
    organizationId: string,
    admissionId: string,
    triggeredAt: Date,
    cause: string,
    options?: { readonly requireDiff?: boolean; readonly actorUserId?: string | null },
  ): Promise<{ readonly outcome: AddendumUpdateOutcome; readonly addendumId: string | null }>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toAddendumView(r: AddendumRow): ElectionAddendumView {
  return {
    id: r.id,
    admissionId: r.admissionId,
    patientId: r.patientId,
    electionStatementId: r.electionStatementId,
    versionNumber: r.versionNumber,
    trigger: r.trigger,
    triggerCause: r.triggerCause,
    triggeredAt: r.triggeredAt.toISOString(),
    status: r.status,
    hospiceName: r.hospiceName,
    patientName: r.patientName,
    medicalRecordNumber: r.medicalRecordNumber,
    terminalDiagnosis: r.terminalDiagnosis,
    relatedDiagnoses: r.relatedDiagnoses,
    items: r.items,
    noNonCoveredItems: r.noNonCoveredItems,
    clinicalExplanation: r.clinicalExplanation,
    guidelineReferences: r.guidelineReferences,
    dueAt: iso(r.dueAt),
    furnishedAt: iso(r.furnishedAt),
    furnishMethod: r.furnishMethod,
    signedAt: iso(r.signedAt),
    signerKind: r.signerKind,
    representativeName: r.representativeName,
    representativeRelationship: r.representativeRelationship,
    acknowledgementSource: r.acknowledgementSource,
    acknowledgementDocumentId: r.acknowledgementDocumentId,
    acknowledgementDocumentVersionId: r.acknowledgementDocumentVersionId,
    contentSource: r.contentSource,
    refusedAt: iso(r.refusedAt),
    refusalReason: r.refusalReason,
    signatureNotRequiredReason: r.signatureNotRequiredReason,
    signatureNotRequiredNote: r.signatureNotRequiredNote,
    signatureNotRequiredAt: iso(r.signatureNotRequiredAt),
    documentId: r.documentId,
    supersededById: r.supersededById,
    supersededAt: iso(r.supersededAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: Number(r.version),
  };
}

function contentFacts(r: AddendumRow): AddendumContentFacts {
  return {
    hospiceName: r.hospiceName,
    patientName: r.patientName,
    medicalRecordNumber: r.medicalRecordNumber,
    terminalDiagnosisCount: r.terminalDiagnosis.length,
    items: r.items,
    noNonCoveredItems: r.noNonCoveredItems,
    clinicalExplanation: r.clinicalExplanation,
  };
}

/** Read every source once, tolerating an unbound / failing source (null = keep what the row has). */
export async function resolveAddendumPrefill(
  sources: ElectionAddendumSources | undefined,
  organizationId: string,
  admissionId: string,
  patientId: string,
): Promise<AddendumPrefill> {
  if (!sources) return EMPTY_PREFILL;
  const settle = async <T>(f: (() => Promise<T>) | undefined): Promise<T | null> => {
    if (!f) return null;
    try {
      return await f();
    } catch {
      // A source outage must not block the clinician: the field stays as it is on the row and the furnish
      // guard (missingAddendumContent) refuses an addendum that is still incomplete.
      return null;
    }
  };
  const [items, dx, identity] = await Promise.all([
    settle(
      sources.nonCoveredItems
        ? () => sources.nonCoveredItems!.listForAdmission(organizationId, admissionId)
        : undefined,
    ),
    settle(
      sources.diagnoses
        ? () => sources.diagnoses!.diagnosesForAdmission(organizationId, admissionId)
        : undefined,
    ),
    settle(
      sources.patientIdentity
        ? () => sources.patientIdentity!(organizationId, patientId)
        : undefined,
    ),
  ]);
  return {
    patientName: identity?.name ?? null,
    medicalRecordNumber: identity?.mrn ?? null,
    terminalDiagnosis: dx ? dx.terminal : null,
    relatedDiagnoses: dx ? dx.related : null,
    items,
  };
}

export function createElectionAddendumService(
  deps: ElectionAddendumServiceDeps,
): ElectionAddendumService {
  const { db, outbox } = deps;
  const now = deps.now ?? (() => new Date());

  async function readFacts(
    organizationId: string,
    admissionId: string,
  ): Promise<AddendumAdmissionFacts | null> {
    return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
      loadAddendumAdmissionFacts(tx as DbClient, admissionId),
    );
  }

  async function overviewInTx(
    tx: DbClient,
    admissionId: string,
  ): Promise<ElectionAddendumOverview | null> {
    const facts = await loadAddendumAdmissionFacts(tx, admissionId);
    if (!facts) return null;
    const versions = await listAddendumVersions(tx, admissionId);
    const windows = await openAddendumWindows(tx, admissionId);
    const history = versions.map(toAddendumView);
    return {
      admissionId,
      required: facts.required,
      electionEffectiveDate: facts.electionEffectiveDate,
      inCare: facts.inCare,
      current: history[0] ?? null,
      history,
      openWindows: windows.map((w) => ({
        id: w.id,
        kind: w.windowKind,
        status: w.status,
        dueAt: w.mustCompleteBy.toISOString(),
      })),
    };
  }

  /** Load the version, binding it to the admission in the path (a foreign id reads as absent). */
  async function loadBound(
    tx: DbClient,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
  ): Promise<AddendumRow> {
    const row = await loadAddendum(tx, addendumId);
    if (!row || row.admissionId !== admissionId) throw new ResourceNotFoundError(addendumId);
    if (Number(row.version) !== ifVersion) {
      throw new AdmissionStateError(
        "ILLEGAL_TRANSITION",
        `election addendum ${addendumId} changed since it was read (version ${row.version}, expected ${ifVersion})`,
      );
    }
    return row;
  }

  /** Persist a transition + its column changes under optimistic concurrency, returning the new row. */
  async function writeTransition(
    tx: DbClient,
    row: AddendumRow,
    event: ElectionAddendumEvent,
    set: Partial<typeof EA.$inferInsert>,
  ): Promise<AddendumRow> {
    const t = transitionElectionAddendum(row.status, event);
    const [updated] = await tx
      .update(EA)
      .set({ ...set, status: t.to, updatedAt: now(), version: sql`${EA.version} + 1` })
      .where(and(eq(EA.id, row.id), eq(EA.version, row.version)))
      .returning();
    if (!updated) {
      throw new AdmissionStateError(
        "ILLEGAL_TRANSITION",
        `election addendum ${row.id} changed concurrently`,
      );
    }
    return updated;
  }

  /** One acknowledgement transition (signature / refusal / exemption) inside the caller's org tx. */
  async function acknowledgeInTx(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
    row: AddendumRow,
    actorUserId: string,
    event: ElectionAddendumEvent,
    set: Partial<typeof EA.$inferInsert>,
    auditAction: string,
    auditContext: Record<string, unknown>,
  ): Promise<ElectionAddendumView> {
    const at = now();
    const updated = await writeTransition(tx, row, event, {
      ...set,
      acknowledgementRecordedByUserId: actorUserId,
    });
    const t = transitionElectionAddendum(row.status, event);
    if (t.emits === "m6.election_addendum.acknowledged") {
      const tz = await organizationTimezone(tx, organizationId);
      await outbox.publish(tx, {
        eventName: "m6.election_addendum.acknowledged",
        payload: {
          electionAddendumId: updated.id,
          admissionId,
          patientId: updated.patientId,
          versionNumber: updated.versionNumber,
          outcome: updated.status,
          acknowledgedAt: at.toISOString(),
          renderPayload: buildAddendumRenderPayload(updated, tz),
        },
        organizationId,
        aggregateKind: "election_addendum",
        aggregateId: updated.id,
      });
    } else if (t.emits === "m6.election_addendum.not_required") {
      await outbox.publish(tx, {
        eventName: "m6.election_addendum.not_required",
        payload: {
          electionAddendumId: updated.id,
          admissionId,
          versionNumber: updated.versionNumber,
          reason: updated.signatureNotRequiredReason,
        },
        organizationId,
        aggregateKind: "election_addendum",
        aggregateId: updated.id,
      });
    }
    if (t.closesWindow) {
      await closeAddendumWindows(tx, outbox, {
        organizationId,
        admissionId,
        kinds: ADDENDUM_WINDOW_KINDS,
        closedVia: `not_required:${updated.signatureNotRequiredReason}`,
        closedByUserId: actorUserId,
        at,
      });
    }
    await audit(
      tx,
      { organizationId, userId: actorUserId, correlationId: `election-addendum:${updated.id}` },
      {
        eventType: auditAction,
        resourceKind: "election_addendum",
        resourceId: updated.id,
        outcome: "success",
        context: { admissionId, versionNumber: updated.versionNumber, ...auditContext },
      },
    );
    return toAddendumView(updated);
  }

  async function acknowledge(
    organizationId: string,
    admissionId: string,
    addendumId: string,
    ifVersion: number,
    actorUserId: string,
    event: ElectionAddendumEvent,
    set: Partial<typeof EA.$inferInsert>,
    auditAction: string,
    auditContext: Record<string, unknown>,
  ): Promise<ElectionAddendumView> {
    return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
      const tx = txRaw as DbClient;
      const row = await loadBound(tx, admissionId, addendumId, ifVersion);
      return acknowledgeInTx(
        tx,
        organizationId,
        admissionId,
        row,
        actorUserId,
        event,
        set,
        auditAction,
        auditContext,
      );
    });
  }

  /** draft → furnished inside the caller's org tx: supersede, close the window, render request, audit. */
  async function furnishInTx(
    tx: DbClient,
    organizationId: string,
    admissionId: string,
    row: AddendumRow,
    method: ElectionAddendumFurnishMethod,
    furnishedAt: Date,
    actorUserId: string,
    paper?: { readonly contentOnPaper: boolean; readonly scan: ScannedCopyRef },
  ): Promise<AddendumRow> {
    const at = now();
    const contentOnPaper = paper?.contentOnPaper ?? false;
    const updated = await writeTransition(
      tx,
      row,
      { type: "furnish", content: contentFacts(row), method, contentOnPaper },
      {
        furnishedAt,
        furnishMethod: method,
        furnishedByUserId: actorUserId,
        ...(contentOnPaper ? { contentSource: "scanned_paper" as const } : {}),
      },
    );
    await supersedePriorVersionsInTx(tx, admissionId, updated.id, updated.versionNumber, at);
    await closeAddendumWindows(tx, outbox, {
      organizationId,
      admissionId,
      kinds: [
        updated.trigger === "initial" ? "election_addendum_initial" : "election_addendum_update",
      ],
      closedVia: "furnished",
      closedByUserId: actorUserId,
      at,
    });
    const tz = await organizationTimezone(tx, organizationId);
    await outbox.publish(tx, {
      eventName: "m6.election_addendum.furnished",
      payload: {
        electionAddendumId: updated.id,
        admissionId,
        patientId: updated.patientId,
        versionNumber: updated.versionNumber,
        furnishedAt: furnishedAt.toISOString(),
        furnishMethod: method,
        renderPayload: buildAddendumRenderPayload(updated, tz, paper?.scan),
      },
      organizationId,
      aggregateKind: "election_addendum",
      aggregateId: updated.id,
    });
    await audit(
      tx,
      { organizationId, userId: actorUserId, correlationId: `election-addendum:${updated.id}` },
      {
        eventType: "m6.election_addendum.furnished",
        resourceKind: "election_addendum",
        resourceId: updated.id,
        outcome: "success",
        context: {
          admissionId,
          versionNumber: updated.versionNumber,
          method,
          contentOnPaper,
          lateByDueAt: !!updated.dueAt && furnishedAt.getTime() > updated.dueAt.getTime(),
        },
      },
    );
    return updated;
  }

  /** The scanned copy must be an ACTIVE M22 version linked to this addendum's patient + admission. */
  async function validateScannedCopy(
    organizationId: string,
    row: AddendumRow,
    input: { readonly documentId: string; readonly documentVersionId: string },
  ): Promise<void> {
    if (!deps.documentValidator) {
      throw new ChartWardenError(
        "ADMISSION_EVIDENCE_DOCUMENT_VALIDATOR_UNBOUND",
        "Attaching a scanned addendum requires the M22 document-version validator.",
        503,
      );
    }
    await deps.documentValidator.validateAdmissionEvidenceDocumentVersion({
      organizationId,
      admissionId: row.admissionId,
      patientId: row.patientId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
    });
  }

  const service: ElectionAddendumService = {
    async overview(organizationId, admissionId) {
      return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        overviewInTx(tx as DbClient, admissionId),
      );
    },

    async openAddendumUpdateWindow(organizationId, admissionId, triggeredAt, cause, options) {
      const pre = await readFacts(organizationId, admissionId);
      if (!pre) return { outcome: "not_found", addendumId: null };
      if (!pre.inCare) return { outcome: "not_in_care", addendumId: null };
      if (!pre.required) return { outcome: "not_applicable", addendumId: null };
      const prefill = await resolveAddendumPrefill(
        deps.sources,
        organizationId,
        admissionId,
        pre.patientId,
      );
      const actor = options?.actorUserId ?? "";
      return withOrgContext(db, { organizationId, userId: actor }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const facts = await loadAddendumAdmissionFacts(tx, admissionId);
        if (!facts) return { outcome: "not_found" as const, addendumId: null };
        if (!facts.inCare) return { outcome: "not_in_care" as const, addendumId: null };
        if (!facts.required) return { outcome: "not_applicable" as const, addendumId: null };
        const [latest] = await listAddendumVersions(tx, admissionId);
        const at = now();
        if (!latest) {
          // The initial addendum was never opened (an admission activated before this shipped): open it now —
          // its clock still runs from the election's effective date, not from this change.
          const created = await openInitialAddendumInTx(tx, outbox, {
            organizationId,
            admissionId,
            prefill,
            createdByUserId: actor || null,
            now: at,
          });
          return { outcome: "initial_opened" as const, addendumId: created?.id ?? null };
        }
        if (latest.status === "draft") {
          await refreshDraftInTx(tx, latest, prefill, at);
          return { outcome: "draft_refreshed" as const, addendumId: latest.id };
        }
        if (latest.status === "not_required") {
          return { outcome: "not_in_care" as const, addendumId: null };
        }
        if (options?.requireDiff && prefill.items && !sourceItemsDiffer(latest, prefill.items)) {
          return { outcome: "unchanged" as const, addendumId: latest.id };
        }
        const created = await createUpdateVersionInTx(tx, outbox, {
          organizationId,
          facts,
          latest,
          triggeredAt,
          cause,
          prefill,
          createdByUserId: actor || null,
          now: at,
        });
        return {
          outcome: created ? ("update_opened" as const) : ("draft_refreshed" as const),
          addendumId: created?.id ?? null,
        };
      });
    },

    async draft(organizationId, admissionId, actorUserId) {
      const facts = await readFacts(organizationId, admissionId);
      if (!facts) throw new ResourceNotFoundError(admissionId);
      if (!facts.required || !facts.inCare) {
        throw new AdmissionStateError(
          "ADDENDUM_NOT_APPLICABLE",
          facts.inCare
            ? "The election statement addendum is mandatory only for elections effective on or after 2026-10-01"
            : "The patient is not under hospice care, so no addendum can be drafted",
        );
      }
      await service.openAddendumUpdateWindow(organizationId, admissionId, now(), "manual", {
        actorUserId,
      });
      const ov = await service.overview(organizationId, admissionId);
      if (!ov) throw new ResourceNotFoundError(admissionId);
      return ov;
    },

    async updateDraft(organizationId, admissionId, addendumId, ifVersion, patch, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const row = await loadBound(tx, admissionId, addendumId, ifVersion);
        const next: AddendumRow = {
          ...row,
          ...(patch.items !== undefined
            ? { items: carrySourceReasons(row.items, patch.items) }
            : {}),
          ...(patch.noNonCoveredItems !== undefined
            ? { noNonCoveredItems: patch.noNonCoveredItems }
            : {}),
          ...(patch.clinicalExplanation !== undefined
            ? { clinicalExplanation: patch.clinicalExplanation }
            : {}),
          ...(patch.guidelineReferences !== undefined
            ? { guidelineReferences: patch.guidelineReferences }
            : {}),
          ...(patch.terminalDiagnosis !== undefined
            ? { terminalDiagnosis: [...patch.terminalDiagnosis] }
            : {}),
          ...(patch.relatedDiagnoses !== undefined
            ? { relatedDiagnoses: [...patch.relatedDiagnoses] }
            : {}),
          ...(patch.hospiceName !== undefined ? { hospiceName: patch.hospiceName } : {}),
          ...(patch.patientName !== undefined ? { patientName: patch.patientName } : {}),
          ...(patch.medicalRecordNumber !== undefined
            ? { medicalRecordNumber: patch.medicalRecordNumber }
            : {}),
        };
        const updated = await writeTransition(
          tx,
          row,
          { type: "updateItems", content: contentFacts(next) },
          {
            items: next.items,
            noNonCoveredItems: next.noNonCoveredItems,
            clinicalExplanation: next.clinicalExplanation,
            guidelineReferences: next.guidelineReferences,
            terminalDiagnosis: next.terminalDiagnosis,
            relatedDiagnoses: next.relatedDiagnoses,
            hospiceName: next.hospiceName,
            patientName: next.patientName,
            medicalRecordNumber: next.medicalRecordNumber,
          },
        );
        return toAddendumView(updated);
      });
    },

    async furnish(organizationId, admissionId, addendumId, ifVersion, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const row = await loadBound(tx, admissionId, addendumId, ifVersion);
        const at = now();
        const furnishedAt = input.furnishedAt ? new Date(input.furnishedAt) : at;
        if (Number.isNaN(furnishedAt.getTime()) || furnishedAt.getTime() > at.getTime()) {
          throw new AdmissionStateError(
            "ADDENDUM_INCOMPLETE",
            "The furnished date must be a valid date that is not in the future",
          );
        }
        const updated = await furnishInTx(
          tx,
          organizationId,
          admissionId,
          row,
          input.method,
          furnishedAt,
          actorUserId,
        );
        return toAddendumView(updated);
      });
    },

    async recordSignature(organizationId, admissionId, addendumId, ifVersion, input, actorUserId) {
      const signedAt = input.signedAt ? new Date(input.signedAt) : now();
      if (Number.isNaN(signedAt.getTime()) || signedAt.getTime() > now().getTime()) {
        throw new AdmissionStateError(
          "ADDENDUM_INCOMPLETE",
          "The signature date must be a valid date that is not in the future",
        );
      }
      const representative = input.signerKind === "representative";
      return acknowledge(
        organizationId,
        admissionId,
        addendumId,
        ifVersion,
        actorUserId,
        {
          type: "recordSignature",
          signerKind: input.signerKind,
          representativeName: input.representativeName ?? null,
        },
        {
          signedAt,
          signerKind: input.signerKind,
          representativeName: representative ? (input.representativeName ?? null) : null,
          representativeRelationship: representative
            ? (input.representativeRelationship ?? null)
            : null,
          acknowledgementSource: "structured",
        },
        "m6.election_addendum.signature_recorded",
        { signerKind: input.signerKind, acknowledgementSource: "structured" },
      );
    },

    async recordRefusal(organizationId, admissionId, addendumId, ifVersion, input, actorUserId) {
      return acknowledge(
        organizationId,
        admissionId,
        addendumId,
        ifVersion,
        actorUserId,
        { type: "recordRefusal", reason: input.reason },
        {
          refusedAt: now(),
          refusalReason: input.reason.trim(),
          acknowledgementSource: "structured",
        },
        "m6.election_addendum.refusal_recorded",
        { acknowledgementSource: "structured" },
      );
    },

    async attachUploadedAcknowledgement(
      organizationId,
      admissionId,
      addendumId,
      ifVersion,
      input,
      actorUserId,
    ) {
      const current = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        loadAddendum(tx as DbClient, addendumId),
      );
      if (!current || current.admissionId !== admissionId) {
        throw new ResourceNotFoundError(addendumId);
      }
      // M22 read BEFORE the write transaction (it opens its own org-scoped read).
      await validateScannedCopy(organizationId, current, input);
      const acknowledgedAt =
        input.outcome === "signed"
          ? new Date(input.signedAt)
          : input.refusedAt
            ? new Date(input.refusedAt)
            : now();
      const scanned = {
        acknowledgementSource: "uploaded" as const,
        acknowledgementDocumentId: input.documentId,
        acknowledgementDocumentVersionId: input.documentVersionId,
      };
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = txRaw as DbClient;
        let row = await loadBound(tx, admissionId, addendumId, ifVersion);
        const plan = planUploadedAcknowledgement({
          status: row.status,
          acknowledgedAt,
          furnishedAt: input.furnishedAt ? new Date(input.furnishedAt) : null,
          contentGaps: addendumContentGaps(contentFacts(row)),
          now: now(),
        });
        if (plan.furnishFirst && plan.furnishedAt) {
          row = await furnishInTx(
            tx,
            organizationId,
            admissionId,
            row,
            "paper",
            plan.furnishedAt,
            actorUserId,
            {
              contentOnPaper: plan.contentOnPaper,
              scan: { documentId: input.documentId, filedAt: now() },
            },
          );
        }
        const auditContext = {
          acknowledgementSource: "uploaded",
          documentId: input.documentId,
          documentVersionId: input.documentVersionId,
          furnishedOnPaper: plan.furnishFirst,
          contentOnPaper: plan.contentOnPaper,
        };
        if (input.outcome === "refused") {
          return acknowledgeInTx(
            tx,
            organizationId,
            admissionId,
            row,
            actorUserId,
            { type: "recordRefusal", reason: input.reason },
            { refusedAt: acknowledgedAt, refusalReason: input.reason.trim(), ...scanned },
            "m6.election_addendum.refusal_recorded",
            auditContext,
          );
        }
        const representative = input.signerKind === "representative";
        return acknowledgeInTx(
          tx,
          organizationId,
          admissionId,
          row,
          actorUserId,
          {
            type: "recordSignature",
            signerKind: input.signerKind,
            representativeName: input.representativeName ?? null,
          },
          {
            signedAt: acknowledgedAt,
            signerKind: input.signerKind,
            representativeName: representative ? (input.representativeName ?? null) : null,
            representativeRelationship: representative
              ? (input.representativeRelationship ?? null)
              : null,
            ...scanned,
          },
          "m6.election_addendum.signature_recorded",
          { signerKind: input.signerKind, ...auditContext },
        );
      });
    },

    async recordSignatureNotRequired(
      organizationId,
      admissionId,
      addendumId,
      ifVersion,
      input,
      actorUserId,
    ) {
      const current = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        loadAddendum(tx as DbClient, addendumId),
      );
      if (!current || current.admissionId !== admissionId) {
        throw new ResourceNotFoundError(addendumId);
      }
      const event: ElectionAddendumEvent =
        current.status === "draft"
          ? { type: "markNotRequired", reason: input.reason }
          : { type: "recordSignatureNotRequired", reason: input.reason };
      return acknowledge(
        organizationId,
        admissionId,
        addendumId,
        ifVersion,
        actorUserId,
        event,
        {
          signatureNotRequiredReason: input.reason,
          signatureNotRequiredNote: input.note?.trim() || null,
          signatureNotRequiredAt: now(),
        },
        "m6.election_addendum.exemption_recorded",
        { reason: input.reason, furnished: current.status !== "draft" },
      );
    },
  };
  return service;
}
