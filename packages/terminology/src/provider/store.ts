// @chartwarden/terminology — the `TerminologyStore` data port + an in-memory slice default
// (M38-T05, spec §4.5).
//
// The `TerminologyProvider` seam (provider.ts) is PURE ORCHESTRATION: it composes the T04
// as-of resolution engine over rows this port returns. The port is the seam between the
// stable provider and the data layer — M38-T06/T07 implement it over the per-system Drizzle
// tables (+ Valkey cache), production injects that adapter, and the in-memory store here keeps
// the boot slice + unit tests free of live infra (the same injected-port pattern M2 uses for
// its published seams). The port returns DATA only; every as-of selection, membership-source
// decision, and FHIR shaping lives in the provider so that logic has one home.
//
// SCOPE (T05): this store answers from in-memory seed data with the minimal semantics the seam
// needs to be callable. The freshness-correct expansion (§7.5), add-only/never-weaken tenant
// extension validation (§7.6), annual deprecation remediation (§7.3), and golden FHIR
// projection (§7.9) are the Drizzle-backed store's job in T07/T09 — this default keeps them
// deliberately simple.

import { ChartWardenError } from "@chartwarden/types";
import type { CodeSystemId, ExpansionMember, ResolvedConcept } from "../interfaces/kinds";
import type {
  CodeSystemVersionWindow,
  DeprecationMappingResponse,
  SearchOptions,
} from "../interfaces/provider";
import { type ConceptCandidate, includesAsOf } from "../resolution";

/** Identity for a tenant value-set extension write (the only mutating path, §2.4.3). */
export interface TenantExtensionInput {
  readonly orgId: string;
  readonly valueSetId: string;
  readonly system: CodeSystemId;
  readonly code: string;
  readonly reason: string;
  readonly actorUserId: string;
}

/** FHIR projection metadata for a code system at a point in time (url + active version). */
export interface CodeSystemMeta {
  readonly url: string;
  readonly version: string;
  /**
   * The attribution/copyright text a licence requires to accompany the system's data (SNOMED CT, LOINC, RxNorm —
   * from the active `terminology_license_attestation`). Absent for public systems; surfaced as the FHIR
   * `CodeSystem.copyright` element.
   */
  readonly copyright?: string;
}

/**
 * The data-access boundary the {@link TerminologyProvider} composes over. Every method returns
 * raw rows / records; the provider applies as-of selection, membership provenance, and FHIR
 * shaping. Implemented in-memory below for the slice; over Drizzle in T06/T07.
 */
export interface TerminologyStore {
  /** All coexisting concept rows for one (system, code) — the as-of engine selects among them (§7.2). */
  conceptVersions<S extends CodeSystemId>(
    system: S,
    code: string,
  ): Promise<readonly ConceptCandidate<S>[]>;

  /** Flat candidate rows for many codes in one system (the lookupBatch hot path). */
  conceptVersionsBatch<S extends CodeSystemId>(
    system: S,
    codes: readonly string[],
  ): Promise<readonly ConceptCandidate<S>[]>;

  /** The deprecation successor mapping for a code, if any (§2.2). */
  deprecation(system: CodeSystemId, code: string): Promise<DeprecationMappingResponse | null>;

  /** Platform members of an expanded value set (tenant adds come from {@link tenantExtensionMembers}). */
  valueSetMembers(
    valueSetId: string,
    opts: { readonly asOfIso: string; readonly system?: CodeSystemId },
  ): Promise<readonly ExpansionMember[]>;

  /** A tenant's add-only extensions to a value set (§2.4.3; never-weaken validation is T07). */
  tenantExtensionMembers(orgId: string, valueSetId: string): Promise<readonly ExpansionMember[]>;

  /** Text-search candidates within a system (mode/semantic gating is T09 / the `ai.full` flag). */
  searchConcepts<S extends CodeSystemId>(
    system: S,
    q: string,
    opts: SearchOptions,
  ): Promise<ResolvedConcept<S>[]>;

  /** Record a tenant value-set extension; returns its id. */
  insertTenantExtension(input: TenantExtensionInput): Promise<{ extensionId: string }>;

  /** Remove a tenant value-set extension. */
  deleteTenantExtension(orgId: string, extensionId: string, actorUserId: string): Promise<void>;

