// apps/backend/src/modules/28-fhir/routes/client-baa-ops.ts — GAP-083 follow-up: make the fail-closed BAA
// gate operable. The admin routes call these so a client can never be created or activated that cannot
// mint, an operator can list which partners are affected, and a malformed ip allowlist is a 422 instead of
// a silent lock-out. Pure over the M40 port, so every rule is unit-testable without a route harness.
import { DegradedError, ValidationError } from "@chartwarden/types";

import type { FhirBaaStatusView } from "../seams/index";
import {
  BAA_NOT_IN_FORCE_CODE,
  type FhirBaaStatus,
  baaStatusOf,
  isValidIpAllowlistEntry,
} from "./client-gates";

export type BaaPort = Pick<FhirBaaStatusView, "isBaaActive"> | undefined;

/** Refuse (4xx) unless the reference resolves to an in-force M40 contract AT THIS INSTANT. */
export async function assertBaaInForceForClient(
  baa: BaaPort,
  input: { organizationId: string; contractReference: string; asOf: string },
): Promise<void> {
  const status = await baaStatusOf(baa, input);
  if (status === "in_force") return;
  if (status === "unknown") {
    // Fail closed, but do not blame the partner's reference for an M40 outage.
    throw new DegradedError("M40 BAA status", "the BAA could not be verified; retry shortly");
  }
  throw new ValidationError("the BAA contract reference does not resolve to an in-force contract", [
    {
      field: "baaContractReference",
      code: BAA_NOT_IN_FORCE_CODE,
      message: "no active M40 contract matches this reference as of now",
    },
  ]);
}

/** Additively annotate registry rows with a server-derived `baaStatus` (one seam call per distinct reference). */
export async function withBaaStatus<T extends { baaContractReference: string }>(
  baa: BaaPort,
  organizationId: string,
  rows: readonly T[],
  asOf: string,
): Promise<ReadonlyArray<T & { readonly baaStatus: FhirBaaStatus }>> {
  const refs = [...new Set(rows.map((r) => r.baaContractReference))];
  const statuses = new Map<string, FhirBaaStatus>(
    await Promise.all(
      refs.map(
        async (ref) =>
          [ref, await baaStatusOf(baa, { organizationId, contractReference: ref, asOf })] as const,
      ),
    ),
  );
  return rows.map((r) => ({ ...r, baaStatus: statuses.get(r.baaContractReference) ?? "unknown" }));
}

/** 422 unless every entry is an IPv4/IPv6 address or CIDR; returns the trimmed list. */
export function parseIpAllowlist(entries: readonly string[] | undefined): string[] {
  const list = entries ?? [];
  const bad = list.filter((e) => !isValidIpAllowlistEntry(e));
  if (bad.length > 0) {
    throw new ValidationError("ipAllowlist contains entries that are not an IP address or CIDR", [
      {
        field: "ipAllowlist",
        code: "INVALID_IP_ALLOWLIST_ENTRY",
        message: `invalid: ${bad.join(", ")}`,
      },
    ]);
  }
  return list.map((e) => e.trim());
}

export interface FhirBaaCoverage {
  readonly orgsChecked: number;
  readonly orgsFailed: number;
  readonly activeClients: number;
  readonly notInForce: number;
  readonly unknown: number;
}

/** Count active clients whose BAA does not resolve, across orgs. A per-org failure is counted, not thrown. */
export async function sampleFhirBaaCoverage(deps: {
  readonly listOrgs: () => Promise<ReadonlyArray<{ organizationId: string }>>;
  readonly activeClientRefs: (organizationId: string) => Promise<readonly string[]>;
  readonly baa: BaaPort;
  readonly now: () => string;
}): Promise<FhirBaaCoverage> {
  const orgs = await deps.listOrgs();
  let orgsFailed = 0;
  let activeClients = 0;
  let notInForce = 0;
  let unknown = 0;
  for (const { organizationId } of orgs) {
    try {
      const rows = (await deps.activeClientRefs(organizationId)).map((r) => ({
        baaContractReference: r,
      }));
      const annotated = await withBaaStatus(deps.baa, organizationId, rows, deps.now());
      activeClients += annotated.length;
      notInForce += annotated.filter((r) => r.baaStatus === "not_in_force").length;
      unknown += annotated.filter((r) => r.baaStatus === "unknown").length;
    } catch {
      orgsFailed += 1;
    }
  }
  return { orgsChecked: orgs.length, orgsFailed, activeClients, notInForce, unknown };
}

export interface FhirBaaGapLog {
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
}

/** Boot/readiness warning: never throws, never blocks boot. */
export async function warnOnFhirBaaGap(
  sampler: () => Promise<FhirBaaCoverage | null>,
  log: FhirBaaGapLog,
): Promise<void> {
  let sample: FhirBaaCoverage | null = null;
  try {
    sample = await sampler();
  } catch {
    sample = null;
  }
  if (!sample || sample.orgsFailed > 0) {
    log.warn(
      { sample },
      "GAP-083: FHIR client BAA coverage could not be fully measured (needs DATABASE_PLATFORM_URL); some active partners may be failing to mint",
    );
    return;
  }
  const affected = sample.notInForce + sample.unknown;
  if (affected > 0) {
    log.warn(
      {
        activeClients: sample.activeClients,
        notInForce: sample.notInForce,
        unknown: sample.unknown,
        orgsChecked: sample.orgsChecked,
      },
      `GAP-083: ${affected} active FHIR client(s) have a BAA that does not resolve to an in-force M40 contract — ` +
        `they get 401 ${BAA_NOT_IN_FORCE_CODE} on token mint and reads. Filter GET /api/v1/fhir/clients on baaStatus to find them.`,
    );
    return;
  }
  log.info(
    { activeClients: sample.activeClients, orgsChecked: sample.orgsChecked },
    "GAP-083: every active FHIR client has an in-force BAA",
  );
}
