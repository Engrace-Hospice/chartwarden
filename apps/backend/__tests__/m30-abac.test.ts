// apps/backend/__tests__/m30-abac.test.ts — M30 (§4.6 permission catalog · §4.7/§6.7 ABAC predicates).
//
// Proves the backend governance wiring M30 owns:
//
//   (a) the §4.6 `M30_CONTRIBUTED_PERMISSIONS` catalog is exactly the pure `@wardenx/quality`
//       `M30_PERMISSIONS` tuple (33 keys) AND is exactly the permission-key set the §4.1 route files
//       gate on — no catalog key without a route, no route key without a catalog entry (orphan check),
//       and every catalog entry names a real §4.7 ABAC default predicate.
//   (b) the §4.7 fact-loader predicates (`buildM30AbacPredicates` over an in-memory resolver) GRANT for
//       the owning/assigned actor and DENY otherwise, the §6.7 separation-of-duties co-sign predicates
//       require two distinct actors in the two distinct roles, and the fail-closed predicates
//       (`part2Redisclosure`, `abuseAllegationAccess`) deny by default (deny-stub resolver / no role).
//
// PURE: an in-memory `ReadingM30AbacResolver` is injected — no DB. The route-key orphan scan reads the
// route source files from disk (they are the §4.1 inventory and cannot be imported without a Fastify app).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { abacRegistry } from "@wardenx/auth";
import { M30_PERMISSIONS } from "@wardenx/quality";
import { describe, expect, it } from "vitest";
import {
  M30_CONTRIBUTED_PERMISSIONS,
  M30_PERMISSION_KEYS,
  M30_REGISTERED_ABAC_PREDICATES,
  buildM30AbacPredicates,
  denyStubM30AbacResolver,
  registerM30AbacPredicates,
  type IncidentAbacFacts,
  type MortalityReviewAbacFacts,
  type QapiProjectAbacFacts,
  type ReadingM30AbacResolver,
  type SraCycleAbacFacts,
} from "../src/modules/30-quality/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, "..", "src", "modules", "30-quality", "routes");

