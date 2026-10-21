// @chartwarden/terminology — M38-T07 unit tests: value-set expansion (§7.5), add-only tenant
// extensions (§7.6), annual deprecation remediation (§7.3). Pure engine, no live infra (§9.1).
//
//   • §7.5 expansion — materialized projection of members; the B-tree membership lookup honors
//     asOf (inclusive upper); a newly loaded member is a member at its effective date; the §2.5
//     freshness invariant flags an expansion stale the moment an included system loads newer.
//   • §7.6 extensions — add-only/never-weaken: an active non-member adds; a deprecated/retired/
//     unknown code is refused (INVALID_CODE); an existing platform member is REDUNDANT; the
//     read-time union never lets a tenant row shadow or relabel a platform member.
//   • §7.3 remediation — per-deprecated-code rollup with affected count, successor codes, and a
//     bounded sample; sorted by exposure; active codes contribute nothing.
import { describe, expect, it } from "vitest";
import {
  type DeprecationMappingResponse,
  type ExpansionMember,
  type ResolvedConcept,
  type TenantCodeRecord,
  type ValueSetMemberRow,
  buildRemediationReport,
  classifyTenantExtension,
  computeExpansion,
  isExpansionStale,
  isMemberAtAsOf,
  memberRowAtAsOf,
  staleIncludedSystems,
  unionTenantExtensions,
} from "../src/index";

// ── §7.5 value-set expansion ──────────────────────────────────────────────────────────
describe("computeExpansion — materialized projection of members (§7.5, §2.1.2)", () => {
  const members: ValueSetMemberRow[] = [
    {
      valueSetId: "hospice_terminal_dx",
      systemId: "icd10cm",
      code: "G93.41",
      memberEffective: "2022-10-01",
      memberEnd: null,
    },
    {
      valueSetId: "hospice_terminal_dx",
      systemId: "icd10cm",
      code: "C34.90",
      memberEffective: "2020-01-01",
      memberEnd: "2024-09-30",
    },
  ];

  it("projects each member's effective range into an expansion row, code-sorted & deterministic", () => {
    const rows = computeExpansion(members);
    expect(rows.map((r) => r.code)).toEqual(["C34.90", "G93.41"]);
    expect(rows.find((r) => r.code === "C34.90")).toMatchObject({
      asOfLower: "2020-01-01",
      asOfUpper: "2024-09-30",
    });
    expect(rows.find((r) => r.code === "G93.41")).toMatchObject({
      asOfLower: "2022-10-01",
      asOfUpper: null,
    });
    // Re-running is idempotent regardless of input order (§2.5 expansion freshness).
    expect(computeExpansion([...members].reverse())).toEqual(rows);
  });

  it("de-dups an identical member loaded twice into one expansion row", () => {
    const dup = [members[0], { ...members[0] }];
    expect(computeExpansion(dup)).toHaveLength(1);
  });
});

