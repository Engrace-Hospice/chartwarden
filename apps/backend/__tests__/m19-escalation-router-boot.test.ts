// Boot path for ESCALATION_ROUTER_ORGS (ADR-0057 item 12): the registration runs inside wireModuleSeams, i.e. before validateSeams,
// so it must not look the deny-stub up in the registry. Proves a set variable boots, an allowlisted org reaches the M19 router and
// any other org still gets the deny-stub's answer.
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootSeams, escalationRouterDenyStub, getSeam } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";

const LISTED = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const request = (requiredRole: string) => ({
  patientId: PATIENT,
  requiredRole,
  tier: 1,
  asOf: "2026-06-01T12:00:00Z",
});

describe("ESCALATION_ROUTER_ORGS at boot", () => {
  const handle = createDbClient({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
  beforeEach(() => __resetSeamsForTest());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("boots with a valid uuid, serves the listed org from M19 and everyone else from the deny-stub", async () => {
    vi.stubEnv("ESCALATION_ROUTER_ORGS", ` ${LISTED.toUpperCase()}, not-a-uuid `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bootSeams(() => wireModuleSeams({ db: handle.db }));
    const router = getSeam("EscalationRouter");

    // A role M19 does not map is refused by the real router before any database read: source m19 proves it answered.
    const listed = await runWithRequestContext(
      { organizationId: LISTED, userId: "u" } as never,
      () => router.resolveTier(LISTED, request("physician")),
    );
    expect(listed).toMatchObject({
      kind: "unavailable",
      reason: "no_route_configured",
      source: "m19",
    });

    const other = await router.resolveTier(OTHER, request("rn"));
    expect(other).toEqual(await escalationRouterDenyStub.resolveTier(OTHER, request("rn")));
    expect(other).toMatchObject({ reason: "router_not_bound", source: "deny_stub" });

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("bound for 1 org(s)"))).toBe(true);
    expect(messages.some((m) => m.includes("1 entry is not a uuid"))).toBe(true);
    expect(messages.join(" ")).not.toContain(LISTED);
  });

  it("leaves the deny-stub in place when the variable is empty", async () => {
    vi.stubEnv("ESCALATION_ROUTER_ORGS", "");
    bootSeams(() => wireModuleSeams({ db: handle.db }));
    expect(await getSeam("EscalationRouter").resolveTier(LISTED, request("rn"))).toMatchObject({
      reason: "router_not_bound",
      source: "deny_stub",
    });
  });
});
