// apps/backend/src/modules/23-billing-medicare/services/dde-queue-subject.ts — what a DDE work item points at: the
// subject facts a new item copies, the keying sheet an operator (or a provider) is given, and the control number of
// the subject. Ids, dates and codes only; never an MBI. Reads run on the caller's org-scoped transaction (RLS).
import {
  type DdeItemType,
  type DdeKeyingProvider,
  type DdeKeyingSheet,
  buildDdeKeyingSheet,
  repositories,
} from "@chartwarden/billing";
import { ConflictError, NotFoundError } from "@chartwarden/types";
import type { BillingTx } from "./claim-state-service";

type Item = repositories.DdeWorkItemRecord;

/** The subject a new item acts on, resolved server-side (the body never names the provider entity). */
export interface SubjectFacts {
  readonly subjectKind: Item["subjectKind"];
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly deadlineAt: string | null;
}

export async function loadSubject(
  tx: BillingTx,
  organizationId: string,
  itemType: DdeItemType,
  subjectId: string,
): Promise<SubjectFacts> {
  if (itemType === "noe" || itemType === "notr") {
    const notice =
      itemType === "noe"
        ? await new repositories.NoeRepository(tx).findById(subjectId)
        : await new repositories.NotrRepository(tx).findById(subjectId);
    if (!notice || notice.organizationId !== organizationId) throw new NotFoundError(itemType);
    if (notice.state === "ack_accepted" || notice.state === "cancelled") {
      throw new ConflictError(
        `the ${itemType} is already ${notice.state}; there is nothing to key`,
      );
    }
    return {
      subjectKind: itemType === "noe" ? "noe_record" : "notr_record",
      providerEntityId: notice.providerEntityId,
      patientId: notice.patientId,
      deadlineAt: notice.windowTargetAt,
    };
  }
  const claim = await new repositories.ClaimRepository(tx).findById(subjectId);
  if (!claim || claim.organizationId !== organizationId) throw new NotFoundError("claim");
  return {
    subjectKind: "claim",
    providerEntityId: claim.providerEntityId,
    patientId: claim.patientId,
    deadlineAt: null,
  };
}

/** Keep only code-shaped strings from a stored ack payload (they were sanitised on the way in; belt and braces). */
function codesOf(payload: unknown): string[] {
  const raw = (payload as { reasonCodes?: unknown } | null)?.reasonCodes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9:._-]{1,24}$/.test(c));
}

/**
 * Read-only provider-identifier seam (#765): the provider entity's CCN and billing NPI, resolved on the caller's
 * org-scoped transaction. `provider_entity` is an M1 table M23 may not import, so the composition root binds this.
 * Null when the entity is absent or belongs to another org. No beneficiary identifier ever passes through it.
 */
export type DdeProviderIdentityReader = (
  tx: BillingTx,
  organizationId: string,
  providerEntityId: string,
) => Promise<{ readonly ccn: string; readonly npi: string } | null>;

/**
 * The DDE keying sheet for an item's subject (ids, dates and codes only; never an MBI). Org-scoped by RLS.
 * `readProvider` unbound (absent) or unresolved => the sheet simply has no Provider CCN / Billing NPI fields.
 */
export async function loadKeyingSheet(
  tx: BillingTx,
  item: Item,
  readProvider?: DdeProviderIdentityReader,
): Promise<DdeKeyingSheet> {
  const provider = readProvider
    ? await readProvider(tx, item.organizationId, item.providerEntityId)
    : null;
  return loadSubjectSheet(tx, item, provider);
}

async function loadSubjectSheet(
  tx: BillingTx,
  item: Item,
  provider: DdeKeyingProvider | null,
): Promise<DdeKeyingSheet> {
  if (item.subjectKind === "claim") {
    const claim = await new repositories.ClaimRepository(tx).findById(item.subjectId);
    if (!claim || claim.organizationId !== item.organizationId) {
      return buildDdeKeyingSheet(item.itemType, {});
    }
    const acks = await new repositories.ClaimAcknowledgmentRepository(tx).listForClaim(claim.id, {
      limit: 10,
    });
    const rejected = acks.find((a) => a.stage === "payer" && a.outcomeStatus === "rejected");
    return buildDdeKeyingSheet(item.itemType, {
      claim: {
        tob: String(claim.tob),
        serviceFrom: claim.serviceFrom,
        serviceTo: claim.serviceTo,
        controlNumber: claim.claimControlNumber,
        payerControlNumber: claim.payerClaimControlNumber,
        patientStatusCode: claim.patientStatusCode,
        admissionTypeCode: claim.admissionTypeCode,
        admissionSourceCode: claim.admissionSourceCode,
        rejectionCodes: rejected ? codesOf(rejected.parsedPayload) : [],
      },
      provider,
    });
  }
  const isNoe = item.subjectKind === "noe_record";
  const notice = isNoe
    ? await new repositories.NoeRepository(tx).findById(item.subjectId)
    : await new repositories.NotrRepository(tx).findById(item.subjectId);
  if (!notice || notice.organizationId !== item.organizationId) {
    return buildDdeKeyingSheet(item.itemType, {});
  }
  const base = {
    kind: isNoe ? ("noe" as const) : ("notr" as const),
    windowTargetAt: notice.windowTargetAt,
    rejectionCodes: notice.rejectionCodes ?? [],
  };
  return buildDdeKeyingSheet(item.itemType, {
    notice:
      "noeControlNumber" in notice
        ? {
            ...base,
            controlNumber: notice.noeControlNumber,
            payerControlNumber: notice.payerNoeControlNumber,
            effectiveDate: notice.electionEffectiveDate,
          }
        : {
            ...base,
            controlNumber: notice.notrControlNumber,
            payerControlNumber: notice.payerNotrControlNumber,
            effectiveDate: notice.effectiveEndDate,
          },
    provider,
  });
}

/** Our control number of the item's subject (the business key a provider operation is about), or null if it is gone. */
export async function loadControlNumber(tx: BillingTx, item: Item): Promise<string | null> {
  if (item.subjectKind === "claim") {
    const claim = await new repositories.ClaimRepository(tx).findById(item.subjectId);
    return claim && claim.organizationId === item.organizationId ? claim.claimControlNumber : null;
  }
  if (item.subjectKind === "noe_record") {
    const noe = await new repositories.NoeRepository(tx).findById(item.subjectId);
    return noe && noe.organizationId === item.organizationId ? noe.noeControlNumber : null;
  }
  const notr = await new repositories.NotrRepository(tx).findById(item.subjectId);
  return notr && notr.organizationId === item.organizationId ? notr.notrControlNumber : null;
}
