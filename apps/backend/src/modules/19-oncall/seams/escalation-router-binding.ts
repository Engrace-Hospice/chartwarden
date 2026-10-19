// apps/backend/src/modules/19-oncall/seams/escalation-router-binding.ts - how the real EscalationRouter is (not) bound (ADR-0057 item 12).
//
// UNBOUND BY DEFAULT. `registerOncallSeams` does not register the router. This file registers it only when
// `ESCALATION_ROUTER_ORGS` (comma-separated organization uuids) names at least one org, and even then the registered seam answers the
// real router for those orgs only; every other org gets EXACTLY what the seam held before (the deny-stub: `unavailable /
// router_not_bound`, source `deny_stub`). Empty or unset = nothing is registered = today's behaviour, boot probe warning included.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type { EscalationRouter, OncallModel, PatientReader } from "@wardenx/types";
import { eq } from "drizzle-orm";
import type { FoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import { registerSeam } from "../../../bootstrap/index";
import {
  type EscalationRouterReads,
  UUID_PATTERN,
  createEscalationRouter,
} from "./escalation-router";
import type { OncallSeamOrgResolver } from "./providers";
import type { OncallSeamStore } from "./store";

export interface EscalationRouterAllowlist {
  readonly orgIds: ReadonlySet<string>;
  /** How many entries were not a uuid and were ignored (a count only: the values are never logged). */
  readonly ignoredCount: number;
}

/** Strict parse of `ESCALATION_ROUTER_ORGS`: comma-separated uuids, lower-cased; anything else is ignored and counted. */
export function parseEscalationRouterOrgs(raw: string | undefined): EscalationRouterAllowlist {
  const entries = (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const valid = entries.filter((e) => UUID_PATTERN.test(e)).map((e) => e.toLowerCase());
  return { orgIds: new Set(valid), ignoredCount: entries.length - valid.length };
}

/** The real router for allowlisted orgs, `fallback` (the seam's previous occupant) for everyone else. */
export function createAllowlistedEscalationRouter(
  real: EscalationRouter,
  fallback: EscalationRouter,
  orgIds: ReadonlySet<string>,
): EscalationRouter {
  return {
    resolveTier: (orgId, request) =>
      (orgIds.has(String(orgId).toLowerCase()) ? real : fallback).resolveTier(orgId, request),
  };
}

export interface EscalationRouterBindingDeps {
  readonly store: OncallSeamStore;
  readonly reads: EscalationRouterReads;
  readonly orgOf?: OncallSeamOrgResolver;
  /** The answer for every org not on the allowlist: pass the boot deny-stub itself, never a registry lookup (it would resolve to the wrapper). */
  readonly fallback: EscalationRouter;
  /** `process.env.ESCALATION_ROUTER_ORGS`. */
  readonly allowlistRaw: string | undefined;
  readonly warn?: (message: string) => void;
}

/** Register the allowlisted router over the seam's current occupant. Returns the orgs bound (empty = nothing registered). */
export function registerEscalationRouterForAllowlist(
  deps: EscalationRouterBindingDeps,
): ReadonlySet<string> {
  const { orgIds, ignoredCount } = parseEscalationRouterOrgs(deps.allowlistRaw);
  if (ignoredCount > 0) {
    deps.warn?.(
      `ESCALATION_ROUTER_ORGS: ${ignoredCount} entr${ignoredCount === 1 ? "y is" : "ies are"} not a uuid and ignored`,
    );
  }
  if (orgIds.size === 0) return orgIds;
  deps.warn?.(
    `ESCALATION_ROUTER_ORGS: the M19 tier-1 EscalationRouter is bound for ${orgIds.size} org(s); every other org still gets the deny-stub`,
  );
  const real = createEscalationRouter(deps.store, deps.reads, deps.orgOf);
  registerSeam("EscalationRouter", createAllowlistedEscalationRouter(real, deps.fallback, orgIds));
  return orgIds;
}

export interface DrizzleEscalationReadsDeps {
  readonly db: DbClient;
  /** Resolved lazily: the M5 reader is registered after M19's seams. */
  readonly patientReader: () => PatientReader;
  readonly siteReader: Pick<FoundationSiteReader, "providerEntityTimezones">;
  readonly listProviderEntityIds: (organizationId: string) => Promise<readonly string[]>;
}

/** The production reads: M5's PatientReader, M1's site reader, and M19's own policy table, all under the caller's RLS scope. */
export function buildDrizzleEscalationRouterReads(
  deps: DrizzleEscalationReadsDeps,
): EscalationRouterReads {
  return {
    async patientProviderEntity(orgId, patientId) {
      const patient = await deps.patientReader().findById({ organizationId: orgId, id: patientId });
      if (patient === null || patient.organizationId !== orgId) return null;
      return { providerEntityId: patient.providerEntityId ?? null };
    },
    providerEntityIdsOfOrg: (orgId) => deps.listProviderEntityIds(orgId),
    async policyModel(providerEntityId) {
      return withOrgContextFromRequest(deps.db, async (tx) => {
        const [row] = await tx
          .select({ model: schema.tenantOncallPolicy.model })
          .from(schema.tenantOncallPolicy)
          .where(eq(schema.tenantOncallPolicy.providerEntityId, providerEntityId))
          .limit(1);
        return (row?.model ?? null) as OncallModel | null;
      });
    },
    timeZones: (providerEntityId) =>
      withOrgContextFromRequest(deps.db, (tx) =>
        deps.siteReader.providerEntityTimezones(tx as DbClient, providerEntityId),
      ),
  };
}
