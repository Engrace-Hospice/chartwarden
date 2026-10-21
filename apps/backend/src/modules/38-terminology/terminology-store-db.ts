// apps/backend/src/modules/38-terminology — PRODUCTION TerminologyStore over Drizzle (FB-T01).
//
// The `TerminologyProvider` seam (packages/terminology/src/provider/provider.ts) is pure
// orchestration over a `TerminologyStore` data port. The boot slice + unit tests inject the
// in-memory store; production injects THIS one, which reads the real M38 tables. Mirrors the M5
// pattern (`patient-route-service-db.ts`): a small factory that closes over the injected DbClient.
//
// RLS shape (M38-T03, §3.7): every M38 table is platform-shared reference (NON_ORG_SCOPED, read-all
// via the `USING (true)` policy) EXCEPT `value_set_tenant_extension`, the one org-scoped table. So
// the concept / value-set / deprecation READS run directly on the pooled `chartwarden_app` handle (no
// org context needed — the policy admits them), while the tenant-extension read/write/erase run
// inside `withOrgContext` so `app.org_id` RLS scopes them to the actor's tenant. Canonical writes
// stay impossible here — there is no INSERT/UPDATE/DELETE path to a platform table (§7.4 lockdown,
// enforced in depth by the absent `chartwarden_app` grant on those tables).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type CodeSystemId,
  type CodeSystemMeta,
  type ConceptCandidate,
  type DeprecationMappingResponse,
  type ExpansionMember,
  type ResolvedConcept,
  type SearchOptions,
  type TenantExtensionInput,
  type TerminologyStore,
  normalizeAsOf,
  resolveBatchAsOf,
} from "@chartwarden/terminology";
import { ChartWardenError } from "@chartwarden/types";
import {
  type SQL,
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/** The shared columns every per-system concept table carries (§2.3 one-table-per-system). */
interface ConceptCols {
  readonly table: PgTable;
  readonly code: PgColumn;
  readonly display: PgColumn;
  readonly status: PgColumn;
  readonly effective: PgColumn;
  readonly end: PgColumn;
}

/** The common-shape columns every per-system concept table carries (§2.3). */
function commonCols(t: {
  code: PgColumn;
  display: PgColumn;
  status: PgColumn;
  effectiveDate: PgColumn;
  endDate: PgColumn;
}): Omit<ConceptCols, "table"> {
  return {
    code: t.code,
    display: t.display,
    status: t.status,
    effective: t.effectiveDate,
    end: t.endDate,
  };
}

/**
 * The per-system concept tables (§2.3 one-table-per-system). icd10cm / snomed / loinc / rxnorm carry bespoke
 * columns; icd10pcs / ndc / hcpcs / cvx / revenue / carc / rarc (migration 0364, GAP-108) carry the common shape
 * only. `cms_hope` has no concept table (an instrument roster curated in M10), so its reads resolve to empty —
 * the same shape the in-memory slice gives an unseeded system.
 */
function conceptCols(system: CodeSystemId): ConceptCols | null {
  switch (system) {
    case "icd10cm":
      return { table: schema.conceptIcd10cm, ...commonCols(schema.conceptIcd10cm) };
    case "snomed":
      return { table: schema.conceptSnomed, ...commonCols(schema.conceptSnomed) };
    case "loinc":
      return { table: schema.conceptLoinc, ...commonCols(schema.conceptLoinc) };
    case "rxnorm":
      return { table: schema.conceptRxnorm, ...commonCols(schema.conceptRxnorm) };
    case "icd10pcs":
      return { table: schema.conceptIcd10pcs, ...commonCols(schema.conceptIcd10pcs) };
    case "ndc":
      return { table: schema.conceptNdc, ...commonCols(schema.conceptNdc) };
    case "hcpcs":
      return { table: schema.conceptHcpcs, ...commonCols(schema.conceptHcpcs) };
    case "cvx":
      return { table: schema.conceptCvx, ...commonCols(schema.conceptCvx) };
    case "revenue":
      return { table: schema.conceptRevenue, ...commonCols(schema.conceptRevenue) };
    case "carc":
      return { table: schema.conceptCarc, ...commonCols(schema.conceptCarc) };
    case "rarc":
      return { table: schema.conceptRarc, ...commonCols(schema.conceptRarc) };
    default:
      return null;
  }
}

/** Loosely-typed concept row — the union of every per-system table's selectable columns. */
interface AnyConceptRow {
  code: string;
  display: string;
  status: ResolvedConcept<CodeSystemId>["status"];
  effectiveDate: string;
  endDate: string | null;
  // icd10cm
  isBillableLeaf?: boolean;
  /** The row's `properties` jsonb (F-238: the loader's Tabular List flags). */
  properties?: Record<string, unknown> | null;
  chapter?: string | null;
  parentCode?: string | null;
  // snomed
  fullySpecifiedName?: string;
  semanticTag?: string | null;
  hierarchyPath?: string[] | null;
  // loinc
  component?: string | null;
  property?: string | null;
  time?: string | null;
  system?: string | null;
  scale?: string | null;
  method?: string | null;
  shortName?: string | null;
  // rxnorm
  tty?: string;
  ingredientRxcui?: string | null;
  ndcs?: string[] | null;
}

/** F-238 — the loader's Tabular List flags, only when the row carries them (older loads do not). */
function icd10Flags(p: Record<string, unknown> | null | undefined) {
  const flag = (k: string) => (typeof p?.[k] === "boolean" ? { [k]: p[k] as boolean } : {});
  return { ...flag("manifestation"), ...flag("hasCodeFirstNote"), ...flag("useAdditionalCode") };
}

/** Build the union {@link ResolvedConcept} from a raw per-system row, filling its `properties`. */
function mapConcept(system: CodeSystemId, r: AnyConceptRow): ResolvedConcept<CodeSystemId> {
  const base = {
    systemId: system,
    code: r.code,
    display: r.display,
    status: r.status,
    effectiveDate: r.effectiveDate,
    endDate: r.endDate,
  } as const;
  switch (system) {
    case "icd10cm":
      return {
        ...base,
        properties: {
          isBillableLeaf: r.isBillableLeaf ?? false,
          chapter: r.chapter ?? null,
          parentCode: r.parentCode ?? null,
          ...icd10Flags(r.properties),
        },
      };
    case "snomed":
      return {
        ...base,
        properties: {
          fullySpecifiedName: r.fullySpecifiedName ?? "",
          semanticTag: r.semanticTag ?? null,
          hierarchyPath: r.hierarchyPath ?? [],
        },
      };
    case "loinc":
      return {
        ...base,
        properties: {
          component: r.component ?? null,
          property: r.property ?? null,
          time: r.time ?? null,
          system: r.system ?? null,
          scale: r.scale ?? null,
          method: r.method ?? null,
          shortName: r.shortName ?? null,
        },
      };
    case "rxnorm":
      return {
        ...base,
        properties: {
          tty: r.tty ?? "",
          ingredientRxcui: r.ingredientRxcui ?? null,
          ndcs: r.ndcs ?? [],
        },
      };
    case "hcpcs": {
      // The loader tags each HCPCS row `recordKind` ('code' | 'modifier'); the seam's `kind` carries it.
      const kind = r.properties?.recordKind;
      return { ...base, properties: { kind: typeof kind === "string" ? kind : null } };
    }
    default:
      return { ...base, properties: {} as ResolvedConcept<CodeSystemId>["properties"] };
  }
}

/** Escape LIKE wildcards so a typed `%` or `_` matches itself (the search box is user input). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `billableOnly`: the code is usable on a claim. ICD-10-CM carries a billable-leaf flag (and must be active); no other
 * system has such a flag, so for them it means `status = active` — a deprecated/retired code is not billable.
 */
function billableClause(system: CodeSystemId, cols: ConceptCols): SQL {
  const active = eq(cols.status, "active");
  return (
    system === "icd10cm" ? and(active, eq(schema.conceptIcd10cm.isBillableLeaf, true)) : active
  ) as SQL;
}

/** A platform value-set / expansion member row covers `asOf` when effective <= asOf <= end (inclusive). */
function coversAsOf(effectiveCol: PgColumn, endCol: PgColumn, asOfIso: string): SQL {
  return and(lte(effectiveCol, asOfIso), or(isNull(endCol), gte(endCol, asOfIso))) as SQL;
}

/**
 * Build the production {@link TerminologyStore}. Reference reads run on the pooled handle; the
 * org-scoped tenant-extension methods run inside `withOrgContext` (RLS scopes by `app.org_id`).
 */
export function createDbTerminologyStore(db: DbClient): TerminologyStore {
  /** Resolve the as-of display for a batch of (system, code) — used to label value-set members. */
  async function resolveDisplays(
    members: readonly { readonly systemId: CodeSystemId; readonly code: string }[],
    asOfIso: string,
  ): Promise<Map<string, string>> {
    const bySystem = new Map<CodeSystemId, Set<string>>();
    for (const m of members) {
      const set = bySystem.get(m.systemId) ?? bySystem.set(m.systemId, new Set()).get(m.systemId)!;
      set.add(m.code);
    }
    const out = new Map<string, string>();
    for (const [system, codes] of bySystem) {
      const candidates = await store.conceptVersionsBatch(system, [...codes]);
      const winners = resolveBatchAsOf(candidates, new Date(asOfIso));
      for (const [code, concept] of winners) out.set(`${system}:${code}`, concept.display);
    }
    return out;
  }

  /**
   * Resolve `inValueSet` for one system: the SQL predicate restricting concept codes to the set (platform members
   * covering `asOf` as a subquery, plus the tenant's live extensions read under its own RLS context), and a reader
   * for members that have no concept row. An unknown value set is NOT_FOUND, never a silent empty list.
   */
  async function valueSetScope(
    valueSetId: string,
    system: CodeSystemId,
    cols: ConceptCols,
    asOfIso: string,
    orgId: string | undefined,
  ) {
    const VS = schema.valueSets;
    const M = schema.valueSetMembers;
    const X = schema.valueSetTenantExtension;
    const known = await db.select({ id: VS.id }).from(VS).where(eq(VS.id, valueSetId)).limit(1);
    if (known.length === 0) throw new ChartWardenError("NOT_FOUND", "value set not found", 404);
    const platformWhere = and(
      eq(M.valueSetId, valueSetId),
      eq(M.systemId, system),
      coversAsOf(M.memberEffective, M.memberEnd, asOfIso),
    ) as SQL;
    const tenantRows = orgId
      ? await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
          tx
            .select({ code: X.code })
            .from(X)
            .where(
              and(
                eq(X.valueSetId, valueSetId),
                eq(X.organizationId, orgId),
                eq(X.systemId, system),
                isNull(X.removedAt),
              ),
            ),
        )
      : [];
    const tenantCodes = tenantRows.map((r) => r.code);
    const platformCodes = db.select({ code: M.code }).from(M).where(platformWhere);
    const inScope = (
      tenantCodes.length > 0
        ? or(inArray(cols.code, platformCodes), inArray(cols.code, tenantCodes))
        : inArray(cols.code, platformCodes)
    ) as SQL;
    return {
      inScope,
      async orphanMembers(
        mode: "exact" | "fuzzy",
        needle: string,
      ): Promise<ResolvedConcept<CodeSystemId>[]> {
        const shown = sql<string>`coalesce(${M.annotations}->>'display', '')`;
        const textMatch =
          mode === "exact"
            ? or(eq(M.code, needle), sql`lower(${shown}) = lower(${needle})`)
            : or(ilike(M.code, `%${escapeLike(needle)}%`), ilike(shown, `%${escapeLike(needle)}%`));
        const rows = await db
          .select({
            code: M.code,
            annotations: M.annotations,
            effective: M.memberEffective,
            end: M.memberEnd,
          })
          .from(M)
          .where(
            and(
              platformWhere,
              textMatch,
              notExists(db.select({ one: sql`1` }).from(cols.table).where(eq(cols.code, M.code))),
            ),
          );
        return rows.map((r) => {
          const ann = (r.annotations ?? {}) as Record<string, unknown>;
          const display =
            typeof ann.display === "string" && ann.display !== "" ? ann.display : r.code;
          return mapConcept(system, {
            code: r.code,
            display,
            status: ann.loincDeprecated === true ? "deprecated" : "active",
            effectiveDate: String(r.effective),
            endDate: r.end ? String(r.end) : null,
          });
        });
      },
    };
  }

  const store: TerminologyStore = {
    async conceptVersions<S extends CodeSystemId>(system: S, code: string) {
      const cols = conceptCols(system);
      if (!cols) return [];
      const rows = (await db
        .select()
        .from(cols.table)
        .where(eq(cols.code, code))) as unknown as AnyConceptRow[];
      return rows.map((r) => mapConcept(system, r)) as ConceptCandidate<S>[];
    },

    async conceptVersionsBatch<S extends CodeSystemId>(system: S, codes: readonly string[]) {
      const cols = conceptCols(system);
      if (!cols || codes.length === 0) return [];
      const rows = (await db
        .select()
        .from(cols.table)
        .where(inArray(cols.code, [...codes]))) as unknown as AnyConceptRow[];
      return rows.map((r) => mapConcept(system, r)) as ConceptCandidate<S>[];
    },

    async deprecation(system: CodeSystemId, code: string) {
      const D = schema.deprecationMapping;
      const rows = await db
        .select({
          deprecatedCode: D.deprecatedCode,
          deprecationEffective: D.deprecationEffective,
          successorCodes: D.successorCodes,
          mappingKind: D.mappingKind,
          guidance: D.guidance,
        })
        .from(D)
        .where(and(eq(D.systemId, system), eq(D.deprecatedCode, code)))
        .orderBy(desc(D.deprecationEffective))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        deprecatedCode: row.deprecatedCode,
        deprecationEffective: row.deprecationEffective,
        successorCodes: row.successorCodes,
        mappingKind: row.mappingKind,
        guidance: row.guidance,
      } satisfies DeprecationMappingResponse;
    },

    async valueSetMembers(valueSetId, opts) {
      const M = schema.valueSetMembers;
      const where = and(
        eq(M.valueSetId, valueSetId),
        coversAsOf(M.memberEffective, M.memberEnd, opts.asOfIso),
        opts.system ? eq(M.systemId, opts.system) : undefined,
      );
      const rows = await db
        .select({ systemId: M.systemId, code: M.code, annotations: M.annotations })
        .from(M)
        .where(where);
      const displays = await resolveDisplays(rows, opts.asOfIso);
      return rows.map((r) => ({
        systemId: r.systemId,
        code: r.code,
        display: displays.get(`${r.systemId}:${r.code}`) ?? r.code,
        annotations: (r.annotations ?? {}) as Record<string, unknown>,
      })) satisfies readonly ExpansionMember[];
    },

    async tenantExtensionMembers(orgId, valueSetId) {
      const X = schema.valueSetTenantExtension;
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({ systemId: X.systemId, code: X.code, reason: X.reason })
          .from(X)
          .where(
            and(eq(X.valueSetId, valueSetId), eq(X.organizationId, orgId), isNull(X.removedAt)),
          ),
      );
      const displays = await resolveDisplays(rows, normalizeAsOf());
      return rows.map((r) => ({
        systemId: r.systemId,
        code: r.code,
        display: displays.get(`${r.systemId}:${r.code}`) ?? r.code,
        annotations: { source: "tenant_extension", reason: r.reason } as Record<string, unknown>,
      })) satisfies readonly ExpansionMember[];
    },

    async searchConcepts<S extends CodeSystemId>(system: S, q: string, opts: SearchOptions) {
      const cols = conceptCols(system);
      if (!cols) return [];
      const needle = q.trim();
      const match =
        opts.mode === "exact"
          ? (or(eq(cols.code, needle), ilike(cols.display, needle)) as SQL)
          : (or(
              ilike(cols.code, `%${escapeLike(needle)}%`),
              ilike(cols.display, `%${escapeLike(needle)}%`),
            ) as SQL);
      const billable = opts.billableOnly ? billableClause(system, cols) : undefined;
      const limit = opts.limit !== undefined ? Math.max(1, Math.floor(opts.limit)) : undefined;
      // One row per code: concept tables hold one row per loaded version (ICD-10-CM FY2026 + FY2027), so
      // an undated search returned every version of every match. Search answers "as of" a date — today
      // unless the caller says otherwise — exactly like lookup/validate do.
      const asOfIso = (opts.asOf ?? new Date()).toISOString().slice(0, 10);
      const current = coversAsOf(cols.effective, cols.end, asOfIso);
      const scope =
        opts.inValueSet !== undefined
          ? await valueSetScope(opts.inValueSet, system, cols, asOfIso, opts.orgId)
          : null;
      let query = db
        .select()
        .from(cols.table)
        .where(and(match, billable, current, scope?.inScope))
        .orderBy(cols.code)
        .$dynamic();
      if (limit !== undefined) query = query.limit(limit);
      const rows = (await query) as unknown as AnyConceptRow[];
      const hits = rows.map((r) => mapConcept(system, r));
      if (!scope || opts.billableOnly) return hits as ResolvedConcept<S>[];
      // Members with no concept row (sud_test_loinc while concept_loinc is unloaded) stay searchable by the
      // display their member row carries. billableOnly skips them: with no concept row there is no status to trust.
      const orphans = await scope.orphanMembers(opts.mode === "exact" ? "exact" : "fuzzy", needle);
      const merged = [...hits, ...orphans].sort((a, b) =>
        a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
      );
      return (limit !== undefined ? merged.slice(0, limit) : merged) as ResolvedConcept<S>[];
    },

    async insertTenantExtension(input: TenantExtensionInput) {
      const X = schema.valueSetTenantExtension;
      return withOrgContext(
        db,
        { organizationId: input.orgId, userId: input.actorUserId },
        async (tx) => {
          const inserted = (await tx
            .insert(X)
            .values({
              valueSetId: input.valueSetId,
              organizationId: input.orgId,
              systemId: input.system,
              code: input.code,
              reason: input.reason,
              addedBy: input.actorUserId,
            })
            .returning({ id: X.id })) as Array<{ id: string }>;
          return { extensionId: inserted[0]!.id };
        },
      );
    },

    async deleteTenantExtension(orgId, extensionId, actorUserId) {
      const X = schema.valueSetTenantExtension;
      // Soft delete (§3.5 `removed_at` marker; the active-row partial unique index keys on NULL).
      await withOrgContext(db, { organizationId: orgId, userId: actorUserId }, (tx) =>
        tx
          .update(X)
          .set({ removedAt: sql`now()` })
          .where(and(eq(X.id, extensionId), eq(X.organizationId, orgId), isNull(X.removedAt))),
      );
    },

    async eraseTenantExtensions(orgId) {
      const X = schema.valueSetTenantExtension;
      // D8 tenant offboarding (§11): hard-delete every extension this org owns; canonical untouched.
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const removed = (await tx
          .delete(X)
          .where(eq(X.organizationId, orgId))
          .returning({ id: X.id })) as Array<{ id: string }>;
        return { erased: removed.length };
      });
    },

    async codeSystemConcepts(system, asOfIso) {
      const cols = conceptCols(system);
      if (!cols) return [];
      // Active-at-asOf, non-retired — the FHIR CodeSystem projection set (§7.9). Deterministic order.
      const rows = (await db
        .select({ code: cols.code, display: cols.display })
        .from(cols.table)
        .where(and(coversAsOf(cols.effective, cols.end, asOfIso), sql`${cols.status} <> 'retired'`))
        .orderBy(cols.code)) as Array<{ code: string; display: string }>;
      return rows;
    },

    async listVersions(system) {
      const V = schema.codeSystemVersions;
      const rows = await db
        .select({ version: V.version, effectiveFrom: V.effectiveFrom, effectiveTo: V.effectiveTo })
        .from(V)
        .where(and(eq(V.codeSystemId, system), inArray(V.status, ["active", "superseded"])))
        .orderBy(V.effectiveFrom);
      return rows.map((r) => ({
        version: r.version,
        effectiveFrom: String(r.effectiveFrom),
        effectiveTo: r.effectiveTo ? String(r.effectiveTo) : null,
      }));
    },

    async codeSystemMeta(system, asOfIso) {
      const CS = schema.codeSystems;
      const V = schema.codeSystemVersions;
      const A = schema.terminologyLicenseAttestations;
      const today = new Date().toISOString().slice(0, 10);
      const [csRows, attRows, verRows] = await Promise.all([
        db.select({ sourceUri: CS.sourceUri }).from(CS).where(eq(CS.id, system)).limit(1),
        // GAP-108: the licence attribution in force TODAY (FHIR `CodeSystem.copyright`). It is a property of how the
        // data is being served now, not of the as-of date the content is projected at.
        db
          .select({ text: A.attributionText })
          .from(A)
          .where(
            and(
              eq(A.systemId, system),
              isNull(A.revokedAt),
              lte(A.effectiveFrom, today),
              or(isNull(A.effectiveTo), gte(A.effectiveTo, today)),
            ),
          )
          .orderBy(desc(A.effectiveFrom))
          .limit(1),
        db
          .select({ version: V.version })
          .from(V)
          .where(
            and(
              eq(V.codeSystemId, system),
              // GAP-108: a `loading`/`staged`/`failed` version is not yet (or never) in force.
              inArray(V.status, ["active", "superseded"]),
              lte(V.effectiveFrom, asOfIso),
              or(isNull(V.effectiveTo), gte(V.effectiveTo, asOfIso)),
            ),
          )
          .orderBy(desc(V.effectiveFrom))
          .limit(1),
      ]);
      const copyright = attRows[0]?.text;
      return {
        url: csRows[0]?.sourceUri ?? `urn:wardenx:codesystem:${system}`,
        version: verRows[0]?.version ?? "0",
        ...(copyright ? { copyright } : {}),
      } satisfies CodeSystemMeta;
    },

    async valueSetMeta(valueSetId) {
      // `value_set` carries no canonical url column in Phase 1 — derive the stable urn from the slug.
      return { url: `urn:wardenx:valueset:${valueSetId}` };
    },
  };

  return store;
}
