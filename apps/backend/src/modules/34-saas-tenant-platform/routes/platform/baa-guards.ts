// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-guards.ts - what a platform BAA register write must
// satisfy, shared by the Drizzle service and its in-memory twin so the two cannot drift.
import { ChartWardenError } from "@chartwarden/types";
import { pickGoverningBaa } from "./activation-guards";

/**
 * An `executed` BAA must point at its executed document (the M22 document id of the signed PDF). The go-live BAA guard reads
 * the register's STATUS: without this, one operator could mark a BAA executed on their own word and the status alone would
 * satisfy the guard. 422 BAA_DOCUMENT_REQUIRED. Judged on the row AS IT WILL BE after the write.
 */
export function assertExecutedBaaHasDocument(input: {
  readonly baaStatus: string;
  readonly documentId: string | null | undefined;
}): void {
  if (input.baaStatus === "executed" && !input.documentId) {
    throw new ChartWardenError(
      "BAA_DOCUMENT_REQUIRED",
      "an executed BAA must reference its executed document (documentId): upload the signed agreement and link it",
      422,
      [
        {
          field: "documentId",
          code: "BAA_DOCUMENT_REQUIRED",
          message: "documentId is required when baaStatus is executed",
        },
      ],
    );
  }
}

/**
 * Whether an UPDATE must judge the record's document link: when the link changes or the record becomes executed. Never on an unrelated
 * edit (the expiry of an executed row whose legacy link predates the check), so such a row stays correctable; a legacy link still proves
 * nothing, because go-live and step 3 judge the governing record's document themselves (`governingBaaDocumentFiled`).
 */
export function baaLinkNeedsJudging(
  existing: { readonly baaStatus: string; readonly documentId: string | null },
  args: { readonly baaStatus?: string; readonly documentId?: string },
): boolean {
  const linkChanges = args.documentId !== undefined && args.documentId !== existing.documentId;
  const becomesExecuted = args.baaStatus === "executed" && existing.baaStatus !== "executed";
  return linkChanges || becomesExecuted;
}

/** The check M22 provides, bound to one transaction (or, for the in-memory twin, to its own stand-in). */
export type BaaDocumentCheck = (ref: {
  readonly organizationId: string;
  readonly documentId: string;
}) => Promise<boolean>;

/**
 * Whether a governing BAA's document verifies: a document id that `isFiled` accepts for the BAA's own organization (a `tenant_baa` row in
 * it). The ONE statement of the rule go-live rests on, shared by the status route's activation event, the wizard's go-live guard and the
 * onboarding advance (step 3): an `executed` status over a link that does not verify, or over no link, is not an executed BAA.
 */
export async function governingBaaDocumentFiled(
  governing: { readonly organizationId: string; readonly documentId: string | null },
  isFiled: BaaDocumentCheck,
): Promise<boolean> {
  if (governing.documentId === null) return false;
  return isFiled({ organizationId: governing.organizationId, documentId: governing.documentId });
}

/**
 * The document a BAA record links must be a signed BAA filed FOR THIS TENANT: a `tenant_baa` document row in the record's own
 * organization, judged on the same transaction that writes the record (`isFiled` is bound to it). Any other id (another tenant's document, a
 * document of another kind, an id that is no document) is a 422 BAA_DOCUMENT_INVALID, so an `executed` status can never rest on a link
 * that proves nothing. No document id: nothing to judge here (`assertExecutedBaaHasDocument` makes one mandatory for an executed record).
 * No check bound while an id is being linked: 503, never a silent accept. Shared by the Drizzle service and its in-memory twin.
 */
export async function assertBaaDocumentFiled(
  isFiled: BaaDocumentCheck | undefined,
  input: { readonly organizationId: string; readonly documentId: string | null | undefined },
): Promise<void> {
  if (!input.documentId) return;
  if (!isFiled) {
    throw new ChartWardenError(
      "BAA_DOCUMENTS_UNBOUND",
      "the BAA document adapter is not bound in this deployment, so the link cannot be checked",
      503,
    );
  }
  const filed = await isFiled({
    organizationId: input.organizationId,
    documentId: input.documentId,
  });
  if (filed) return;
  throw new ChartWardenError(
    "BAA_DOCUMENT_INVALID",
    "documentId must be the signed BAA uploaded for this tenant",
    422,
    [
      {
        field: "documentId",
        code: "BAA_DOCUMENT_INVALID",
        message: "documentId is not a signed BAA filed for this tenant",
      },
    ],
  );
}

/** What the register list says of each record: whether it governs its tenant, and (the governing one only) whether its document verifies. */
export interface GoverningFacts {
  readonly governing: boolean;
  /** M22's check on the governing record's link (no link: false); null for a record that does not govern, or with no check bound. */
  readonly documentFiled: boolean | null;
}

/**
 * The same judgment go-live and step 3 make, for the register list: per tenant, `pickGoverningBaa` over the tenant's rows IN REGISTER ORDER
 * (`executed_on DESC, id DESC`; its fallback takes the first row), and `governingBaaDocumentFiled` on the governing row. So the console
 * shows the facts of the record the server judges, not a record of its own choosing.
 */
export async function governingFactsOf<
  T extends {
    readonly id: string;
    readonly tenantAccountId: string;
    readonly organizationId: string;
    readonly baaStatus: string;
    readonly executedOn: string | null;
    readonly expiresOn: string | null;
    readonly documentId: string | null;
  },
>(rows: readonly T[], isFiled: BaaDocumentCheck | undefined): Promise<Map<string, GoverningFacts>> {
  const byTenant = new Map<string, T[]>();
  for (const r of rows)
    byTenant.set(r.tenantAccountId, [...(byTenant.get(r.tenantAccountId) ?? []), r]);
  const facts = new Map<string, GoverningFacts>(
    rows.map((r) => [r.id, { governing: false, documentFiled: null }]),
  );
  for (const tenantRows of byTenant.values()) {
    const governing = pickGoverningBaa(tenantRows);
    if (!governing) continue;
    facts.set(governing.id, {
      governing: true,
      documentFiled: isFiled ? await governingBaaDocumentFiled(governing, isFiled) : null,
    });
  }
  return facts;
}
