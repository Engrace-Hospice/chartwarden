// apps/backend/src/modules/06-admission/nomnc/deadlines.ts — milestone 10a: the typed-deadline insert and the
// linked-document check, split out of service.ts. Both run inside the caller's org-context transaction.
import { type DbClient, organizationTimezone } from "@chartwarden/db";
import { DegradedError } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import type { AdmissionEvidenceDocumentValidator } from "../admission-evidence-service";
import { ResourceNotFoundError } from "../routes/service";
import { mapUniqueViolation } from "../unique-violation";
import {
  type DeadlineKind,
  NomncRuleError,
  requireOtherLabel,
  requireSourceNote,
  resolveTypedInstant,
} from "./domain";
import { D, type DeadlineView, type NoticeRow, type ReviewRow, deadlineView } from "./store";
import type { AddDeadlineInput, TypedMoment } from "./types";

export type NomncLog = (event: string, detail: Record<string, unknown>) => void;

/** Where a failure is reported (ids and error class only, never PHI). Defaults to stderr. */
export const defaultNomncLog: NomncLog = (event, detail) => {
  console.warn(JSON.stringify({ event, ...detail }));
};

export const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

export const typedMoment = (m: TypedMoment | undefined, zone: string) =>
  resolveTypedInstant(m?.date, m?.time, zone);

export type DocumentVerifier = (
  organizationId: string,
  scope: { readonly admissionId: string; readonly patientId: string },
  documentId: string | null | undefined,
  documentVersionId: string | null | undefined,
) => Promise<void>;

/**
 * A document a record links to must be an ACTIVE M22 version of THIS organization's patient and admission. Run before
 * any write, inside the caller's org-context transaction; a foreign, cross-patient or cross-tenant id reads as absent
 * (404, no existence oracle) and nothing is written. The underlying refusal is logged server-side (class and code only).
 */
export function createDocumentVerifier(
  validator: AdmissionEvidenceDocumentValidator | undefined,
  log: NomncLog,
): DocumentVerifier {
  return async (organizationId, scope, documentId, documentVersionId) => {
    if (!documentId) return;
    if (!validator) throw new DegradedError("m6.nomnc-documents", "document linking is not bound");
    if (!documentVersionId) {
      throw new NomncRuleError("DOCUMENT_VERSION_REQUIRED", "name the document version to link");
    }
    try {
      await validator.validateAdmissionEvidenceDocumentVersion({
        organizationId,
        admissionId: scope.admissionId,
        patientId: scope.patientId,
        documentId,
        documentVersionId,
      });
    } catch (error) {
      const e = error as { name?: string; code?: string };
      log("m6.nomnc.document_link_refused", {
        organizationId,
        admissionId: scope.admissionId,
        documentId,
        error: e.name ?? "unknown",
        code: e.code ?? null,
      });
      throw new ResourceNotFoundError(documentId);
    }
  };
}

export interface InsertDeadlineContext {
  readonly tx: DbClient;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly now: Date;
  readonly verify: DocumentVerifier;
}

/**
 * Insert a typed deadline for a notice / review. A deadline typed ALREADY in the past is recorded with its overdue
 * alert marked as given (`overdue_alerted_at = now`): the person entering it is looking at it, so the scan does not
 * page the care team and compliance for it on the very next tick. A later edit to a future time restarts the alerts.
 */
export async function insertDeadline(
  c: InsertDeadlineContext,
  parent: NoticeRow | ReviewRow,
  subject: { nomncNoticeId: string } | { expeditedReviewId: string },
  allowedKinds: readonly DeadlineKind[],
  input: AddDeadlineInput,
): Promise<DeadlineView> {
  const { tx, organizationId } = c;
  if (!allowedKinds.includes(input.kind)) {
    throw new NomncRuleError(
      "DEADLINE_KIND_NOT_ALLOWED",
      `a deadline of kind "${input.kind}" does not belong here`,
    );
  }
  await c.verify(organizationId, parent, input.noticeDocumentId, input.noticeDocumentVersionId);
  const label = requireOtherLabel(input.kind, input.label);
  const sourceNote = requireSourceNote(input.sourceNote);
  const zone = await organizationTimezone(tx, organizationId);
  const typed = typedMoment(input.due, zone);
  const subjectColumn =
    "nomncNoticeId" in subject
      ? eq(D.nomncNoticeId, subject.nomncNoticeId)
      : eq(D.expeditedReviewId, subject.expeditedReviewId);
  if (input.kind !== "other") {
    const [dup] = await tx
      .select({ id: D.id })
      .from(D)
      .where(and(subjectColumn, eq(D.kind, input.kind), sql`${D.satisfiedAt} IS NULL`))
      .limit(1);
    if (dup) {
      throw new NomncRuleError(
        "DEADLINE_ALREADY_RECORDED",
        `an unsatisfied "${input.kind}" deadline is already recorded; edit it instead`,
      );
    }
  }
  const [row] = await tx
    .insert(D)
    .values({
      organizationId,
      providerEntityId: parent.providerEntityId,
      locationId: parent.locationId,
      patientId: parent.patientId,
      admissionId: parent.admissionId,
      ...subject,
      kind: input.kind,
      label,
      dueAt: typed.instant,
      dueLocal: typed.dueLocal,
      zone,
      sourceNote,
      noticeDocumentId: input.noticeDocumentId ?? null,
      noticeDocumentVersionId: input.noticeDocumentId
        ? (input.noticeDocumentVersionId ?? null)
        : null,
      overdueAlertedAt: typed.instant.getTime() <= c.now.getTime() ? c.now : null,
      createdByUserId: c.actorUserId || null,
    })
    .returning()
    .catch((err: unknown) => {
      throw mapUniqueViolation(err, {
        expedited_deadline_notice_kind_uq: () =>
          new NomncRuleError("DEADLINE_ALREADY_RECORDED", "that deadline is already recorded"),
        expedited_deadline_review_kind_uq: () =>
          new NomncRuleError("DEADLINE_ALREADY_RECORDED", "that deadline is already recorded"),
      });
    });
  if (!row) throw new Error("expedited_deadline insert returned no row");
  return deadlineView(row, c.now, true);
}
