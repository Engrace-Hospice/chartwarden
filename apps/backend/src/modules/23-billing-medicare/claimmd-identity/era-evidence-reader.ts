import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { isVerifiedM23SubmissionEvidence } from "./candidate-provider";

const E = schema.claimmdSubmissionEvidence;
const C = schema.claimSubmission;
const A = schema.clearinghouseSubmissionAttempts;
const MAX_ROWS = 501;

export interface ClaimMdEraSubmissionFact {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly claimId: string;
  readonly billingModule: "M23" | "M41";
  readonly billingNpi: string;
  readonly billingTin: string;
  readonly payerId: string;
  readonly pcn: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly submissionId: string;
  readonly attemptKey: string;
}

/** M23-owned read-only export of immutable Claim.MD send evidence for ERA identity resolution. */
export async function readClaimMdEraSubmissionFacts(input: {
  readonly tx: DbClient;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly npis: readonly string[];
  readonly pcns?: readonly string[];
  readonly openTin: (fact: {
    id: string;
    organizationId: string;
    providerEntityId: string;
    attemptKey: string;
    sealed: string;
  }) => Promise<string>;
}): Promise<{ readonly complete: boolean; readonly facts: readonly ClaimMdEraSubmissionFact[] }> {
  const npis = [...new Set(input.npis.filter((value) => /^\d{10}$/.test(value)))];
  const pcns = [...new Set((input.pcns ?? []).filter(Boolean))];
  if (!npis.length && !pcns.length) return { complete: true, facts: [] };
  const rows = await input.tx
    .select({
      id: E.id,
      organizationId: E.organizationId,
      providerEntityId: E.providerEntityId,
      locationId: E.locationId,
      claimId: E.claimId,
      billingModule: E.billingModule,
      billingNpi: E.billingNpi,
      billingTinCiphertext: E.billingTinCiphertext,
      payerId: E.payerId,
      pcn: E.pcn,
      claimType: E.claimType,
      serviceFrom: E.serviceFrom,
      serviceTo: E.serviceTo,
      accountReference: E.accountReference,
      usage: E.usage,
      submissionId: E.submissionId,
      attemptKey: E.attemptKey,
      m23Id: C.id,
      m23OrganizationId: C.organizationId,
      m23ProviderEntityId: C.providerEntityId,
      m23ClaimId: C.claimId,
      m23Kind: C.kind,
      m23ControlNumber: C.claimControlNumber,
      m23AttemptIndex: C.attemptIndex,
      attemptOrganizationId: A.organizationId,
      attemptProviderEntityId: A.providerEntityId,
      attemptUsage: A.usage,
      attemptControlNumber: A.controlNumber,
      attemptKind: A.kind,
      attemptStatus: A.status,
    })
    .from(E)
    .leftJoin(C, and(eq(C.id, E.submissionId), eq(E.billingModule, "M23")))
    .leftJoin(
      A,
      and(
        eq(A.organizationId, E.organizationId),
        eq(A.providerEntityId, E.providerEntityId),
        eq(A.usage, E.usage),
        eq(A.controlNumber, E.pcn),
        inArray(A.status, ["reserved", "sent"]),
      ),
    )
    .where(
      and(
        eq(E.vendor, "claimmd"),
        eq(E.accountReference, input.accountReference),
        eq(E.usage, input.usage),
        or(
          ...[
            ...(npis.length ? [inArray(E.billingNpi, npis)] : []),
            ...(pcns.length ? [inArray(E.pcn, pcns)] : []),
          ],
        ),
      ),
    )
    .limit(MAX_ROWS);
  const complete = rows.length < MAX_ROWS;
  const facts = await Promise.all(
    rows
      .slice(0, MAX_ROWS - 1)
      .filter(
        (row) =>
          row.billingModule === "M41" ||
          isVerifiedM23SubmissionEvidence({
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            claimId: row.claimId,
            submissionId: row.submissionId,
            attemptKey: row.attemptKey,
            pcn: row.pcn,
            source: {
              id: row.m23Id,
              organizationId: row.m23OrganizationId,
              providerEntityId: row.m23ProviderEntityId,
              claimId: row.m23ClaimId,
              kind: row.m23Kind,
              controlNumber: row.m23ControlNumber,
              attemptIndex: row.m23AttemptIndex,
            },
            transportAttempt: {
              organizationId: row.attemptOrganizationId,
              providerEntityId: row.attemptProviderEntityId,
              usage: row.attemptUsage,
              controlNumber: row.attemptControlNumber,
              kind: row.attemptKind,
              status: row.attemptStatus,
            },
          }),
      )
      .map(async (row) => ({
        id: row.id,
        organizationId: row.organizationId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        claimId: row.claimId,
        billingModule: row.billingModule,
        billingNpi: row.billingNpi,
        billingTin: await input.openTin({
          id: row.id,
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          attemptKey: row.attemptKey,
          sealed: row.billingTinCiphertext,
        }),
        payerId: row.payerId,
        pcn: row.pcn,
        claimType: row.claimType,
        serviceFrom: row.serviceFrom,
        serviceTo: row.serviceTo,
        accountReference: row.accountReference,
        usage: row.usage,
        submissionId: row.submissionId,
        attemptKey: row.attemptKey,
      })),
  );
  return { complete, facts };
}