describe("isMemberAtAsOf — the precomputed B-tree lookup honors asOf (§7.5, §2.4.1 inclusive upper)", () => {
  const rows = computeExpansion([
    {
      valueSetId: "vs",
      systemId: "icd10cm",
      code: "C34.90",
      memberEffective: "2020-01-01",
      memberEnd: "2024-09-30",
    },
    {
      valueSetId: "vs",
      systemId: "icd10cm",
      code: "G93.41",
      memberEffective: "2022-10-01",
      memberEnd: null,
    },
  ]);

  it("is a member inside the range and on the inclusive end-date boundary", () => {
    expect(isMemberAtAsOf(rows, "icd10cm", "C34.90", "2022-06-15")).toBe(true);
    expect(isMemberAtAsOf(rows, "icd10cm", "C34.90", "2024-09-30")).toBe(true); // last service day
  });

  it("is not a member before the effective date or after the end date", () => {
    expect(isMemberAtAsOf(rows, "icd10cm", "C34.90", "2019-12-31")).toBe(false);
    expect(isMemberAtAsOf(rows, "icd10cm", "C34.90", "2024-10-01")).toBe(false);
  });

  it("an open-ended member stays a member into the far future; memberRowAtAsOf exposes annotations", () => {
    expect(isMemberAtAsOf(rows, "icd10cm", "G93.41", "2099-01-01")).toBe(true);
    expect(memberRowAtAsOf(rows, "icd10cm", "Z99.9", "2023-01-01")).toBeNull();
  });

  it("§7.5 a newly loaded member is a member at its effective date once expansion is recomputed", () => {
    const before = computeExpansion([
      {
        valueSetId: "vs",
        systemId: "icd10cm",
        code: "C34.90",
        memberEffective: "2020-01-01",
        memberEnd: null,
      },
    ]);
    expect(isMemberAtAsOf(before, "icd10cm", "J96.01", "2025-01-01")).toBe(false);
    // A new version adds J96.01; the loader recomputes the expansion (§2.1.2) → now a member.
    const after = computeExpansion([
      {
        valueSetId: "vs",
        systemId: "icd10cm",
        code: "C34.90",
        memberEffective: "2020-01-01",
        memberEnd: null,
      },
      {
        valueSetId: "vs",
        systemId: "icd10cm",
        code: "J96.01",
        memberEffective: "2025-01-01",
        memberEnd: null,
      },
    ]);
    expect(isMemberAtAsOf(after, "icd10cm", "J96.01", "2025-01-01")).toBe(true);
  });
});

describe("isExpansionStale — the §2.5 freshness invariant (§7.5 staleness gauge)", () => {
  const expandedAt = "2025-01-15T00:00:00Z";

  it("is fresh when every included system loaded at-or-before the last expansion", () => {
    const loads = [
      { systemId: "icd10cm" as const, loadedAt: "2025-01-15T00:00:00Z" },
      { systemId: "snomed" as const, loadedAt: "2024-09-01T00:00:00Z" },
    ];
    expect(isExpansionStale(expandedAt, loads)).toBe(false);
    expect(staleIncludedSystems(expandedAt, loads)).toEqual([]);
  });

  it("is stale, naming the systems, when any included system loaded after the expansion", () => {
    const loads = [
      { systemId: "icd10cm" as const, loadedAt: "2025-10-01T00:00:00Z" }, // newer → owes recompute
      { systemId: "snomed" as const, loadedAt: "2024-09-01T00:00:00Z" },
    ];
    expect(isExpansionStale(expandedAt, loads)).toBe(true);
    expect(staleIncludedSystems(expandedAt, loads)).toEqual(["icd10cm"]);
  });
});

// ── §7.6 tenant value-set extensions: add-only, never weaken ────────────────────────────
describe("classifyTenantExtension — add-time gate (§7.6, §7.10)", () => {
  const active: ResolvedConcept<"icd10cm"> = {
    systemId: "icd10cm",
    code: "E11.8",
    display: "active",
    status: "active",
    effectiveDate: "2024-10-01",
    endDate: null,
    properties: { isBillableLeaf: true, chapter: null, parentCode: null },
  };

  it("OK: an active, non-member code may be added", () => {
    expect(classifyTenantExtension({ resolved: active, isPlatformMember: false })).toEqual({
      outcome: "ok",
    });
  });

  it("REDUNDANT: an active code already in the platform set is a no-op (§7.10 → 409)", () => {
    expect(classifyTenantExtension({ resolved: active, isPlatformMember: true })).toEqual({
      outcome: "redundant",
    });
  });

  it("INVALID_CODE: an unknown code that resolves to nothing today (§7.10 → 422)", () => {
    expect(classifyTenantExtension({ resolved: null, isPlatformMember: false })).toEqual({
      outcome: "invalid_code",
      reason: "unresolved",
    });
  });

  it("INVALID_CODE: a deprecated code is refused even if not yet a member — we can't pin a retiring code", () => {
    expect(
      classifyTenantExtension({
        resolved: { ...active, status: "deprecated" },
        isPlatformMember: false,
      }),
    ).toEqual({ outcome: "invalid_code", reason: "deprecated" });
  });

  it("INVALID_CODE: a retired code is refused", () => {
    expect(
      classifyTenantExtension({
        resolved: { ...active, status: "retired" },
        isPlatformMember: false,
      }),
    ).toEqual({ outcome: "invalid_code", reason: "retired" });
  });

  it("validity wins over membership: a deprecated code that is also a platform member is INVALID_CODE", () => {
    expect(
      classifyTenantExtension({
        resolved: { ...active, status: "deprecated" },
        isPlatformMember: true,
      }),
    ).toEqual({ outcome: "invalid_code", reason: "deprecated" });
  });
});