// -----------------------------------------------------------------------------
// (a) §4.6 permission catalog — pure-tuple parity + route-key orphan check.
// -----------------------------------------------------------------------------
describe("M30 §4.6 contributed-permission catalog", () => {
  it("is exactly the 33-key pure @wardenx/quality M30_PERMISSIONS tuple (no add/drop/rename)", () => {
    const catalogKeys = Object.keys(M30_CONTRIBUTED_PERMISSIONS).sort();
    expect(catalogKeys).toHaveLength(33);
    expect(catalogKeys).toEqual([...M30_PERMISSIONS].sort());
    // M30_PERMISSION_KEYS is the convenience projection of the catalog keys.
    expect([...M30_PERMISSION_KEYS].sort()).toEqual(catalogKeys);
  });

  it("every catalog entry names a real §4.7 ABAC default predicate (no empty/typo'd abac binding)", () => {
    const knownPredicates = new Set<string>([
      "inOrg", // the M3 base predicate every M30 route composes
      ...M30_REGISTERED_ABAC_PREDICATES,
    ]);
    for (const [key, def] of Object.entries(M30_CONTRIBUTED_PERMISSIONS)) {
      expect(def.abac.length, `${key} must declare an abac default`).toBeGreaterThan(0);
      expect(knownPredicates.has(def.abac), `${key} abac '${def.abac}' is a known predicate`).toBe(
        true,
      );
      // the resource/action decompose the key.
      expect(`${key}`.endsWith(`.${def.action}`)).toBe(true);
    }
  });

  it("the catalog keys are EXACTLY the permission keys the §4.1 route files gate on (no orphans)", () => {
    // Scan every route source file for permission string literals under an owned M30 prefix.
    const prefixRe =
      /"((?:quality|qapi|sra|incident|mortality|cop|infection|risk)(?:\.[a-z_]+)+)"/g;
    const routeKeys = new Set<string>();
    for (const file of readdirSync(ROUTES_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(ROUTES_DIR, file), "utf8");
      for (const m of text.matchAll(prefixRe)) {
        if (m[1]) routeKeys.add(m[1]);
      }
    }
    const catalog = new Set(Object.keys(M30_CONTRIBUTED_PERMISSIONS));
    // every key a route gates on is a declared catalog key (no route references an undeclared key)...
    const routeOrphans = [...routeKeys].filter((k) => !catalog.has(k));
    expect(routeOrphans, `route keys missing from the catalog: ${routeOrphans.join(", ")}`).toEqual(
      [],
    );
    // ...and every declared catalog key is actually gated on by at least one route (no dead grant).
    const catalogOrphans = [...catalog].filter((k) => !routeKeys.has(k));
    expect(
      catalogOrphans,
      `catalog keys no route gates on: ${catalogOrphans.join(", ")}`,
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// (b) §4.7/§6.7 ABAC fact-loader predicates over an in-memory resolver.
// -----------------------------------------------------------------------------
const ORG = "org-1";
const REPORTER = "mem-reporter";
const ASSIGNEE = "mem-assignee";
const STRANGER = "mem-stranger";
const OWNER = "mem-owner";
const COSIGNER = "mem-cosigner";

/** Build an in-memory resolver with optional seeded facts; everything else fails closed. */
function resolverWith(seed: {
  incident?: IncidentAbacFacts;
  qapi?: QapiProjectAbacFacts;
  sra?: SraCycleAbacFacts;
  mortality?: MortalityReviewAbacFacts;
  roleKeysByMembership?: Record<string, readonly string[]>;
}): ReadingM30AbacResolver {
  return {
    async loadIncident(_ctx, id) {
      return seed.incident && seed.incident.incidentId === id ? seed.incident : null;
    },
    async loadQapiProject(_ctx, id) {
      return seed.qapi && seed.qapi.projectId === id ? seed.qapi : null;
    },
    async loadSraCycle(_ctx, id) {
      return seed.sra && seed.sra.cycleId === id ? seed.sra : null;
    },
    async loadMortalityReview(_ctx, id) {
      return seed.mortality && seed.mortality.reviewId === id ? seed.mortality : null;
    },
    async loadMemberRoleKeys(_ctx, membershipId) {
      return seed.roleKeysByMembership?.[membershipId] ?? [];
    },
    async isPatientPart2Protected() {
      return false;
    },
    async hasPart2ReleaseCoveringActor() {
      return false;
    },
  };
}

/** Assemble a server-side AbacContext (membershipId + permissions ride on `attributes`, never client input). */
function ctx(opts: {
  roles?: readonly string[];
  membershipId?: string | null;
  permissions?: readonly string[];
}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: opts.roles ?? [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {
      ...(opts.membershipId != null ? { membershipId: opts.membershipId } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    },
  };
}

const incidentFacts = (over: Partial<IncidentAbacFacts> = {}): IncidentAbacFacts => ({
  incidentId: "inc-1",
  organizationId: ORG,
  kind: "fall",
  reportedByMembershipId: REPORTER,
  assignedToMembershipId: ASSIGNEE,
  ...over,
});

describe("M30 §4.7 incident ownership / visibility predicates", () => {
  const target: AbacTarget = { incidentId: "inc-1" };

  it("ownsIncident GRANTS the reporter and the assignee, DENIES a stranger", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({ incident: incidentFacts() }) });
    expect(await p.ownsIncident!(ctx({ membershipId: REPORTER }), target)).toBe(true);
    expect(await p.ownsIncident!(ctx({ membershipId: ASSIGNEE }), target)).toBe(true);
    expect(await p.ownsIncident!(ctx({ membershipId: STRANGER }), target)).toBe(false);
  });

  it("ownsIncident DENIES an actor with no active membership id (fail-closed)", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({ incident: incidentFacts() }) });
    expect(await p.ownsIncident!(ctx({ membershipId: null }), target)).toBe(false);
  });

  it("ownsIncident DENIES when the incident row is absent / cross-tenant (resolver returns null)", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({}) });
    expect(await p.ownsIncident!(ctx({ membershipId: REPORTER }), target)).toBe(false);
  });

  it("assignedToIncident GRANTS only the assignee (not the reporter)", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({ incident: incidentFacts() }) });
    expect(await p.assignedToIncident!(ctx({ membershipId: ASSIGNEE }), target)).toBe(true);
    expect(await p.assignedToIncident!(ctx({ membershipId: REPORTER }), target)).toBe(false);
  });

  it("incidentVisibility: a non-abuse incident is visible to an `incident.read` holder", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({ incident: incidentFacts() }) });
    expect(
      await p.incidentVisibility!(
        ctx({ membershipId: STRANGER, permissions: ["incident.read"] }),
        target,
      ),
    ).toBe(true);
  });

  it("incidentVisibility: an abuse incident is HIDDEN from a plain `incident.read` holder, shown to `incident.abuse_review`", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({ incident: incidentFacts({ kind: "allegation_of_abuse" }) }),
    });
    // a plain reader who is neither reporter nor assignee cannot see the abuse row (R-61)
    expect(
      await p.incidentVisibility!(
        ctx({ membershipId: STRANGER, permissions: ["incident.read"] }),
        target,
      ),
    ).toBe(false);
    // the abuse-review grant unlocks it
    expect(
      await p.incidentVisibility!(
        ctx({ membershipId: STRANGER, permissions: ["incident.abuse_review"] }),
        target,
      ),
    ).toBe(true);
    // the reporter still sees their own abuse report even without the grant
    expect(await p.incidentVisibility!(ctx({ membershipId: REPORTER }), target)).toBe(true);
  });

  it("capVerifyAuthority enforces SoD: a QAPI Coordinator who is NOT the assignee may verify; the assignee may NOT", async () => {
    const p = buildM30AbacPredicates({ resolver: resolverWith({ incident: incidentFacts() }) });
    // a coordinator distinct from the assignee → grant
    expect(
      await p.capVerifyAuthority!(
        ctx({ roles: ["qapi_coordinator"], membershipId: STRANGER }),
        target,
      ),
    ).toBe(true);
    // the assignee, even with the coordinator role, cannot self-verify (M30-F03 / ADR-0022)
    expect(
      await p.capVerifyAuthority!(
        ctx({ roles: ["qapi_coordinator"], membershipId: ASSIGNEE }),
        target,
      ),
    ).toBe(false);
    // no authority role → deny
    expect(await p.capVerifyAuthority!(ctx({ membershipId: STRANGER }), target)).toBe(false);
  });

  it("capVerifyAuthority DENIES on an unassigned incident (no assignee to separate from)", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({ incident: incidentFacts({ assignedToMembershipId: null }) }),
    });
    expect(
      await p.capVerifyAuthority!(
        ctx({ roles: ["qapi_coordinator"], membershipId: STRANGER }),
        target,
      ),
    ).toBe(false);
  });
});