  /**
   * Erase ALL of an org's `value_set_tenant_extension` rows (D8 tenant offboarding, §11) and
   * report the count removed. The ONLY tenant-attributable data M38 owns; platform reference
   * tables are never touched. Consumed by the M38 destruction eraser (T10).
   */
  eraseTenantExtensions(orgId: string): Promise<{ erased: number }>;

  /** Every active concept of a system at `asOf`, for the FHIR CodeSystem projection (§7.9). */
  codeSystemConcepts(
    system: CodeSystemId,
    asOfIso: string,
  ): Promise<readonly { readonly code: string; readonly display: string }[]>;

  /** Canonical url + active version for a code system at `asOf` (FHIR CodeSystem metadata). */
  codeSystemMeta(system: CodeSystemId, asOfIso: string): Promise<CodeSystemMeta>;

  /** Canonical url for a value set (FHIR ValueSet metadata). */
  valueSetMeta(valueSetId: string): Promise<{ url: string }>;

  /** F-238 — loaded releases of a system, oldest first. Optional (the in-memory slice has none). */
  listVersions?(system: CodeSystemId): Promise<readonly CodeSystemVersionWindow[]>;
}

/** Seed shape for {@link createInMemoryTerminologyStore} — all fields optional. */
export interface InMemoryTerminologySeed {
  /** Concept rows (across coexisting versions). The store groups by (system, code). */
  readonly concepts?: ReadonlyArray<ResolvedConcept<CodeSystemId>>;
  /** Deprecation mappings keyed for lookup by (system, code). */
  readonly deprecations?: ReadonlyArray<{ system: CodeSystemId } & DeprecationMappingResponse>;
  /** Platform value-set membership rows. */
  readonly valueSetMembers?: ReadonlyArray<{ valueSetId: string } & ExpansionMember>;
  /** Canonical code-system url/version, keyed by system. */
  readonly codeSystemMeta?: Partial<Record<CodeSystemId, CodeSystemMeta>>;
  /** Canonical value-set urls, keyed by value-set id. */
  readonly valueSetUrls?: Readonly<Record<string, string>>;
}

/** Compound map key. Used for both (system, code) and (orgId, valueSetId) — space-joined. */
function compoundKey(a: string, b: string): string {
  return `${a} ${b}`;
}

/**
 * An in-memory {@link TerminologyStore} for the boot slice + unit tests. Deterministic, no I/O.
 * Tenant extensions are held in a per-(org,valueSet) map, with a monotonically numbered id so
 * `addTenantExtension` is reproducible without a clock or randomness. Production replaces this
 * with the Drizzle-backed store (T06/T07).
 */