describe("unionTenantExtensions — read-time union, add-only (§7.6, §2.4.3)", () => {
  const platform: ExpansionMember[] = [
    {
      systemId: "icd10cm",
      code: "G93.41",
      display: "platform display",
      annotations: { is_terminal: true },
    },
  ];

  it("appends a tenant add after the platform members", () => {
    const tenant: ExpansionMember[] = [
      {
        systemId: "icd10cm",
        code: "E11.8",
        display: "tenant add",
        annotations: { source: "tenant_extension" },
      },
    ];
    const union = unionTenantExtensions(platform, tenant);
    expect(union.map((m) => m.code)).toEqual(["G93.41", "E11.8"]);
  });

  it("a tenant row duplicating a platform (system, code) NEVER shadows it — platform annotations stand", () => {
    const tenant: ExpansionMember[] = [
      {
        systemId: "icd10cm",
        code: "G93.41",
        display: "tenant relabel attempt",
        annotations: { is_terminal: false },
      },
    ];
    const union = unionTenantExtensions(platform, tenant);
    expect(union).toHaveLength(1);
    expect(union[0]).toEqual(platform[0]); // the platform shape & annotations win
  });

  it("dedups repeated tenant adds of the same code", () => {
    const tenant: ExpansionMember[] = [
      { systemId: "icd10cm", code: "E11.8", display: "a", annotations: {} },
      { systemId: "icd10cm", code: "E11.8", display: "b", annotations: {} },
    ];
    expect(unionTenantExtensions([], tenant)).toHaveLength(1);
  });
});

