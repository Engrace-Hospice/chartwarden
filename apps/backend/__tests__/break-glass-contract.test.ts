/**
 * audit #M3 — break-glass branch wiring over the durable store (registerBreakGlassContract, db path).
 *
 * Proves the §2.2 branch: with an open grant (async findActiveGrant — the widened, Drizzle-capable
 * interface), an ABAC-denied access is ALLOWED, the request is flagged, and one `m3.breakglass.access`
 * row is written at `critical` UNDER withOrgContext (the fake tx records the set_config + insert).
 */
import type { GuardRequest } from "@wardenx/auth";
import { BREAK_GLASS_ATTRIBUTE, requireAbac, resetAuthorizationContract } from "@wardenx/auth";
import type { HttpRequestContext } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import type { BreakGlassStore } from "../src/modules/03-authorization/authz-ports";
import { registerBreakGlassContract } from "../src/modules/03-authorization/contract";

interface Row {
  eventType: string;
  organizationId: string | null;
  severity: string;
  resourceId?: string;
}

/** Fake transactional DB: record set_config calls + captured audit rows. */
function fakeDb() {
  const rows: Row[] = [];
  const configs: string[] = [];
  const tx = {
    execute: async (q: unknown) => void configs.push(String(q)),
    insert: () => ({ values: async (row: Row) => void rows.push(row) }),
  };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db, rows, configs };
}

/** A store whose only relevant method is findActiveGrant (async — the Drizzle shape). */
function grantingStore(grant: { eventId: string } | null): BreakGlassStore {
  return { findActiveGrant: async () => grant } as unknown as BreakGlassStore;
}

function makeRequest(params: unknown = { patientId: "p1" }): GuardRequest {
  const context: HttpRequestContext = {
    correlationId: "corr-1",
    userId: "user-1",
    organizationId: "org-a",
    providerEntityIds: [],
    locationIds: [],
    roles: [],
    attributes: {},
    ip: "127.0.0.1",
    userAgent: "vitest",
    startTime: 0,
  };
  return { context, params };
}

afterEach(() => {
  resetAuthorizationContract();
});

describe("registerBreakGlassContract — db path", () => {
  it("opens the branch on a denied predicate and audits the access under withOrgContext", async () => {
    const { db, rows, configs } = fakeDb();
    registerBreakGlassContract({ store: grantingStore({ eventId: "bg-1" }), db: db as never });

    const request = makeRequest();
    // No ABAC evaluator registered → predicate denies → break-glass branch consults the grant.
    await expect(
      requireAbac("patient.read", "caseload_membership")(request),
    ).resolves.toBeUndefined();

    // Request flagged with the grant id, and exactly one critical access row written.
    expect(request.context.attributes[BREAK_GLASS_ATTRIBUTE]).toBe("bg-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("m3.breakglass.access");
    expect(rows[0].organizationId).toBe("org-a");
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].resourceId).toBe("p1");
    // The write ran inside withOrgContext → it set app.org_id + app.user_id (two set_config calls) first.
    expect(configs.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the branch shut when no grant is open (denied stays denied)", async () => {
    const { db, rows } = fakeDb();
    registerBreakGlassContract({ store: grantingStore(null), db: db as never });
    await expect(
      requireAbac("patient.read", "caseload_membership")(makeRequest()),
    ).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });
});
