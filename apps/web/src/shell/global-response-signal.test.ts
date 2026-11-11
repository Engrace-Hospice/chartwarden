// apps/web/src/shell — F-081. The 401 the step-up verify route answers for a failed FACTOR is not the
// 401 that means the session is gone, and the shell has to be able to tell them apart.
//
// Before this, `signalForStatus` saw only the status, so a wrong TOTP code or a cancelled passkey
// bounced the user to `/expired` on their FIRST attempt. That made two things unreachable at once: the
// route's own lockout counter, which exists to allow `STEP_UP_POLICY.lockoutThreshold` consecutive
// failures before terminating the session, and the step-up screen's "That code didn't verify. Try
// again" branch, which no longer had a way to render.
import { clearIdempotencyKeys, createApiClient } from "@chartwarden/ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllDrafts, loadDraft, saveDraft } from "./ceremony-drafts";
import {
  getGlobalResponseSignal,
  handleObservedResponse,
  mayCarryTenantRefusal,
  onSessionExpired,
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

  it("does NOT sign the user out on a wrong screen-lock password (#589)", () => {
    // /auth/unlock answers 401 INVALID_CREDENTIALS for a wrong password on a perfectly live session.
    expect(signalForStatus(401, `${ORIGIN}/api/v1/auth/unlock`)).toBeNull();
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

// #589 phase 2 - a 401 ORGANIZATION_NOT_SELECTED is a live session that has not bound an org, not a dead one. It
// must route to the org picker and KEEP the user's drafts; only a genuine 401 may wipe them.
describe("org-less 401 (ORGANIZATION_NOT_SELECTED)", () => {
  const url = `${ORIGIN}/api/v1/patients`;
  const body401 = (code: string): Response =>
    new Response(JSON.stringify({ error: { code, message: "x" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  beforeEach(() => setGlobalResponseSignal(null)); // an earlier case may have left a signal
  afterEach(() => setGlobalResponseSignal(null));

  it("never lets an org-less 401 overwrite a pending session-expired", async () => {
    setGlobalResponseSignal({ kind: "session-expired" });
    handleObservedResponse(401, url, body401("ORGANIZATION_NOT_SELECTED"));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
  });

  it("signals org-not-selected and keeps drafts", async () => {
    saveDraft("dde:item-3", { panel: "outcome" });
    handleObservedResponse(401, url, body401("ORGANIZATION_NOT_SELECTED"));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "org-not-selected" });
    expect(loadDraft("dde:item-3")).toBeTruthy();
    clearAllDrafts();
  });

  it("still treats a plain UNAUTHORIZED 401 as session death and wipes drafts", async () => {
    saveDraft("dde:item-4", { panel: "outcome" });
    handleObservedResponse(401, url, body401("UNAUTHORIZED"));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
    expect(loadDraft("dde:item-4")).toBeUndefined();
  });

  it("falls back to session death when the 401 body is not JSON", async () => {
    handleObservedResponse(401, url, new Response("nope", { status: 401 }));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
  });
});

// ADR-0110 — the claims-billing gate's fail-closed 503 is one refused action, not an outage: navigating to
// /maintenance would throw away the form the user was filling in.
describe("503 BILLING_ENTITLEMENT_UNAVAILABLE", () => {
  const url = `${ORIGIN}/api/v1/claims/submit`;
  const body503 = (code: string): Response =>
    new Response(JSON.stringify({ error: { code, message: "x" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  afterEach(() => setGlobalResponseSignal(null));

  it("does not signal service-unavailable for the gate's own 503", async () => {
    handleObservedResponse(503, url, body503("BILLING_ENTITLEMENT_UNAVAILABLE"));
    await settle();
    expect(getGlobalResponseSignal()).toBeNull();
  });

  it("still signals service-unavailable for any other 503, JSON or not", async () => {
    handleObservedResponse(503, url, body503("DEGRADED"));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "service-unavailable" });
    setGlobalResponseSignal(null);
    handleObservedResponse(503, url, new Response("down", { status: 503 }));
    await settle();
    expect(getGlobalResponseSignal()).toEqual({ kind: "service-unavailable" });
  });
});

describe("held Idempotency-Keys and the shell's session decision", () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const answer = (status: number, code: string): Response =>
    new Response(JSON.stringify({ error: { code, message: "m" } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** The wiring main.tsx does: the client observes through handleObservedResponse, and the shell's session-expired clears the keys. */
  function wired(script: (Response | "no-answer")[]) {
    const keys: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      onResponseStatus: handleObservedResponse,
      fetch: async (request) => {
        keys.push(request.headers.get("Idempotency-Key"));
        const step = script.shift() ?? new Response("{}", { status: 200 });
        if (step === "no-answer") throw new TypeError("Failed to fetch");
        Object.defineProperty(step, "url", { value: request.url }); // a real fetch sets it; the shell decides by path
        return step;
      },
    });
    const unsubscribe = onSessionExpired(() => clearIdempotencyKeys(client));
    const write = () =>
      client
        .POST("/api/v1/orgs/{id}/notes" as never, { body: { a: 1 } } as never)
        .catch(() => undefined);
    const get = (path: string) => client.GET(path as never, {} as never).catch(() => undefined);
    return { keys, write, get, unsubscribe };
  }

  afterEach(() => setGlobalResponseSignal(null));

  it.each([
    ["a mistyped unlock password", "/api/v1/auth/unlock", "INVALID_CREDENTIALS"],
    ["a failed step-up factor", "/api/v1/sessions/step-up", "STEP_UP_FAILED"],
    ["a failed portal step-up factor", "/api/v1/portal/sessions/step-up", "STEP_UP_FAILED"],
    ["a live session with no organization yet", "/api/v1/patients", "ORGANIZATION_NOT_SELECTED"],
  ])("keeps a held key when the 401 is %s", async (_label, path, code) => {
    const { keys, write, get, unsubscribe } = wired(["no-answer", answer(401, code)]);

    await write(); // the reply was lost: its key is held
    await get(path); // a 401 that is NOT session death
    await settle();
    await write(); // the retry

    expect(getGlobalResponseSignal()?.kind).not.toBe("session-expired");
    expect(keys[2]).toBe(keys[0]);
    unsubscribe();
  });

  it("clears the held keys when the shell decides the session is dead", async () => {
    const { keys, write, get, unsubscribe } = wired(["no-answer", answer(401, "UNAUTHENTICATED")]);

    await write();
    await get("/api/v1/patients");
    await settle();
    await write();

    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
    expect(keys[2]).not.toBe(keys[0]);
    unsubscribe();
  });

  it("stops calling a hook once it is unsubscribed", () => {
    let calls = 0;
    const unsubscribe = onSessionExpired(() => {
      calls += 1;
    });

    setGlobalResponseSignal({ kind: "session-expired" });
    unsubscribe();
    setGlobalResponseSignal({ kind: "session-expired" });

    expect(calls).toBe(1);
  });
});