// ── §7.3 annual deprecation remediation ────────────────────────────────────────────────
describe("buildRemediationReport — per-deprecated-code rollup (§7.3)", () => {
  const deprecations: ({ systemId: "icd10cm" } & DeprecationMappingResponse)[] = [
    {
      systemId: "icd10cm",
      deprecatedCode: "I50.20",
      deprecationEffective: "2024-10-01",
      successorCodes: ["I50.21", "I50.22"],
      mappingKind: "narrower",
      guidance: "Use the systolic-specific code.",
    },
    {
      systemId: "icd10cm",
      deprecatedCode: "R51",
      deprecationEffective: "2024-10-01",
      successorCodes: ["R51.9"],
      mappingKind: "equivalent",
      guidance: null,
    },
  ];

  function records(): TenantCodeRecord[] {
    const out: TenantCodeRecord[] = [];
    // 3 records on I50.20 (a now-deprecated code), 1 on R51, 2 on an active code (no remediation).
    out.push({ recordId: "p1", recordType: "problem_list", systemId: "icd10cm", code: "I50.20" });
    out.push({ recordId: "c1", recordType: "claim_line", systemId: "icd10cm", code: "I50.20" });
    out.push({ recordId: "o1", recordType: "order", systemId: "icd10cm", code: "I50.20" });
    out.push({ recordId: "p2", recordType: "problem_list", systemId: "icd10cm", code: "R51" });
    out.push({ recordId: "p3", recordType: "problem_list", systemId: "icd10cm", code: "I50.21" }); // active
    out.push({ recordId: "p4", recordType: "problem_list", systemId: "icd10cm", code: "I50.21" }); // active
    return out;
  }

  it("rolls records up by deprecated code, counts exposure, attaches successors, ignores active codes", () => {
    const report = buildRemediationReport(records(), deprecations);
    expect(report.totalAffected).toBe(4); // 3× I50.20 + 1× R51; the two active records excluded
    expect(report.affectedCodeCount).toBe(2);
    // Sorted by descending affected count → I50.20 (3) leads R51 (1).
    expect(report.lines.map((l) => l.deprecatedCode)).toEqual(["I50.20", "R51"]);
    const top = report.lines[0];
    expect(top.affectedCount).toBe(3);
    expect(top.successorCodes).toEqual(["I50.21", "I50.22"]);
    expect(top.affectedByType).toEqual({ claim_line: 1, order: 1, problem_list: 1 });
    expect(top.sampleRecordIds).toEqual(["p1", "c1", "o1"]);
  });

  it("caps the sample to sampleSize while keeping the full affected count", () => {
    const many: TenantCodeRecord[] = Array.from({ length: 100 }, (_v, i) => ({
      recordId: `r${i}`,
      recordType: "problem_list",
      systemId: "icd10cm" as const,
      code: "I50.20",
    }));
    const report = buildRemediationReport(many, deprecations, { sampleSize: 5 });
    expect(report.lines[0].affectedCount).toBe(100);
    expect(report.lines[0].sampleRecordIds).toHaveLength(5);
    expect(report.lines[0].sampleRecordIds).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("returns an empty report when no record uses a deprecated code", () => {
    const clean: TenantCodeRecord[] = [
      { recordId: "x", recordType: "problem_list", systemId: "icd10cm", code: "I50.21" },
    ];
    expect(buildRemediationReport(clean, deprecations)).toEqual({
      totalAffected: 0,
      affectedCodeCount: 0,
      lines: [],
    });
  });
});

// ── §9.1 deprecation mapping kinds: every kind parseable & serializable ──────────────────
// All five DeprecationMappingKind values (equivalent / broader / narrower / none / see_other,
// §3.6 enum) must round-trip through the remediation report and survive JSON serialization — the
// report is the alert payload and the page model, so a kind that doesn't serialize is a silent gap.
describe("DeprecationMappingKind — all five kinds round-trip (§9.1)", () => {
  const KINDS = ["equivalent", "broader", "narrower", "none", "see_other"] as const;

  it("carries every mapping kind onto its remediation line", () => {
    const deps: ({ systemId: "icd10cm" } & DeprecationMappingResponse)[] = KINDS.map((kind, i) => ({
      systemId: "icd10cm",
      deprecatedCode: `D${i}`,
      deprecationEffective: "2024-10-01",
      // `none` carries no successor; the others propose at least one.
      successorCodes: kind === "none" ? [] : [`S${i}`],
      mappingKind: kind,
      guidance: kind === "see_other" ? "See the cross-reference note." : null,
    }));
    const records: TenantCodeRecord[] = KINDS.map((_kind, i) => ({
      recordId: `r${i}`,
      recordType: "problem_list",
      systemId: "icd10cm" as const,
      code: `D${i}`,
    }));

    const report = buildRemediationReport(records, deps);
    expect(report.affectedCodeCount).toBe(KINDS.length);
    // Every kind appears exactly once across the report's lines.
    expect(new Set(report.lines.map((l) => l.mappingKind))).toEqual(new Set(KINDS));
    const noneLine = report.lines.find((l) => l.mappingKind === "none");
    expect(noneLine?.successorCodes).toEqual([]);
  });

  it("survives a JSON serialize/parse round-trip (alert-payload safety)", () => {
    const deps: ({ systemId: "icd10cm" } & DeprecationMappingResponse)[] = KINDS.map((kind, i) => ({
      systemId: "icd10cm",
      deprecatedCode: `D${i}`,
      deprecationEffective: "2024-10-01",
      successorCodes: [`S${i}`],
      mappingKind: kind,
      guidance: null,
    }));
    const records: TenantCodeRecord[] = KINDS.map((_kind, i) => ({
      recordId: `r${i}`,
      recordType: "claim_line",
      systemId: "icd10cm" as const,
      code: `D${i}`,
    }));
    const report = buildRemediationReport(records, deps);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
