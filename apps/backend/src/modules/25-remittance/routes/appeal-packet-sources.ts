// apps/backend/src/modules/25-remittance/routes/appeal-packet-sources.ts - GAP-036. Everything the appeal packet
// asserts about OTHER modules' records is read here, server-side, at submit - never taken from the request:
//   * the claim copy (header + lines) from M23, through its published `ClaimSubmissionReader` seam;
//   * each enclosure's identity (title, date, kind) from M22, through its published `DocumentReader` seam;
//   * the 835 payment detail from M25's own remittance tables, under the acting org's RLS.
//
// ENCLOSURE RULES (a bad id must never reach the outbox - before this, a nonexistent, another patient's or another
// tenant's document id was copied verbatim into a letter that goes to a MAC):
//   * the document must be visible to the org (the seam is RLS-scoped, so another tenant's id reads as absent),
//   * ACTIVE or on legal hold (still the record; a hold only blocks destruction) - not superseded by a newer
//     document and not a destroyed tombstone,
//   * linked to THE CLAIM'S PATIENT (a document with no patient, or another patient's, is refused),
//   * not 42 CFR Part 2 (`compliance_42cfr_part2`): a Part 2 record is never named in a payer filing from here. There
//     is no consent override on this path - a disclosure for payment of a Part 2 record needs a product decision
//     (and byte-level handling) that this reference-only packet does not make.
// Every refusal is a 422 `APPEAL_DOCUMENT_NOT_ATTACHABLE` carrying the document id and a REASON CODE, never the
// document's title or any content.
import { type DbClient, schema } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import {
  type AppealClaimCopy,
  type AppealEnclosureRefusal,
  type AppealRemitCopy,
  type DocumentDigest,
  type DocumentReader,
  MAX_APPEAL_ENCLOSURES,
  WardenXError,
  appealEnclosureRefusal,
} from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** M22's `DocumentReader`, narrowed to the one arm this packet reads. */
export type AppealDocumentPort = Pick<DocumentReader, "documentMetadata">;

/** The claim as M23 holds it, narrowed to what the packet prints plus the patient the enclosures must belong to. */
export interface AppealClaimSourceFacts {
  readonly patientId: string;
  readonly copy: AppealClaimCopy;
}
export interface AppealClaimSourcePort {
  claimCopyForAppeal(orgId: string, claimId: string): Promise<AppealClaimSourceFacts | null>;
}

export interface AppealSourcePorts {
  readonly documents: () => AppealDocumentPort;
  readonly claims: () => AppealClaimSourcePort;
}

/** Bind the production ports: M22 / M23's published seams, resolved lazily so boot registration order is free. */
export function buildSeamAppealSourcePorts(): AppealSourcePorts {
  return {
    // M22's reader opens the AMBIENT request context's tenant; an explicit context for the org being asked about
    // makes the read independent of whoever is calling (a route has one, a direct service call does not).
    documents: () => ({
      documentMetadata: (args) =>
        runWithRequestContext({ organizationId: args.organizationId, userId: "" }, () =>
          (getSeam("DocumentReader") as AppealDocumentPort).documentMetadata(args),
        ),
    }),
    claims: () => getSeam("ClaimSubmissionReader") as unknown as AppealClaimSourcePort,
  };
}

/** No port bound: a packet whose sources cannot be read is refused, never filed half-empty. */
export const UNBOUND_APPEAL_SOURCES: AppealSourcePorts = {
  documents: () => {
    throw new WardenXError("SEAM_UNBOUND", "the appeal packet document source is not bound", 503);
  },
  claims: () => {
    throw new WardenXError("SEAM_UNBOUND", "the appeal packet claim source is not bound", 503);
  },
};

export type EnclosureRefusal = AppealEnclosureRefusal;

/** Pure: why a document may not be enclosed in this claim's appeal, or null when it may. */
export function enclosureRefusal(
  digest: Pick<DocumentDigest, "status" | "patientId" | "retentionClass"> | null,
  claimPatientId: string,
): EnclosureRefusal | null {
  return appealEnclosureRefusal(digest, claimPatientId);
}

export interface DescribedEnclosure {
  readonly documentId: string;
  readonly title: string;
  readonly documentDate: string;
  readonly documentKind: string;
}

function refuse(documentId: string, reason: EnclosureRefusal, subject: string): never {
  throw new WardenXError(
    "APPEAL_DOCUMENT_NOT_ATTACHABLE",
    `document ${documentId} cannot be enclosed in this ${subject} (${reason})`,
    422,
  );
}

/**
 * Resolve and validate every enclosure id (supporting documents in order, then the optional medical-records
 * bundle) against the org and the claim's patient. Returns the described enclosures; throws on the first problem.
 */
