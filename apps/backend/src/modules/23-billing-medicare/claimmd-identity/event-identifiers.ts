import type { ClaimMdIdentityEvent } from "./resolve";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (row: Rec, key: string): string | null =>
  typeof row[key] === "string" && (row[key] as string).trim() ? (row[key] as string).trim() : null;

/** Extracts only documented identity fields from one retained encrypted source page. Never logs or persists TIN. */
export function claimMdIdentityFromCapturedPage(input: {
  readonly body: unknown;
  readonly parentIndex: number;
  readonly messageIndex: number;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly responseId: string | null;
}): ClaimMdIdentityEvent | null {
  if (!isRec(input.body)) return null;
  const root = isRec(input.body.result) ? input.body.result : input.body;
  const parents = Array.isArray(root.claim)
    ? root.claim
    : root.claim === undefined
      ? []
      : [root.claim];
  const parent = parents[input.parentIndex];
  if (!isRec(parent)) return null;
  const messages = Array.isArray(parent.messages)
    ? parent.messages
    : parent.messages === undefined
      ? []
      : [parent.messages];
  const message = input.messageIndex < 0 ? null : messages[input.messageIndex];
  if (input.messageIndex >= 0 && !isRec(message)) return null;
  return {
    accountReference: input.accountReference,
    usage: input.usage,
    responseId: input.responseId,
    claimMdClaimId: field(parent, "claimmd_id"),
    remoteClaimId: field(parent, "remote_claimid"),
    claimId: field(parent, "claimid"),
    fileId: field(parent, "fileid"),
    batchId: field(parent, "batchid"),
    pcn: field(parent, "pcn"),
    billingNpi: field(parent, "bill_npi"),
    billingTin: field(parent, "bill_taxid"),
    payerId: field(parent, "payerid"),
    claimType: field(parent, "claim_form"),
    serviceFrom: field(parent, "fdos"),
    serviceTo: field(parent, "tdos"),
  };
}