describe("M30 §4.7 QAPI / SRA ownership + two-actor close predicates", () => {
  it("ownsQapiProject GRANTS the owner and any `qapi.admin` holder, DENIES a stranger", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({
        qapi: { projectId: "prj-1", organizationId: ORG, ownerMembershipId: OWNER },
      }),
    });
    const t: AbacTarget = { projectId: "prj-1" };
    expect(await p.ownsQapiProject!(ctx({ membershipId: OWNER }), t)).toBe(true);
    expect(
      await p.ownsQapiProject!(ctx({ membershipId: STRANGER, permissions: ["qapi.admin"] }), t),
    ).toBe(true);
    expect(await p.ownsQapiProject!(ctx({ membershipId: STRANGER }), t)).toBe(false);
  });

  it("qapiCloseAuthority requires TWO distinct actors in the {QAPI Coordinator, Medical Director} split", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({ roleKeysByMembership: { [COSIGNER]: ["medical_director"] } }),
    });
    const caller = ctx({ roles: ["qapi_coordinator"], membershipId: OWNER });
    // caller QC + cosigner MD, distinct → grant
    expect(await p.qapiCloseAuthority!(caller, { cosignerMembershipId: COSIGNER })).toBe(true);
    // same actor as cosigner → deny (must be two distinct actors)
    expect(await p.qapiCloseAuthority!(caller, { cosignerMembershipId: OWNER })).toBe(false);
    // no cosigner supplied → deny (fail-closed)
    expect(await p.qapiCloseAuthority!(caller, {})).toBe(false);
  });

  it("qapiCloseAuthority DENIES when the cosigner does NOT hold the complementary role", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({ roleKeysByMembership: { [COSIGNER]: ["qapi_coordinator"] } }),
    });
    // both QC — the two-role split is unmet
    const caller = ctx({ roles: ["qapi_coordinator"], membershipId: OWNER });
    expect(await p.qapiCloseAuthority!(caller, { cosignerMembershipId: COSIGNER })).toBe(false);
  });

  it("ownsSraCycle GRANTS owner / `sra.admin`; sraCloseAuthority requires the SO+CO two-role split", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({
        sra: { cycleId: "cyc-1", organizationId: ORG, ownerMembershipId: OWNER },
        roleKeysByMembership: { [COSIGNER]: ["compliance_officer"] },
      }),
    });
    expect(await p.ownsSraCycle!(ctx({ membershipId: OWNER }), { cycleId: "cyc-1" })).toBe(true);
    expect(
      await p.ownsSraCycle!(
        ctx({ membershipId: STRANGER, permissions: ["sra.admin"] }),
        { cycleId: "cyc-1" },
      ),
    ).toBe(true);
    // SO caller + CO cosigner, distinct → grant
    const caller = ctx({ roles: ["hipaa_security_officer"], membershipId: OWNER });
    expect(await p.sraCloseAuthority!(caller, { cosignerMembershipId: COSIGNER })).toBe(true);
    // caller alone (cosigner is SO too) → deny
    const p2 = buildM30AbacPredicates({
      resolver: resolverWith({ roleKeysByMembership: { [COSIGNER]: ["hipaa_security_officer"] } }),
    });
    expect(await p2.sraCloseAuthority!(caller, { cosignerMembershipId: COSIGNER })).toBe(false);
  });
});

