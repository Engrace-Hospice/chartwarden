// apps/backend/src/modules/25-remittance/routes/denial-payer.ts - M25 milestone 11a-1: the ONE payer check every path that
// opens a Medicare appeal tier goes through (createAppeal, the next-tier spawn on an unfavorable decision, the QIC->ALJ
// escalation). The payer is recorded on the remittance advice; a denial with no linked line (277CA / EVV) falls back to its
// claim: a claim that M23 does not know but M24 does is a Medicaid claim. A seam failure on that fallback is logged and
// leaves the payer unknown (today's behaviour), never a refusal.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { repositories } from "@chartwarden/billing";
import { type DenialPayerKind, denialPayerKind, resolvePayerKind } from "../domain";
import { medicaidClaimContext, medicaidClaimIdSet } from "./medicaid-claim-facts";

/** Most claim ids one batch looks up: a worklist page (the list limit is at most this). */
const PAYER_BATCH_CAP = 200;
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
  const adviceKind = row?.adviceKind;
  if (denialPayerKind({ adviceKind }) !== "unknown" || !row?.claimId) {
    return resolvePayerKind({ adviceKind, m23KnowsClaim: false, m24KnowsClaim: false });
  }
  try {
    const m23KnowsClaim = await (deps.m23HasClaim ?? defaultM23)(tx, row.claimId);
    const m24KnowsClaim =
      !m23KnowsClaim && (await (deps.m24HasClaim ?? defaultM24)(organizationId, row.claimId));
    return resolvePayerKind({ adviceKind, m23KnowsClaim, m24KnowsClaim });
  } catch {
    // already logged by medicaidClaimContext; keep today's behaviour for an unknown payer
    return "unknown";
  }
}

export interface PayerRow {
  readonly key: string;
  readonly adviceKind: string | null;
  readonly claimId: string | null;
}

export interface PayerBatchDeps {
  /** Which of these claim ids does M23 know? (default: one query on the caller's tx) */
  readonly m23ExistingIds?: (
    tx: unknown,
    claimIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** Which of these claim ids are this org's M24 claims? (default: the M24 seam, one call, never throws) */
  readonly m24ClaimIds?: (
    organizationId: string,
    claimIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

const defaultM23Batch = async (tx: unknown, claimIds: readonly string[]) =>
  new repositories.ClaimRepository(
    tx as ConstructorParameters<typeof repositories.ClaimRepository>[0],
  ).existingIds(claimIds);

/**
 * The payer of a page of denials for the READ MODEL (badge / action), by the same decision as the guard
 * ({@link resolvePayerKind}) but with batched lookups: only rows whose advice payer is unknown and that carry a claim
 * id are looked up, M23 once and M24 once (only for the ids M23 does not know), whatever the page size. A lookup failure
 * is logged and leaves those rows `unknown`: a badge never turns a list or detail into an error.
 */
export async function resolvePayerKinds(
  tx: unknown,
  organizationId: string,
  rows: readonly PayerRow[],
  deps: PayerBatchDeps = {},
): Promise<Map<string, DenialPayerKind>> {
  const candidates = rows.filter(
    (r) => denialPayerKind({ adviceKind: r.adviceKind }) === "unknown" && r.claimId,
  );
  const ids = [...new Set(candidates.map((r) => r.claimId as string))].slice(0, PAYER_BATCH_CAP);
  let m23Known: ReadonlySet<string> = new Set();
  let m24Known: ReadonlySet<string> = new Set();
  if (ids.length > 0) {
    try {
      m23Known = await (deps.m23ExistingIds ?? defaultM23Batch)(tx, ids);
      const misses = ids.filter((id) => !m23Known.has(id));
      m24Known = await (deps.m24ClaimIds ?? medicaidClaimIdSet)(organizationId, misses);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "m25 payer batch lookup failed; payer stays unknown",
          organizationId,
          claimCount: ids.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      m23Known = new Set(ids); // M23 failed: say nothing about M24 (every candidate reads unknown)
      m24Known = new Set();
    }
  }
  return new Map(
    rows.map((r) => [
      r.key,
      resolvePayerKind({
        adviceKind: r.adviceKind,
        m23KnowsClaim: r.claimId ? m23Known.has(r.claimId) : false,
        m24KnowsClaim: r.claimId ? m24Known.has(r.claimId) : false,
      }),
    ]),
  );
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
