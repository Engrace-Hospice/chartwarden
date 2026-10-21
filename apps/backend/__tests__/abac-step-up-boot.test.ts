/**
 * M3-T07 — production boot wiring of the ABAC evaluator + `step_up_recent` predicate.
 *
 * Regression guard for the audit's top finding: `wireModuleSeams` registered every module's ABAC
 * predicate into `abacRegistry` but never called `registerAbacRegistry()` to point the contract's
 * evaluator at it — so the evaluator stayed at its fail-closed DENY_ALL default and EVERY mounted
 * `requireAbac`/`requireStepUp` route (M33/M34/M39/M40 …) denied in production. These tests prove the
 * composition-root `wireModuleSeams()` hook (1) installs the registry as the evaluator and (2) makes
 * `step_up_recent` resolve allow/deny from the M2 SessionContextResolver seam's recency state.
 */
import {
  type GuardRequest,
  abacRegistry,
  createInMemorySessionContextStore,
  requireStepUp,
  resetAuthorizationContract,
} from "@chartwarden/auth";
import { type HttpRequestContext, StepUpRequiredError } from "@chartwarden/types";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import { M3_STEP_UP_PREDICATE } from "../src/modules/03-authorization/index";

const ORG = "org-1";
const SESSION = "sess-1";

function makeRequest(over: Partial<HttpRequestContext> = {}): GuardRequest {
  return {
    context: {
      correlationId: "corr-1",
      userId: "user-1",
      organizationId: ORG,
      providerEntityIds: [],
      locationIds: [],
      roles: [],
      attributes: { sessionId: SESSION },
      ip: "127.0.0.1",
      userAgent: "vitest",
      startTime: 0,
      ...over,
    },
    params: {},
  };
}

/** Seed a session-context store with one session at a given step-up recency, then boot the seams. */
function bootWithSession(
  lastStepUpAt: Date | null,
  factor: "webauthn" | "totp" | "sms" | null,
): void {
  const { store } = createInMemorySessionContextStore([
    {
      providerEntityIds: [],
      locationIds: [],
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId: SESSION,
      userId: "user-1",
      membershipId: "mem-1",
      organizationId: ORG,
      roles: ["nurse"],
      lastStepUpAt,
      lastStepUpFactor: factor,
    },
  ]);
  wireModuleSeams({ sessionContextStore: store });
}

beforeEach(() => {
  __resetSeamsForTest();
  resetAuthorizationContract(); // evaluator back to DENY_ALL before each boot
});

describe("ABAC boot wiring (wireModuleSeams)", () => {
  it("registers the step_up_recent predicate into the registry", () => {
    bootWithSession(new Date(Date.now() - 60_000), "totp");
    expect(abacRegistry.has(M3_STEP_UP_PREDICATE)).toBe(true);
  });

  it("denies step-up before wiring (fail-closed DENY_ALL default)", async () => {
    // No wireModuleSeams() — the contract is at its reset default.
    await expect(
      requireStepUp("documents.export_phi_bundle")(makeRequest()),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  // F-084 — the ENVELOPE, not just the class. `code` is what five modules' `authFailureRedirect`
  // helpers branch on to route a refused ceremony to `/step-up`; the status stays 403 because the
  // request is refused, and because 138 route guards declare that response.
  it("denies with 403 STEP_UP_REQUIRED, distinguishable from a permission refusal", async () => {
    bootWithSession(new Date(Date.now() - 10 * 60_000), "totp");
    await expect(requireStepUp("documents.export_phi_bundle")(makeRequest())).rejects.toMatchObject(
      { code: "STEP_UP_REQUIRED", statusCode: 403 },
    );
  });

  it("allows a fresh step-up with a qualifying factor after wiring", async () => {
    bootWithSession(new Date(Date.now() - 60_000), "webauthn"); // 60s ago, within the 300s floor
    await expect(
      requireStepUp("documents.export_phi_bundle")(makeRequest()),
    ).resolves.toBeUndefined();
  });

  it("denies a stale step-up after wiring", async () => {
    bootWithSession(new Date(Date.now() - 10 * 60_000), "totp"); // 10 min ago, past the 300s floor
    await expect(
      requireStepUp("documents.export_phi_bundle")(makeRequest()),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("denies a non-qualifying factor (SMS) even when fresh", async () => {
    bootWithSession(new Date(Date.now() - 5_000), "sms");
    await expect(
      requireStepUp("documents.export_phi_bundle")(makeRequest()),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("denies when the request carries no session id (fail-closed)", async () => {
    bootWithSession(new Date(Date.now() - 60_000), "totp");
    await expect(
      requireStepUp("documents.export_phi_bundle")(makeRequest({ attributes: {} })),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });
});