export function createInMemoryTerminologyStore(seed: InMemoryTerminologySeed = {}): {
  store: TerminologyStore;
} {
  const concepts = new Map<string, ResolvedConcept<CodeSystemId>[]>();
  for (const c of seed.concepts ?? []) {
    const k = compoundKey(c.systemId, c.code);
    (concepts.get(k) ?? concepts.set(k, []).get(k)!).push(c);
  }

  const deprecations = new Map<string, DeprecationMappingResponse>();
  for (const d of seed.deprecations ?? []) {
    const { system, ...mapping } = d;
    deprecations.set(compoundKey(system, mapping.deprecatedCode), mapping);
  }

  const platformMembers = new Map<string, ExpansionMember[]>();
  for (const m of seed.valueSetMembers ?? []) {
    const { valueSetId, ...member } = m;
    (platformMembers.get(valueSetId) ?? platformMembers.set(valueSetId, []).get(valueSetId)!).push(
      member,
    );
  }

  // Tenant extensions: key `${orgId} ${valueSetId}` → its members; internal extensionId per row.
  const tenantMembers = new Map<string, (ExpansionMember & { extensionId: string })[]>();
  let extensionSeq = 0;

  const store: TerminologyStore = {
    async conceptVersions<S extends CodeSystemId>(system: S, code: string) {
      return (concepts.get(compoundKey(system, code)) ?? []) as ConceptCandidate<S>[];
    },

    async conceptVersionsBatch<S extends CodeSystemId>(system: S, codes: readonly string[]) {
      const out: ResolvedConcept<CodeSystemId>[] = [];
      for (const code of codes) out.push(...(concepts.get(compoundKey(system, code)) ?? []));
      return out as ConceptCandidate<S>[];
    },

    async deprecation(system: CodeSystemId, code: string) {
      return deprecations.get(compoundKey(system, code)) ?? null;
    },

    async valueSetMembers(valueSetId, opts) {
      const members = platformMembers.get(valueSetId) ?? [];
      return opts.system ? members.filter((m) => m.systemId === opts.system) : members;
    },

    async tenantExtensionMembers(orgId, valueSetId) {
      const list = tenantMembers.get(compoundKey(orgId, valueSetId)) ?? [];
      // Strip the internal extensionId — the seam yields plain ExpansionMembers.
      return list.map(({ extensionId: _id, ...m }) => m);
    },

    async searchConcepts<S extends CodeSystemId>(system: S, q: string, opts: SearchOptions) {
      const needle = q.toLowerCase();
      let allowed: Set<string> | null = null;
      if (opts.inValueSet !== undefined) {
        const platform = platformMembers.get(opts.inValueSet);
        if (!platform) throw new ChartWardenError("NOT_FOUND", "value set not found", 404);
        const tenant = opts.orgId
          ? (tenantMembers.get(compoundKey(opts.orgId, opts.inValueSet)) ?? [])
          : [];
        allowed = new Set(
          [...platform, ...tenant].filter((m) => m.systemId === system).map((m) => m.code),
        );
      }
      const hits: ResolvedConcept<CodeSystemId>[] = [];
      for (const [k, rows] of concepts) {
        if (!k.startsWith(`${system} `)) continue;
        for (const row of rows) {
          if (opts.billableOnly && !isBillable(row)) continue;
          if (allowed && !allowed.has(row.code)) continue;
          const match =
            opts.mode === "exact"
              ? row.code.toLowerCase() === needle || row.display.toLowerCase() === needle
              : row.code.toLowerCase().includes(needle) ||
                row.display.toLowerCase().includes(needle);
          if (match) hits.push(row);
        }
      }
      const limited = opts.limit !== undefined ? hits.slice(0, opts.limit) : hits;
      return limited as ResolvedConcept<S>[];
    },

    async insertTenantExtension(input) {
      // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
      const extensionId = `vsext_${(extensionSeq += 1)}`;
      const k = compoundKey(input.orgId, input.valueSetId);
      const member: ExpansionMember & { extensionId: string } = {
        extensionId,
        systemId: input.system,
        code: input.code,
        display: input.code, // display resolves from the concept table in T07; code is the slice default.
        annotations: { source: "tenant_extension", reason: input.reason },
      };
      (tenantMembers.get(k) ?? tenantMembers.set(k, []).get(k)!).push(member);
      return { extensionId };
    },

    async deleteTenantExtension(orgId, extensionId) {
      for (const [k, list] of tenantMembers) {
        if (!k.startsWith(`${orgId} `)) continue;
        const next = list.filter((m) => m.extensionId !== extensionId);
        if (next.length !== list.length) tenantMembers.set(k, next);
      }
    },

    async eraseTenantExtensions(orgId) {
      let erased = 0;
      for (const [k, list] of tenantMembers) {
        if (!k.startsWith(`${orgId} `)) continue;
        erased += list.length;
        tenantMembers.delete(k);
      }
      return { erased };
    },

    async codeSystemConcepts(system, asOfIso) {
      const out: { code: string; display: string }[] = [];
      for (const [k, rows] of concepts) {
        if (!k.startsWith(`${system} `)) continue;
        for (const row of rows) {
          if (includesAsOf(row, asOfIso) && row.status !== "retired") {
            out.push({ code: row.code, display: row.display });
          }
        }
      }
      // Deterministic order for golden projection (§2.5) regardless of insertion order.
      out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      return out;
    },

    async codeSystemMeta(system) {
      return (
        seed.codeSystemMeta?.[system] ?? { url: `urn:wardenx:codesystem:${system}`, version: "0" }
      );
    },

    async valueSetMeta(valueSetId) {
      return { url: seed.valueSetUrls?.[valueSetId] ?? `urn:wardenx:valueset:${valueSetId}` };
    },
  };

  return { store };
}

/** `billableOnly`: ICD-10-CM needs the billable-leaf flag AND active; every other system means active. */
function isBillable(row: ResolvedConcept<CodeSystemId>): boolean {
  if (row.status !== "active") return false;
  if (row.systemId !== "icd10cm") return true;
  return (row.properties as { isBillableLeaf?: boolean }).isBillableLeaf === true;
}
