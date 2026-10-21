// @wardenx/terminology — the REAL `TerminologyProvider` (M38-T05, spec §4.5).
//
// This is the implementation that M38 registers into the M1 seam registry at boot — the read
// surface every clinical/billing/interop module consumes (M5/M7/M8/M9/M10/M11/M12/M13/M21/
// M23/M24/M27/M28/M29/M30). It is pure ORCHESTRATION over the injected {@link TerminologyStore}:
// the store returns rows, this provider applies the T04 as-of resolution engine, the
// status→validity mapping, membership provenance, and FHIR shaping — so that logic has exactly
// one home and cannot drift across consumers.
//
// Design invariant (§2.1.1): `asOf` is honored on every query; its only sugar is the default
// of "today". Each method normalizes `asOf` ONCE (via the T04 engine) and threads the ISO date
// down to the store, so a 2023 claim re-validated in 2025 resolves against the version active
// at the service date, never "valid now".
//
// SCOPE: the seam is whole and callable since T05. T07 lands the deep value-set behaviours behind
// this same interface — freshness-correct expansion §7.5, add-only/never-weaken tenant extensions
// §7.6 (the §7.10 422/409 gate, enforced in `addTenantExtension`/`expand` here). T09 makes the FHIR
// projection §7.9 GOLDEN-STABLE (deterministic (system, code) ordering on both `concept` and
// `contains`, byte-identical for the same (id, asOf)); the flag-gated semantic search §7.7 itself
// is gated at the route (`ai.full`) — the pgvector HNSW kNN lands in the Drizzle store.

import { ChartWardenError } from "@wardenx/types";
import {
  type TenantExtensionRefusal,
  classifyTenantExtension,
  unionTenantExtensions,
} from "../extensions";
import type {
  CodeSystemId,
  ExpansionMember,
  FhirCodeSystemProjection,
  FhirValueSetProjection,
  ResolvedConcept,
} from "../interfaces/kinds";
import type {
  DeprecationMappingResponse,
  ExpandOptions,
  MembershipOptions,
  MembershipResult,
  SearchOptions,
  TerminologyProvider,
  ValidateResult,
} from "../interfaces/provider";
import { normalizeAsOf, resolveAsOf, resolveBatchAsOf, toValidateResult } from "../resolution";
import type { TerminologyStore } from "./store";

/**
 * Map a refused tenant-extension add to its §7.10 HTTP error. The M1 error handler renders the
 * envelope; codes/statuses match the §7.10 edge-case table exactly (INVALID_CODE → 422 for an
 * unresolved/deprecated/retired code; REDUNDANT_EXTENSION → 409 for an existing platform member).
 */
function tenantExtensionError(
  refusal: TenantExtensionRefusal,
  system: CodeSystemId,
  code: string,
): ChartWardenError {
  if (refusal.outcome === "redundant") {
    return new ChartWardenError(
      "REDUNDANT_EXTENSION",
      `${system} '${code}' is already a platform member of this value set`,
      409,
    );
  }
  return new ChartWardenError(
    "INVALID_CODE",
    `${system} '${code}' cannot be added (${refusal.reason}); a tenant may only extend with an active code`,
    422,
  );
}

/**
 * Build the real {@link TerminologyProvider} over an injected {@link TerminologyStore}. The boot
 * slice passes the in-memory store; production passes the Drizzle/Valkey-backed store (T06/T07).
 */
