/**
 * M3-T05 — The Authorization Contract (M3 spec §4.1, §2.2).
 *
 * Accept criterion: "unit tests on the resolution pipeline ordering." These exercise the
 * single guard surface every module consumes — `requireSession` / `requireRole` /
 * `requirePermission` (RBAC) and `requireAbac` (ABAC) — and prove the §2.2 decision order
 * authenticate → RBAC → ABAC → (break-glass branch), all DENY BY DEFAULT: with no resolver
 * / evaluator / break-glass seam registered, every gate fails closed.
 */
import {
  ForbiddenError,
  type HttpRequestContext,
  NotFoundError,
  UnauthorizedError,
} from "@wardenx/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREAK_GLASS_ATTRIBUTE,
  type GuardRequest,
  composeGuards,
  requireAbac,
  requireAnyAbac,
  requirePermission,
  requireRole,
  requireSession,
  requireStepUp,
  resetAuthorizationContract,
  setAbacEvaluator,
  setBreakGlassAuditHook,
  setBreakGlassChecker,
  setEffectivePermissionResolver,
} from "../src/index";

function makeRequest(
  contextOverrides: Partial<HttpRequestContext> = {},
  params: unknown = {},
): GuardRequest {
  return {
    context: {
      correlationId: "corr-1",
      userId: "user-1",
      organizationId: "org-1",
      providerEntityIds: [],
      locationIds: [],
      roles: [],
      attributes: {},
      ip: "127.0.0.1",
      userAgent: "vitest",
      startTime: 0,
      ...contextOverrides,
    },
    params,
  };
}

beforeEach(() => {
  resetAuthorizationContract();
});

