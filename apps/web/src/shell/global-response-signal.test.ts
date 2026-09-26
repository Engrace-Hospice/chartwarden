// apps/web/src/shell — F-081. The 401 the step-up verify route answers for a failed FACTOR is not the
// 401 that means the session is gone, and the shell has to be able to tell them apart.
//
// Before this, `signalForStatus` saw only the status, so a wrong TOTP code or a cancelled passkey
// bounced the user to `/expired` on their FIRST attempt. That made two things unreachable at once: the
// route's own lockout counter, which exists to allow `STEP_UP_POLICY.lockoutThreshold` consecutive
// failures before terminating the session, and the step-up screen's "That code didn't verify. Try
// again" branch, which no longer had a way to render.
import { describe, expect, it } from "vitest";
import { signalForStatus } from "./global-response-signal";

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
