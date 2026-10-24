// apps/backend/src/modules/25-remittance/routes/denial-payer.ts - M25 milestone 11a-1: the ONE payer check every path that
// opens a Medicare appeal tier goes through (createAppeal, the next-tier spawn on an unfavorable decision, the QIC->ALJ
// escalation). The payer is recorded on the remittance advice; a denial with no linked line (277CA / EVV) falls back to its
// claim: a claim that M23 does not know but M24 does is a Medicaid claim. A seam failure on that fallback is logged and
// leaves the payer unknown (today's behaviour), never a refusal.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { type DenialPayerKind, denialPayerKind } from "../domain";
import { medicaidClaimContext } from "./medicaid-claim-facts";
import { m23ClaimFactsPort } from "./remittance-ports";

export interface DenialPayerDeps {
  /** Does M23 know this claim id? (default: the M23 claim repository on the caller's tx) */
  readonly m23HasClaim?: (tx: unknown, claimId: string) => Promise<boolean>;
  /** Does M24 know this claim id? (default: the M24 seam, org-explicit) */
  readonly m24HasClaim?: (organizationId: string, claimId: string) => Promise<boolean>;
}

const defaultM23 = async (tx: unknown, claimId: string) =>
  (await m23ClaimFactsPort.byId(tx, claimId)) !== null;
const defaultM24 = async (organizationId: string, claimId: string) =>
  (await medicaidClaimContext(organizationId, claimId)) !== null;

export async function resolveDenialPayer(
  tx: unknown,
  organizationId: string,
  denialCaseId: string,
  deps: DenialPayerDeps = {},
): Promise<DenialPayerKind> {
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const DC = schema.denialCase;
  // biome-ignore lint/suspicious/noExplicitAny: the drizzle tx handle is passed through opaque
  const rows = await (tx as any)
    .select({ adviceKind: RA.payerKind, claimId: DC.claimId })
    .from(DC)
    .leftJoin(RL, eq(RL.id, DC.remittanceLineId))
    .leftJoin(RA, eq(RA.id, RL.remittanceAdviceId))
    .where(eq(DC.id, denialCaseId))
    .limit(1);
  const row = rows[0] as { adviceKind: string | null; claimId: string | null } | undefined;
  const fromAdvice = denialPayerKind({ adviceKind: row?.adviceKind });
  if (fromAdvice !== "unknown" || !row?.claimId) return fromAdvice;
  try {
    if (await (deps.m23HasClaim ?? defaultM23)(tx, row.claimId)) return "unknown";
    return (await (deps.m24HasClaim ?? defaultM24)(organizationId, row.claimId))
      ? "medicaid"
      : "unknown";
  } catch {
    // already logged by medicaidClaimContext; keep today's behaviour for an unknown payer
    return "unknown";
  }
}

/** Medicare appeal tiers are the CMS chain; a Medicaid denial follows the state's path (not built yet). */
export async function assertNotMedicaidDenial(
  tx: unknown,
  organizationId: string,
  denialCaseId: string,
  deps?: DenialPayerDeps,
): Promise<void> {
  if ((await resolveDenialPayer(tx, organizationId, denialCaseId, deps)) === "medicaid") {
    throw new ChartWardenError(
      "PAYER_IS_MEDICAID",
      "this is a Medicaid denial: Medicare appeal tiers do not apply, and the Medicaid appeal path is not available yet",
      422,
    );
  }
}