describe("M30 §4.7 assignedToMortality", () => {
  it("GRANTS only the assigned reviewer, DENIES otherwise and when unassigned", async () => {
    const p = buildM30AbacPredicates({
      resolver: resolverWith({
        mortality: { reviewId: "rev-1", organizationId: ORG, assignedToMembershipId: ASSIGNEE },
      }),
    });
    const t: AbacTarget = { reviewId: "rev-1" };
    expect(await p.assignedToMortality!(ctx({ membershipId: ASSIGNEE }), t)).toBe(true);
    expect(await p.assignedToMortality!(ctx({ membershipId: STRANGER }), t)).toBe(false);

    const pUnassigned = buildM30AbacPredicates({
      resolver: resolverWith({
        mortality: { reviewId: "rev-1", organizationId: ORG, assignedToMembershipId: null },
      }),
    });
    expect(await pUnassigned.assignedToMortality!(ctx({ membershipId: ASSIGNEE }), t)).toBe(false);
  });
});

describe("M30 §6.7 fail-closed predicates (Part 2 redaction + abuse access)", () => {
  it("part2Redisclosure PASSES a non-Part-2 row but REDACTS a Part-2-promoted row by default (no covering release)", async () => {
    const p = buildM30AbacPredicates({ resolver: denyStubM30AbacResolver });
    // a plain `phi` row passes the redaction filter unconditionally
    expect(
      await p.part2Redisclosure!(ctx({ membershipId: REPORTER }), {
        retentionClass: "phi",
        patientId: "pat-1",
      }),
    ).toBe(true);
    // a Part-2-promoted row is redacted: the M5/M39 reach is not landed → no covering release
    expect(
      await p.part2Redisclosure!(ctx({ membershipId: REPORTER }), {
        retentionClass: "compliance_42cfr_part2",
        patientId: "pat-1",
      }),
    ).toBe(false);
    // a missing retention class is fail-closed (the route MUST supply it)
    expect(await p.part2Redisclosure!(ctx({ membershipId: REPORTER }), { patientId: "pat-1" })).toBe(
      false,
    );
    // a Part-2 row with no resolvable patient link → redact
    expect(
      await p.part2Redisclosure!(ctx({ membershipId: REPORTER }), {
        retentionClass: "compliance_42cfr_part2",
      }),
    ).toBe(false);
  });

  it("abuseAllegationAccess GRANTS only Compliance Officer / Administrator / `incident.abuse_review`; DENIES otherwise", async () => {
    const p = buildM30AbacPredicates({ resolver: denyStubM30AbacResolver });
    expect(await p.abuseAllegationAccess!(ctx({ roles: ["compliance_officer"] }), {})).toBe(true);
    expect(await p.abuseAllegationAccess!(ctx({ roles: ["administrator"] }), {})).toBe(true);
    expect(
      await p.abuseAllegationAccess!(ctx({ permissions: ["incident.abuse_review"] }), {}),
    ).toBe(true);
    // a member with an unrelated role and no grant is denied (fail-closed; R-61)
    expect(await p.abuseAllegationAccess!(ctx({ roles: ["nurse"] }), {})).toBe(false);
    expect(await p.abuseAllegationAccess!(ctx({}), {})).toBe(false);
  });
});

describe("M30 ABAC registry wiring", () => {
  it("registerM30AbacPredicates registers all eleven owned names idempotently (deny-stub default)", () => {
    expect(M30_REGISTERED_ABAC_PREDICATES).toHaveLength(11);
    registerM30AbacPredicates();
    for (const name of M30_REGISTERED_ABAC_PREDICATES) {
      expect(abacRegistry.has(name)).toBe(true);
    }
    // re-boot is a no-op (single-owner / no-clear registry guarded by `has`)
    expect(() => registerM30AbacPredicates()).not.toThrow();
  });

  it("with the default deny-stub resolver every owner predicate denies (boot before db bind)", async () => {
    const p = buildM30AbacPredicates({});
    expect(await p.ownsIncident!(ctx({ membershipId: REPORTER }), { incidentId: "inc-1" })).toBe(
      false,
    );
    expect(await p.ownsQapiProject!(ctx({ membershipId: OWNER }), { projectId: "prj-1" })).toBe(
      false,
    );
    expect(await p.assignedToMortality!(ctx({ membershipId: ASSIGNEE }), { reviewId: "rev-1" })).toBe(
      false,
    );
  });
});