describe("requireSession", () => {
  it("passes an org-scoped session", async () => {
    await expect(requireSession()(makeRequest())).resolves.toBeUndefined();
  });

  it("401s when no org-scoped session is present", async () => {
    await expect(requireSession()(makeRequest({ organizationId: "" }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("requireRole", () => {
  it("passes when the session holds one of the named roles", async () => {
    await expect(
      requireRole("compliance_officer", "org_admin")(makeRequest({ roles: ["org_admin"] })),
    ).resolves.toBeUndefined();
  });

  it("403s when the session holds none of the named roles", async () => {
    await expect(
      requireRole("org_admin")(makeRequest({ roles: ["nurse"] })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("requirePermission — deny by default (§2.2)", () => {
  it("403s with no resolver registered (fail closed)", async () => {
    await expect(requirePermission("role.read")(makeRequest())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("passes only keys in the resolved effective set", async () => {
    setEffectivePermissionResolver(() => new Set(["role.read"]));
    await expect(requirePermission("role.read")(makeRequest())).resolves.toBeUndefined();
    await expect(requirePermission("role.manage")(makeRequest())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("supports an async (DB-backed) resolver", async () => {
    setEffectivePermissionResolver(async () => new Set(["engagement.read"]));
    await expect(requirePermission("engagement.read")(makeRequest())).resolves.toBeUndefined();
  });
});

describe("requireAbac — deny by default + break-glass branch (§2.2)", () => {
  it("403s when the predicate is unregistered (a missing predicate is a deny, not an allow)", async () => {
    await expect(
      requireAbac("encounter.sign", "caseload_membership")(makeRequest()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s on denial under the existence non-leak rule", async () => {
    await expect(
      requireAbac("breakglass.read", "engagement_scope", { notFoundOnDeny: true })(makeRequest()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("allows when the named predicate evaluates true", async () => {
    setAbacEvaluator((predicate) => predicate === "caseload_membership");
    await expect(
      requireAbac("encounter.sign", "caseload_membership")(makeRequest()),
    ).resolves.toBeUndefined();
  });

  it("passes the server-assembled context + target to the predicate (never client input)", async () => {
    const evaluator = vi.fn(() => true);
    setAbacEvaluator(evaluator);
    await requireAbac(
      "encounter.sign",
      "caseload_membership",
    )(makeRequest({ organizationId: "org-7", roles: ["nurse"] }, { id: "patient-9" }));
    expect(evaluator).toHaveBeenCalledWith(
      "caseload_membership",
      expect.objectContaining({ organizationId: "org-7", roles: ["nurse"] }),
      { id: "patient-9" },
    );
  });

  it("opens the break-glass branch: allow + flag the request + audit critical", async () => {
    const auditHook = vi.fn();
    setBreakGlassChecker(() => ({ eventId: "bg-42" }));
    setBreakGlassAuditHook(auditHook);

    const request = makeRequest({}, { id: "patient-9" });
    await expect(
      requireAbac("encounter.read", "caseload_membership")(request),
    ).resolves.toBeUndefined();

    expect(request.context.attributes[BREAK_GLASS_ATTRIBUTE]).toBe("bg-42");
    expect(auditHook).toHaveBeenCalledWith(
      expect.objectContaining({ grant: { eventId: "bg-42" }, action: "encounter.read" }),
    );
  });

  it("requireStepUp binds the step_up_recent predicate with the operation key as target", async () => {
    const evaluator = vi.fn(() => true);
    setAbacEvaluator(evaluator);
    await requireStepUp("step_up.override.manage")(makeRequest());
    expect(evaluator).toHaveBeenCalledWith("step_up_recent", expect.any(Object), {
      operationKey: "step_up.override.manage",
    });
  });
});

describe("requireAnyAbac — OR over named predicates, same deny + break-glass semantics", () => {
  it("allows when the FIRST predicate is true, without evaluating the second", async () => {
    const evaluator = vi.fn((predicate: string) => predicate === "caseload_or_scope");
    setAbacEvaluator(evaluator);
    await expect(
      requireAnyAbac("admission.read", ["caseload_or_scope", "admission_intake_scope"])(
        makeRequest(),
      ),
    ).resolves.toBeUndefined();
    expect(evaluator).toHaveBeenCalledTimes(1);
  });

  it("allows when only a LATER predicate is true, over the same target", async () => {
    const evaluator = vi.fn((predicate: string) => predicate === "admission_intake_scope");
    setAbacEvaluator(evaluator);
    await expect(
      requireAnyAbac("admission.read", ["caseload_or_scope", "admission_intake_scope"], {
        getTarget: () => ({ patientId: "p-1" }),
      })(makeRequest()),
    ).resolves.toBeUndefined();
    expect(evaluator).toHaveBeenNthCalledWith(1, "caseload_or_scope", expect.any(Object), {
      patientId: "p-1",
    });
    expect(evaluator).toHaveBeenNthCalledWith(2, "admission_intake_scope", expect.any(Object), {
      patientId: "p-1",
    });
  });

  it("denies 404 under notFoundOnDeny / 403 otherwise when every predicate is false", async () => {
    setAbacEvaluator(() => false);
    const names = ["caseload_or_scope", "admission_intake_scope"];
    await expect(
      requireAnyAbac("admission.read", names, { notFoundOnDeny: true })(makeRequest()),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAnyAbac("admission.read", names)(makeRequest())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("consults break-glass once, only after every predicate denied", async () => {
    setAbacEvaluator(() => false);
    const checker = vi.fn(() => ({ eventId: "bg-7" }));
    setBreakGlassChecker(checker);
    const request = makeRequest();
    await expect(
      requireAnyAbac("admission.read", ["caseload_or_scope", "admission_intake_scope"])(request),
    ).resolves.toBeUndefined();
    expect(checker).toHaveBeenCalledTimes(1);
    expect(request.context.attributes[BREAK_GLASS_ATTRIBUTE]).toBe("bg-7");
  });

  it("refuses an empty predicate list at definition time", () => {
    expect(() => requireAnyAbac("admission.read", [])).toThrow();
  });
});

describe("resolution pipeline ordering (§2.2: authenticate → RBAC → ABAC)", () => {
  it("short-circuits at the session check; RBAC + ABAC never run", async () => {
    const resolver = vi.fn(() => new Set<string>(["role.read"]));
    const evaluator = vi.fn(() => true);
    setEffectivePermissionResolver(resolver);
    setAbacEvaluator(evaluator);

    const chain = composeGuards(
      requireSession(),
      requirePermission("role.read"),
      requireAbac("role.read", "engagement_scope"),
    );
    await expect(chain(makeRequest({ organizationId: "" }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("runs RBAC before ABAC and stops at an RBAC denial", async () => {
    const evaluator = vi.fn(() => true);
    setAbacEvaluator(evaluator); // would allow — but ABAC must never be reached
    // no resolver → requirePermission denies

    const chain = composeGuards(
      requireSession(),
      requirePermission("role.manage"),
      requireAbac("role.manage", "engagement_scope"),
    );
    await expect(chain(makeRequest())).rejects.toBeInstanceOf(ForbiddenError);
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("evaluates RBAC strictly before ABAC on the happy path", async () => {
    const order: string[] = [];
    setEffectivePermissionResolver(() => {
      order.push("rbac");
      return new Set(["role.read"]);
    });
    setAbacEvaluator(() => {
      order.push("abac");
      return true;
    });

    const chain = composeGuards(
      requireSession(),
      requirePermission("role.read"),
      requireAbac("role.read", "engagement_scope"),
    );
    await expect(chain(makeRequest())).resolves.toBeUndefined();
    expect(order).toEqual(["rbac", "abac"]);
  });
});
