import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { sessionClassPathVerdict, tenantSessionClassGuard } from "../tenant-session-class";

const PORTAL = ["patient_portal", "caregiver_portal", "bereaved_portal"];

describe("sessionClassPathVerdict", () => {
  it.each(PORTAL)("%s: allowed on the portal API and session plumbing, refused on staff paths", (cls) => {
    for (const p of [
      "/api/v1/portal/care-summary",
      "/api/v1/portal/sign-in/establish",
      "/api/auth/get-session",
      "/api/v1/auth/csrf",
      "/api/v1/public/tenant",
      "/health",
      "/ready",
    ]) {
      expect(sessionClassPathVerdict(cls, p), p).toBe("allowed");
    }
    for (const p of ["/api/v1/patients", "/api/v1/me", "/api/v1/portalx/foo", "/api/v1/auditors/redeem"]) {
      expect(sessionClassPathVerdict(cls, p), p).toBe("portal-session-on-staff-path");
    }
  });

  it("staff: refused on /api/v1/portal/* except the pre-bind sign-in routes", () => {
    expect(sessionClassPathVerdict("staff", "/api/v1/portal/care-summary")).toBe("staff-session-on-portal-path");
    expect(sessionClassPathVerdict("staff", "/api/v1/portal/sessions/current")).toBe("staff-session-on-portal-path");
    expect(sessionClassPathVerdict("staff", "/api/v1/portal/sign-in/accounts")).toBe("allowed");
    expect(sessionClassPathVerdict("staff", "/api/v1/portal/sign-in/establish")).toBe("allowed");
    expect(sessionClassPathVerdict("staff", "/api/v1/patients")).toBe("allowed");
  });

  it("other classes and unauthenticated requests are not this hook's concern", () => {
    for (const cls of ["auditor", "external_collaborator", "funeral_home", undefined]) {
      expect(sessionClassPathVerdict(cls, "/api/v1/portal/care-summary")).toBe("allowed");
      expect(sessionClassPathVerdict(cls, "/api/v1/patients")).toBe("allowed");
    }
  });
});

describe("tenantSessionClassGuard", () => {
  const req = (url: string, attributes?: Record<string, unknown>, method = "GET") =>
    ({ url, method, context: { attributes } }) as unknown as FastifyRequest;

  it("answers 401 SESSION_CLASS_MISMATCH on a tenant host", async () => {
    await expect(
      tenantSessionClassGuard(req("/api/v1/patients?x=1", { tenantHostOrgId: "o", sessionClass: "patient_portal" })),
    ).rejects.toMatchObject({ code: "SESSION_CLASS_MISMATCH", statusCode: 401 });
    await expect(
      tenantSessionClassGuard(req("/api/v1/portal/care-summary", { tenantHostOrgId: "o", sessionClass: "staff" })),
    ).rejects.toMatchObject({ code: "SESSION_CLASS_MISMATCH" });
  });

  it("does nothing off a tenant host (demo, apex, reserved) or for a matching class", async () => {
    await expect(tenantSessionClassGuard(req("/api/v1/patients", { sessionClass: "patient_portal" }))).resolves.toBeUndefined();
    await expect(tenantSessionClassGuard(req("/api/v1/patients"))).resolves.toBeUndefined();
    await expect(
      tenantSessionClassGuard(req("/api/v1/portal/care-summary", { tenantHostOrgId: "o", sessionClass: "patient_portal" })),
    ).resolves.toBeUndefined();
  });

  it("matches the decoded path: a percent-encoded /portal segment does not bypass the staff-on-portal check", async () => {
    const staff = { tenantHostOrgId: "o", sessionClass: "staff" };
    await expect(tenantSessionClassGuard(req("/api/v1/%70ortal/care-summary", staff))).rejects.toMatchObject({
      code: "SESSION_CLASS_MISMATCH",
    });
    await expect(
      tenantSessionClassGuard(req("/api/v1/patients", { tenantHostOrgId: "o", sessionClass: "patient_portal" })),
    ).rejects.toMatchObject({ code: "SESSION_CLASS_MISMATCH" });
    await expect(tenantSessionClassGuard(req("/api/v1/portal%2Fcare", staff))).rejects.toMatchObject({
      code: "SESSION_CLASS_MISMATCH",
    });
  });

  it("answers 400 for a path that does not decode", async () => {
    await expect(
      tenantSessionClassGuard(req("/api/v1/%E0%A4%A", { tenantHostOrgId: "o", sessionClass: "staff" })),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets the token flows through a stale cookie of the other class (POST only)", async () => {
    const staff = { tenantHostOrgId: "o", sessionClass: "staff" };
    const portal = { tenantHostOrgId: "o", sessionClass: "patient_portal" };
    await expect(tenantSessionClassGuard(req("/api/v1/portal/invitations/accept", staff, "POST"))).resolves.toBeUndefined();
    await expect(tenantSessionClassGuard(req("/api/v1/collaborators/consume", portal, "POST"))).resolves.toBeUndefined();
    await expect(tenantSessionClassGuard(req("/api/v1/portal/invitations/accept", staff, "GET"))).rejects.toMatchObject({
      code: "SESSION_CLASS_MISMATCH",
    });
    await expect(tenantSessionClassGuard(req("/api/v1/collaborators/consume", portal, "GET"))).rejects.toMatchObject({
      code: "SESSION_CLASS_MISMATCH",
    });
  });
});
