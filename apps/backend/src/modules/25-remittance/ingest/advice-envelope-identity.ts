import type { ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";

/**
 * The ISA / GS / ST identity columns of a `remittance_advice` envelope row, copied from the parsed 835.
 * Both the receive path and the controlled Claim.MD posting insert spread this, so a Claim.MD-posted
 * advice always carries its GS06 and group provenance. A row with a NULL GS06 is treated as a legacy
 * row by the NULLS NOT DISTINCT dedupe index and by the legacy guards (receive and Claim.MD staging).
 */
export function adviceEnvelopeIdentityColumns(parsed: ParsedRemittanceAdvice) {
  return {
    interchangeControlNumber: parsed.interchangeControlNumber,
    interchangeSenderCode: parsed.interchangeSenderCode ?? null,
    interchangeReceiverCode: parsed.interchangeReceiverCode ?? null,
    functionalGroupControlNumber: parsed.functionalGroupControlNumber ?? null,
    functionalGroupMetadata: {
      identifierCode: parsed.functionalGroupIdentifierCode ?? null,
      senderCode: parsed.functionalGroupSenderCode ?? null,
      receiverCode: parsed.functionalGroupReceiverCode ?? null,
      creationTime: parsed.functionalGroupCreationTime ?? null,
      version: parsed.functionalGroupVersion ?? null,
      position: parsed.functionalGroupPosition ?? null,
    },
    transactionSetPosition: parsed.transactionSetPosition ?? null,
    transactionSetControlNumber: parsed.transactionSetControlNumber,
  };
}

/**
 * True when a stage row's recorded ISA06/ISA08/GS06 disagrees with the sealed transaction set it was staged from.
 * A NULL column is unrecorded, not different: migration 1508 added the columns as nullable, so a stage staged before
 * it has NULLs while its sealed set may carry the values, and refusing it would strand an approved plan. Only a
 * recorded value that disagrees is a mismatch.
 */
export function stageIdentityDiffersFromSealedSet(
  stage: {
    readonly interchangeSenderCode: string | null;
    readonly interchangeReceiverCode: string | null;
    readonly functionalGroupControlNumber: string | null;
  },
  sealed: Pick<
    ParsedRemittanceAdvice,
    "interchangeSenderCode" | "interchangeReceiverCode" | "functionalGroupControlNumber"
  >,
): boolean {
  const differs = (recorded: string | null, sealedValue: string | undefined) =>
    recorded !== null && recorded !== (sealedValue ?? null);
  return (
    differs(stage.interchangeSenderCode, sealed.interchangeSenderCode) ||
    differs(stage.interchangeReceiverCode, sealed.interchangeReceiverCode) ||
    differs(stage.functionalGroupControlNumber, sealed.functionalGroupControlNumber)
  );
}

/**
 * The ownership evidence codes a staged Claim.MD ERA carries. `stageVerifiedClaimMdEra` seals them as
 * `source_evidence = { codes: [...] }`; this is the one reader of that shape (the posting plan's ownership
 * gate and the payee-identity evidence of a posted advice).
 */
export function stageEvidenceCodes(sourceEvidence: unknown): string[] {
  const codes =
    sourceEvidence !== null && typeof sourceEvidence === "object"
      ? (sourceEvidence as { codes?: unknown }).codes
      : undefined;
  return Array.isArray(codes)
    ? codes.filter((code): code is string => typeof code === "string")
    : [];
}

/**
 * Non-sensitive `payee_identity_evidence` for an advice posted from a staged Claim.MD ERA. The executor
 * supplies the fresh verification time and TIN result after rechecking the current owner identity in the
 * posting transaction. The evidence also carries the stage's non-sensitive ownership codes, never an NPI
 * or TIN value.
 */
export function claimMdStagePayeeIdentityEvidence(input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly sourceEvidence: unknown;
  readonly verifiedAt: Date | string;
  readonly tinVerified?: boolean | null;
}) {
  const evidenceCodes = stageEvidenceCodes(input.sourceEvidence);
  return {
    version: 1,
    method: "npi",
    source: "claimmd_stage",
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    payerProgram: "commercial",
    tinVerified:
      input.tinVerified === undefined
        ? evidenceCodes.includes("PAYEE_TIN_CONFIRMED")
          ? true
          : null
        : input.tinVerified,
    evidenceCodes,
    verifiedAt: new Date(input.verifiedAt).toISOString(),
  };
}
