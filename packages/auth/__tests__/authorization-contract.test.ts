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
} from "@chartwarden/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREAK_GLASS_ATTRIBUTE,
  type GuardRequest,
  composeGuards,
  registerBreakGlassSubject,
  requireAbac,
  requireAnyAbac,
  requirePermission,
  requireRole,
  requireSession,
  requireStepUp,
  resetAuthorizationContract,
  resolveActorPermissions,
  setAbacEvaluator,
  setBreakGlassAuditHook,
  setBreakGlassChecker,
  setEffectivePermissionResolver,
  singleBreakGlassSubject,
} from "../src/index";

function makeRequest(
  contextOverrides: Partial<HttpRequestContext> = {},
  params: unknown = {},
  method: string | undefined = "GET",
): GuardRequest {
  return {
    method,
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

describe("requirePermission — service principal (#678)", () => {
  const system = () =>
    makeRequest({ userId: "system", attributes: { actorKind: "system" } as never });

  it("grants *_internal seam keys without consulting the membership resolver", async () => {
    const resolver = vi.fn(() => new Set<string>());
    setEffectivePermissionResolver(resolver);
    await expect(
      requirePermission("remittance.ingest_internal")(system()),
    ).resolves.toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("denies a user-facing key to the service principal", async () => {
    setEffectivePermissionResolver(() => new Set(["role.manage"]));
    await expect(requirePermission("role.manage")(system())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('only the exact kind "system" bypasses; a user holding the key still goes through the resolver', async () => {
    setEffectivePermissionResolver(() => new Set(["remittance.ingest_internal"]));
    const user = makeRequest({ attributes: { actorKind: "user" } as never });
    await expect(requirePermission("remittance.ingest_internal")(user)).resolves.toBeUndefined();
    const spoof = makeRequest({ attributes: { actorKind: "system_x" } as never });
    setEffectivePermissionResolver(() => new Set<string>());
    await expect(requirePermission("remittance.ingest_internal")(spoof)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("resolveActorPermissions never hands the literal system id to the resolver", async () => {
    const resolver = vi.fn(() => new Set(["x"]));
    setEffectivePermissionResolver(resolver);
    expect((await resolveActorPermissions({ organizationId: "o", userId: "system" })).size).toBe(0);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not elevate a user session that merely lacks the key", async () => {
    await expect(
      requirePermission("remittance.ingest_internal")(makeRequest()),
    ).rejects.toBeInstanceOf(ForbiddenError);
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

describe("break-glass is read-only (CW-AC-03)", () => {
  const deny = () => setAbacEvaluator(() => false);

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "never opens a %s, whatever predicate denied",
    async (method) => {
      deny();
      const checker = vi.fn(() => ({ eventId: "bg-1" }));
      setBreakGlassChecker(checker);
      await expect(
        requireAbac("admission.hold", "admission.scope", { notFoundOnDeny: true })(
          makeRequest({}, { id: "adm-1" }, method),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(checker).not.toHaveBeenCalled();
    },
  );

  it("never opens a request that carries no method (fail closed)", async () => {
    deny();
    const checker = vi.fn(() => ({ eventId: "bg-1" }));
    setBreakGlassChecker(checker);
    await expect(
      requireAbac("admission.read", "admission.scope")({ ...makeRequest(), method: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(checker).not.toHaveBeenCalled();
  });

  it.each(["GET", "get", "HEAD"])("opens a %s", async (method) => {
    deny();
    setBreakGlassChecker(() => ({ eventId: "bg-1" }));
    await expect(
      requireAbac("admission.read", "admission.scope")(makeRequest({}, { id: "adm-1" }, method)),
    ).resolves.toBeUndefined();
  });
});

describe("singleBreakGlassSubject (CW-AC-03)", () => {
  it("names the patient only when every named id resolved to the same one", () => {
    expect(singleBreakGlassSubject(["p-1"])).toBe("p-1");
    expect(singleBreakGlassSubject(["p-1", "p-1"])).toBe("p-1");
  });

  it.each([
    ["nothing named", []],
    ["a named id that did not resolve", ["p-1", null]],
    ["only unresolved ids", [null]],
    ["two different patients", ["p-1", "p-2"]],
    ["an empty id", [""]],
  ] as const)("covers nothing for %s", (_label, ids) => {
    expect(singleBreakGlassSubject(ids)).toBeNull();
  });
});

describe("break-glass subject resolver (CW-AC-03): an id-keyed predicate's patient", () => {
  const ORG_CTX = { organizationId: "org-1", userId: "user-1" };

  it("hands the checker and the critical audit the patient the denied predicate resolved", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("admission.scope", () => "patient-5");
    const checker = vi.fn(() => ({ eventId: "bg-9" }));
    const auditHook = vi.fn();
    setBreakGlassChecker(checker);
    setBreakGlassAuditHook(auditHook);

    const request = makeRequest(ORG_CTX, { id: "adm-1" });
    await requireAbac("admission.read", "admission.scope", { notFoundOnDeny: true })(request);

    expect(checker).toHaveBeenCalledWith(expect.anything(), "admission.read", {
      id: "adm-1",
      patientId: "patient-5",
    });
    expect(auditHook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admission.read",
        target: { id: "adm-1", patientId: "patient-5" },
      }),
    );
    expect(request.context.attributes[BREAK_GLASS_ATTRIBUTE]).toBe("bg-9");
  });

  it("passes the resolver the same context and target the predicate saw", async () => {
    setAbacEvaluator(() => false);
    const resolver = vi.fn(() => "patient-5");
    registerBreakGlassSubject("encounter.scope", resolver);
    setBreakGlassChecker(() => ({ eventId: "bg-9" }));

    await requireAbac(
      "encounter.read",
      "encounter.scope",
    )(makeRequest(ORG_CTX, { encounterId: "enc-1" }));
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining(ORG_CTX), {
      encounterId: "enc-1",
    });
  });

  it("covers nothing when the predicate names no single patient (the checker sees no patientId)", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("idg_meeting_scope", () => null);
    const checker = vi.fn(() => null);
    setBreakGlassChecker(checker);

    await expect(
      requireAbac("idg.read", "idg_meeting_scope", { notFoundOnDeny: true })(
        makeRequest(ORG_CTX, { id: "mtg-1" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(checker).toHaveBeenCalledWith(expect.anything(), "idg.read", { id: "mtg-1" });
  });

  it("trusts the resolver over a patientId already on the target (a target naming two patients)", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("emar.scope", () => null);
    const checker = vi.fn(() => null);
    setBreakGlassChecker(checker);

    await expect(
      requireAbac("administration.read", "emar.scope", {
        notFoundOnDeny: true,
        getTarget: () => ({ patientId: "patient-A", administrationId: "adm-of-patient-C" }),
      })(makeRequest(ORG_CTX)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(checker).toHaveBeenCalledWith(expect.anything(), "administration.read", {
      administrationId: "adm-of-patient-C",
    });
  });

  it("leaves a predicate with no resolver exactly as before (its own patientId reaches the checker)", async () => {
    setAbacEvaluator(() => false);
    const checker = vi.fn(() => ({ eventId: "bg-3" }));
    setBreakGlassChecker(checker);

    await requireAbac("patient.read", "caseload_or_scope", {
      getTarget: () => ({ patientId: "patient-1" }),
    })(makeRequest(ORG_CTX));
    expect(checker).toHaveBeenCalledWith(expect.anything(), "patient.read", {
      patientId: "patient-1",
    });
  });

  it("asks the first denied predicate that has a resolver when several are OR-composed", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("admission.scope", () => "patient-5");
    const checker = vi.fn(() => ({ eventId: "bg-4" }));
    setBreakGlassChecker(checker);

    await requireAnyAbac("admission.read", ["admission_intake_scope", "admission.scope"])(
      makeRequest(ORG_CTX, { id: "adm-1" }),
    );
    expect(checker).toHaveBeenCalledWith(expect.anything(), "admission.read", {
      id: "adm-1",
      patientId: "patient-5",
    });
  });

  it("does not consult a resolver when the predicate allows, or when the guard opts out of break-glass", async () => {
    const resolver = vi.fn(() => "patient-5");
    registerBreakGlassSubject("admission.scope", resolver);
    setAbacEvaluator(() => true);
    await requireAbac("admission.read", "admission.scope")(makeRequest());
    setAbacEvaluator(() => false);
    await expect(
      requireAbac("admission.read", "admission.scope", { breakGlassBypassable: false })(
        makeRequest(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("a resolver failure is not swallowed into a grant: it surfaces (the guard never opens on an error)", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("admission.scope", () => {
      throw new Error("lookup failed");
    });
    const checker = vi.fn(() => ({ eventId: "bg-1" }));
    setBreakGlassChecker(checker);

    await expect(requireAbac("admission.read", "admission.scope")(makeRequest())).rejects.toThrow(
      "lookup failed",
    );
    expect(checker).not.toHaveBeenCalled();
  });

  it("the first registration of a predicate's resolver wins (it stays with the predicate it was registered beside)", async () => {
    setAbacEvaluator(() => false);
    registerBreakGlassSubject("admission.scope", () => "patient-first");
    registerBreakGlassSubject("admission.scope", () => "patient-second");
    const checker = vi.fn(() => null);
    setBreakGlassChecker(checker);

    await expect(requireAbac("admission.read", "admission.scope")(makeRequest())).rejects.toThrow();
    expect(checker).toHaveBeenCalledWith(expect.anything(), "admission.read", {
      patientId: "patient-first",
    });
  });

  it("resetAuthorizationContract drops the registered resolvers", async () => {
    registerBreakGlassSubject("admission.scope", () => "patient-5");
    resetAuthorizationContract();
    setAbacEvaluator(() => false);
    const checker = vi.fn(() => null);
    setBreakGlassChecker(checker);

    await expect(
      requireAbac("admission.read", "admission.scope")(makeRequest({}, { id: "adm-1" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(checker).toHaveBeenCalledWith(expect.anything(), "admission.read", { id: "adm-1" });
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
