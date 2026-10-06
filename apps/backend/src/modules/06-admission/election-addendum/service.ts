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
import type {
  AddendumDiagnosesReader,
  ElectionAddendumExemptionReason,
  ElectionAddendumFurnishMethod,
  ElectionAddendumSignerKind,
  NonCoveredItemsReader,
} from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import { ResourceNotFoundError } from "../routes/service";
import {
  type AddendumContentFacts,
  type ElectionAddendumEvent,
  transitionElectionAddendum,
} from "../state-machines/election-addendum";
import { AdmissionStateError } from "../state-machines/errors";
import type { AddendumOutboxPort as AdmissionWriteOutboxPort } from "./outbox-port";
import { buildAddendumRenderPayload } from "./render-payload";
import {
  ADDENDUM_WINDOW_KINDS,
  type AddendumAdmissionFacts,
  type AddendumItem,
  type AddendumPrefill,
  type AddendumRow,
  EMPTY_PREFILL,
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
  readonly now?: () => Date;
}

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
          ...(patch.items !== undefined ? { items: [...patch.items] } : {}),
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
        const updated = await writeTransition(
          tx,
          row,
          { type: "furnish", content: contentFacts(row), method: input.method },
          { furnishedAt, furnishMethod: input.method, furnishedByUserId: actorUserId },
        );
        await supersedePriorVersionsInTx(tx, admissionId, updated.id, updated.versionNumber, at);
        await closeAddendumWindows(tx, outbox, {
          organizationId,
          admissionId,
          kinds: [
            updated.trigger === "initial"
              ? "election_addendum_initial"
              : "election_addendum_update",
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
            furnishMethod: input.method,
            renderPayload: buildAddendumRenderPayload(updated, tz),
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
              method: input.method,
              lateByDueAt: !!updated.dueAt && furnishedAt.getTime() > updated.dueAt.getTime(),
            },
          },
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
        },
        "m6.election_addendum.signature_recorded",
        { signerKind: input.signerKind },
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
        { refusedAt: now(), refusalReason: input.reason.trim() },
        "m6.election_addendum.refusal_recorded",
        {},
      );
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
