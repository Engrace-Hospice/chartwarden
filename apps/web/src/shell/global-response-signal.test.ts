// apps/web/src/shell — F-081. The 401 the step-up verify route answers for a failed FACTOR is not the
// 401 that means the session is gone, and the shell has to be able to tell them apart.
//
// Before this, `signalForStatus` saw only the status, so a wrong TOTP code or a cancelled passkey
// bounced the user to `/expired` on their FIRST attempt. That made two things unreachable at once: the
// route's own lockout counter, which exists to allow `STEP_UP_POLICY.lockoutThreshold` consecutive
// failures before terminating the session, and the step-up screen's "That code didn't verify. Try
// again" branch, which no longer had a way to render.
import { describe, expect, it } from "vitest";
import { loadDraft, saveDraft } from "./ceremony-drafts";
import {
  mayCarryTenantRefusal,
  setGlobalResponseSignal,
  signalForStatus,
  tenantSignalFromResponse,
} from "./global-response-signal";

const ORIGIN = "http://localhost:5173";

describe("signalForStatus", () => {
  it("treats a 401 as session death by default", () => {
    expect(signalForStatus(401, `${ORIGIN}/api/v1/patients`)).toEqual({ kind: "session-expired" });
  });

  it("does NOT sign the user out on a failed step-up verification", () => {
    expect(signalForStatus(401, `${ORIGIN}/api/v1/sessions/step-up`)).toBeNull();
    expect(signalForStatus(401, `${ORIGIN}/api/v1/portal/sessions/step-up`)).toBeNull();
  });

  it("still signs the user out on a 401 from step-up INITIATE", () => {
    // A different route: `initiate` 401s only when the session itself cannot be resolved, and its
    // "not enrolled" refusal is a 400. A prefix match would have swallowed this one.
    expect(signalForStatus(401, `${ORIGIN}/api/v1/sessions/step-up/initiate`)).toEqual({
      kind: "session-expired",
    });
  });

  it("falls back to session death when the URL is missing or unparseable", () => {
    expect(signalForStatus(401)).toEqual({ kind: "session-expired" });
    expect(signalForStatus(401, "")).toEqual({ kind: "session-expired" });
  });

  it("maps 503 to service-unavailable and ignores everything else", () => {
    expect(signalForStatus(503, `${ORIGIN}/api/v1/patients`)).toEqual({
      kind: "service-unavailable",
    });
    expect(signalForStatus(200, `${ORIGIN}/api/v1/patients`)).toBeNull();
    expect(signalForStatus(403, `${ORIGIN}/api/v1/patients`)).toBeNull();
  });
});

describe("ceremony drafts and a dead session", () => {
  it("forgets every draft when the session expires, so the next sign-in on this tab cannot restore it", () => {
    saveDraft("dde:item-1", { panel: "submit", submit: { dcn: "", notes: "PHI-bearing text" } });
    setGlobalResponseSignal({ kind: "session-expired" });
    expect(loadDraft("dde:item-1")).toBeUndefined();
    setGlobalResponseSignal(null);
  });

  it("keeps drafts through a 503 (the service is down, the session is not)", () => {
    saveDraft("dde:item-2", { panel: "outcome" });
    setGlobalResponseSignal({ kind: "service-unavailable" });
    expect(loadDraft("dde:item-2")).toBeTruthy();
    setGlobalResponseSignal(null);
  });
});

describe("tenant refusals (ADR-0049)", () => {
  const json = (status: number, code: string): Response =>
    new Response(JSON.stringify({ error: { code, message: "x" } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("maps TENANT_CLOSED / TENANT_SUSPENDED / TENANT_HOST_UNKNOWN to the three reasons", async () => {
    expect(await tenantSignalFromResponse(json(410, "TENANT_CLOSED"))).toEqual({
      kind: "tenant-unavailable",
      reason: "closed",
    });
    expect(await tenantSignalFromResponse(json(403, "TENANT_SUSPENDED"))).toEqual({
      kind: "tenant-unavailable",
      reason: "suspended",
    });
    expect(await tenantSignalFromResponse(json(404, "TENANT_HOST_UNKNOWN"))).toEqual({
      kind: "tenant-unavailable",
      reason: "unknown",
    });
  });

  it("leaves an ordinary 403 / 404 alone, and reads a clone so the caller still gets the body", async () => {
    const forbidden = json(403, "FORBIDDEN");
    expect(await tenantSignalFromResponse(forbidden)).toBeNull();
    expect(await tenantSignalFromResponse(json(404, "NOT_FOUND"))).toBeNull();
    const closed = json(410, "TENANT_CLOSED");
    await tenantSignalFromResponse(closed);
    expect(closed.bodyUsed).toBe(false);
  });

  it("ignores non-JSON and malformed bodies", async () => {
    expect(await tenantSignalFromResponse(new Response("<html>", { status: 404 }))).toBeNull();
    const bad = new Response("{", { status: 404, headers: { "content-type": "application/json" } });
    expect(await tenantSignalFromResponse(bad)).toBeNull();
  });

  it("only inspects 403/404/410 on /api/ outside the public routes", () => {
    expect(mayCarryTenantRefusal(410, `${ORIGIN}/api/auth/get-session`)).toBe(true);
    expect(mayCarryTenantRefusal(404, `${ORIGIN}/api/v1/auth/context`)).toBe(true);
    expect(mayCarryTenantRefusal(404, `${ORIGIN}/api/v1/public/tenant`)).toBe(false);
    expect(mayCarryTenantRefusal(500, `${ORIGIN}/api/v1/patients`)).toBe(false);
    expect(mayCarryTenantRefusal(404, `${ORIGIN}/assets/app.js`)).toBe(false);
    expect(mayCarryTenantRefusal(404)).toBe(false);
  });
});