export function createTerminologyProvider(store: TerminologyStore): TerminologyProvider {
  return {
    async validate(system, code, asOf) {
      const candidates = await store.conceptVersions(system, code);
      const resolved = resolveAsOf(candidates, asOf);
      // Only fetch the successor mapping when the resolved row is deprecated/retired — validate's
      // happy path (active code) stays a single store read.
      const needsSuccessor = resolved !== null && resolved.status !== "active";
      const deprecation = needsSuccessor ? await store.deprecation(system, code) : null;
      return toValidateResult(resolved, deprecation) satisfies ValidateResult;
    },

    async lookup<S extends CodeSystemId>(system: S, code: string, asOf?: Date) {
      const candidates = await store.conceptVersions(system, code);
      return resolveAsOf(candidates, asOf);
    },

    async lookupBatch<S extends CodeSystemId>(system: S, codes: readonly string[], asOf?: Date) {
      const candidates = await store.conceptVersionsBatch(system, codes);
      return resolveBatchAsOf(candidates, asOf);
    },

    async *expand(valueSetId, opts: ExpandOptions = {}): AsyncIterable<ExpansionMember> {
      const asOfIso = normalizeAsOf(opts.asOf);
      const platform = await store.valueSetMembers(valueSetId, { asOfIso, system: opts.system });
      // Platform-only expansion (§2.4.3 `includeTenantExtensions: false`) — exactly the canonical set.
      if (!opts.includeTenantExtensions) {
        for (const m of platform) yield m;
        return;
      }
      if (opts.orgId === undefined) {
        throw new Error("expand: includeTenantExtensions requires orgId (§4.5)");
      }
      const tenant = await store.tenantExtensionMembers(opts.orgId, valueSetId);
      const scoped = opts.system ? tenant.filter((m) => m.systemId === opts.system) : tenant;
      // §7.6 add-only union: the org's adds extend the platform set; a tenant row can never shadow
      // or relabel a platform member (platform annotations always win the collision).
      for (const m of unionTenantExtensions(platform, scoped)) yield m;
    },

    async isMemberOf(
      valueSetId: string,
      system: CodeSystemId,
      code: string,
      opts: MembershipOptions = {},
    ): Promise<MembershipResult> {
      const asOfIso = normalizeAsOf(opts.asOf);
      const platform = await store.valueSetMembers(valueSetId, { asOfIso, system });
      if (platform.some((m) => m.systemId === system && m.code === code)) {
        return { isMember: true, source: "platform" };
      }
      if (opts.orgId !== undefined) {
        const ext = await store.tenantExtensionMembers(opts.orgId, valueSetId);
        if (ext.some((m) => m.systemId === system && m.code === code)) {
          return { isMember: true, source: "tenant_extension" };
        }
      }
      return { isMember: false, source: null };
    },

    async searchByText<S extends CodeSystemId>(system: S, q: string, opts: SearchOptions = {}) {
      // Semantic mode rides the `ai.full` flag (Phase 2, §7.7); the route gate enforces that.
      // The store decides how to satisfy exact/fuzzy here.
      return store.searchConcepts(system, q, opts);
    },

    async getDeprecationMapping(
      system: CodeSystemId,
      code: string,
    ): Promise<DeprecationMappingResponse | null> {
      return store.deprecation(system, code);
    },

    async addTenantExtension(orgId, valueSetId, system, code, reason, actorUserId) {
      // §7.6 / §7.10 add-time gate, BEFORE any write: refuse an unresolved/deprecated/retired code
      // (INVALID_CODE 422) or one already in the platform set (REDUNDANT_EXTENSION 409). Validity is
      // resolved at TODAY — §2.5 "extension write checks lookup(code, system, today) returns active".
      const [candidates, platform] = await Promise.all([
        store.conceptVersions(system, code),
        store.valueSetMembers(valueSetId, { asOfIso: normalizeAsOf(), system }),
      ]);
      const resolved = resolveAsOf(candidates);
      const isPlatformMember = platform.some((m) => m.systemId === system && m.code === code);
      const outcome = classifyTenantExtension({ resolved, isPlatformMember });
      if (outcome.outcome !== "ok") throw tenantExtensionError(outcome, system, code);
      return store.insertTenantExtension({ orgId, valueSetId, system, code, reason, actorUserId });
    },

    async removeTenantExtension(orgId, extensionId, actorUserId) {
      await store.deleteTenantExtension(orgId, extensionId, actorUserId);
    },

    async listVersions(system) {
      return store.listVersions ? store.listVersions(system) : [];
    },

    async asFhirCodeSystem(system, asOf): Promise<FhirCodeSystemProjection> {
      const asOfIso = normalizeAsOf(asOf);
      const [concept, meta] = await Promise.all([
        store.codeSystemConcepts(system, asOfIso),
        store.codeSystemMeta(system, asOfIso),
      ]);
      return {
        resourceType: "CodeSystem",
        url: meta.url,
        version: meta.version,
        status: "active",
        content: "complete",
        ...(meta.copyright ? { copyright: meta.copyright } : {}),
        concept,
      };
    },

    async asFhirValueSet(
      valueSetId,
      opts: { asOf?: Date; orgId?: string } = {},
    ): Promise<FhirValueSetProjection> {
      const asOfIso = normalizeAsOf(opts.asOf);
      const [members, meta] = await Promise.all([
        store.valueSetMembers(valueSetId, { asOfIso }),
        store.valueSetMeta(valueSetId),
      ]);
      const tenant = opts.orgId ? await store.tenantExtensionMembers(opts.orgId, valueSetId) : [];
      const contains = [...members, ...tenant]
        .map((m) => ({ system: m.systemId, code: m.code, display: m.display }))
        // Stable (system, code) order so the projection is byte-identical for the same
        // (id, asOf) regardless of store/seed insertion order — the §7.9 golden invariant.
        .sort((a, b) =>
          a.system !== b.system
            ? a.system < b.system
              ? -1
              : 1
            : a.code < b.code
              ? -1
              : a.code > b.code
                ? 1
                : 0,
        );
      return {
        resourceType: "ValueSet",
        url: meta.url,
        status: "active",
        expansion: {
          // Deterministic for the same (id, asOf) so the §7.9 projection is golden-testable (§2.5).
          timestamp: `${asOfIso}T00:00:00Z`,
          total: contains.length,
          contains,
        },
      };
    },
  };
}