export async function describeEnclosures(
  documents: AppealDocumentPort,
  organizationId: string,
  claimPatientId: string,
  attachedDocumentIds: readonly string[],
  bundleDocumentId?: string,
  /** What the filing is called in a refusal message: the ADR response packet reuses these rules. */
  subject = "appeal",
): Promise<{
  readonly attached: readonly DescribedEnclosure[];
  readonly bundle?: DescribedEnclosure;
}> {
  const all = [...attachedDocumentIds, ...(bundleDocumentId ? [bundleDocumentId] : [])];
  if (all.length > MAX_APPEAL_ENCLOSURES) {
    throw new WardenXError(
      "APPEAL_TOO_MANY_ENCLOSURES",
      `an appeal packet carries at most ${MAX_APPEAL_ENCLOSURES} enclosures`,
      422,
    );
  }
  const dup = all.find((id, i) => all.indexOf(id) !== i);
  if (dup !== undefined) {
    throw new WardenXError(
      "APPEAL_DUPLICATE_ENCLOSURE",
      `document ${dup} is listed more than once`,
      422,
    );
  }
  const describeOne = async (documentId: string): Promise<DescribedEnclosure> => {
    const digest = await documents.documentMetadata({
      documentId: documentId as never,
      organizationId: organizationId as never,
    });
    const reason = enclosureRefusal(digest, claimPatientId);
    if (reason !== null || digest === null)
      return refuse(documentId, reason ?? "not_found", subject);
    return {
      documentId,
      title: digest.title,
      documentDate: digest.createdAt,
      documentKind: digest.aggregateType,
    };
  };
  const attached: DescribedEnclosure[] = [];
  for (const id of attachedDocumentIds) attached.push(await describeOne(id));
  return {
    attached,
    ...(bundleDocumentId ? { bundle: await describeOne(bundleDocumentId) } : {}),
  };
}

/** "1234.50" (numeric(12,2) text) -> 123450 integer cents, exact (no float arithmetic). */
export function numericToCents(value: string | number): number {
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?\d*$/.exec(s);
  if (!m) throw new WardenXError("INVALID_AMOUNT", "a money amount is not a decimal number", 500);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

const ISO = (d: Date): string => d.toISOString();

/**
 * The 835 payment detail for the remittance line a denial came from, from M25's own tables under the acting org's
 * RLS. Null when the line is not visible (never fabricated). No free text is read (`free_text` is audit-denylisted).
 */
export async function loadRemitCopy(
  tx: Tx,
  organizationId: string,
  remittanceLineId: string,
): Promise<AppealRemitCopy | null> {
  const RL = schema.remittanceLine;
  const RA = schema.remittanceAdvice;
  const [line] = await tx
    .select()
    .from(RL)
    .where(and(eq(RL.id, remittanceLineId), eq(RL.organizationId, organizationId)))
    .limit(1);
  if (!line) return null;
  const [advice] = await tx
    .select()
    .from(RA)
    .where(and(eq(RA.id, line.remittanceAdviceId), eq(RA.organizationId, organizationId)))
    .limit(1);
  if (!advice) return null;
  const adjustments = await tx
    .select()
    .from(schema.remittanceAdjustment)
    .where(eq(schema.remittanceAdjustment.remittanceLineId, line.id));
  const remarks = await tx
    .select()
    .from(schema.remittanceRemark)
    .where(eq(schema.remittanceRemark.remittanceLineId, line.id));
  const serviceLines = await tx
    .select()
    .from(schema.remittanceServiceLine)
    .where(eq(schema.remittanceServiceLine.remittanceLineId, line.id));
  return {
    remittanceAdviceId: advice.id,
    receivedAt: ISO(advice.receivedAt),
    paymentMethod: advice.paymentMethod,
    checkOrEftTrace: advice.checkOrEftTraceNumber ?? null,
    payerIcn: line.clp07PayerIcn ?? null,
    claimStatusCode: line.clp02StatusCode,
    chargeCents: numericToCents(line.clp03TotalChargeAmount),
    paidCents: numericToCents(line.clp04TotalPaymentAmount),
    patientResponsibilityCents: numericToCents(line.clp05PatientResponsibilityAmount),
    adjustments: adjustments.map((a) => ({
      group: a.casGroupCode,
      carc: a.casReasonCode,
      amountCents: numericToCents(a.adjustmentAmount),
    })),
    remarks: remarks.map((r) => ({ kind: r.remarkKind, rarc: r.remarkCode })),
    serviceLines: serviceLines.map((s) => ({
      revenueCode: s.svc01RevenueCode ?? null,
      hcpcsCode: s.svc01ProcedureCode ?? null,
      chargeCents: numericToCents(s.svc02ChargeAmount),
      paidCents: numericToCents(s.svc03PaidAmount),
    })),
  };
}
