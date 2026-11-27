// CW-PI-06 — Medicaid electronic submission stays disabled. Pricing a claim line locally is not a route to send it: the
// readiness function derives everything from its arguments, so this walks a cross product (every state the registry names,
// an unknown one and malformed ones, every program kind, both gateway and MCO and verification values; a free-text state
// cannot be enumerated) and asserts that no combination ever makes a route sendable, ever reports a provider enrollment or
// a trading partner certification as verified, and never refuses with anything but the one stable code. A gateway being
// bound is a configuration signal only. The synchronous submit route refuses with this code before any state change
// (live: m24-claim-line-assembly.live.test.ts); the durable submit worker records the readiness reason. If one of these
// assertions has to change, that is the moment to review the register row CW-PI-06 and the route qualification, not to
// edit the test.
import { describe, expect, it } from "vitest";
import {
  MEDICAID_NO_ELECTRONIC_GATEWAY_CODE,
  type MedicaidProgramKind,
  electronicSubmissionRefusal,
  medicaidClaimRouteReadiness,
} from "../src/registry";

// The registry's states (OR real adapter; WA, ID, CA, NV deny stubs), one it does not know, and malformed values.
const STATES = ["OR", "WA", "ID", "CA", "NV", "TX", "ZZ", "or", "", " OR "] as const;
const PROGRAM_KINDS: readonly (MedicaidProgramKind | undefined)[] = [
  undefined,
  "ffs_open_card",
  "managed_care",
  "other_managed_care",
  "unresolved",
  "ambiguous",
  "unsupported",
];
const MCO_IDS: readonly (string | null)[] = [null, "synthetic-mco"];
const BOOLEANS = [true, false] as const;
const REFUSED_STATUSES = [
  "transport_unconfigured",
  "certification_pending",
  "unsupported_program_route",
  "unsupported_state_program",
];

describe("no combination of state, gateway, MCO, program kind and verification makes a route sendable", () => {
  const cases = STATES.flatMap((state) =>
    BOOLEANS.flatMap((gatewayBound) =>
      MCO_IDS.flatMap((mcoId) =>
        PROGRAM_KINDS.flatMap((kind) =>
          BOOLEANS.map((verified) => ({ state, gatewayBound, mcoId, kind, verified })),
        ),
      ),
    ),
  );

  it("is never available, never verified, always refused with the one stable code", () => {
    for (const { state, gatewayBound, mcoId, kind, verified } of cases) {
      const label = `${state} gateway=${gatewayBound} mco=${mcoId} kind=${kind} verified=${verified}`;
      const readiness = medicaidClaimRouteReadiness(state, mcoId, gatewayBound, kind, verified);
      expect(readiness.submissionAvailable, label).toBe(false);
      expect(readiness.providerEnrollmentVerified, label).toBe(false);
      expect(readiness.tradingPartnerCertificationVerified, label).toBe(false);
      expect(readiness.outboundFormat, label).toBe("unverified");
      expect(readiness.localPreparationAvailable, label).toBe(true); // preparing a claim locally stays possible
      expect(REFUSED_STATUSES, label).toContain(readiness.status);

      const refusal = electronicSubmissionRefusal(state, gatewayBound, mcoId, kind, verified);
      expect(refusal, label).not.toBeNull();
      expect(refusal?.code, label).toBe(MEDICAID_NO_ELECTRONIC_GATEWAY_CODE);
      expect(refusal?.message.length, label).toBeGreaterThan(0);
    }
  });

  it("a bound gateway is configuration only: it can set transportConfigured, never anything else", () => {
    for (const { state, gatewayBound, mcoId, kind, verified } of cases) {
      const readiness = medicaidClaimRouteReadiness(state, mcoId, gatewayBound, kind, verified);
      expect(readiness.transportConfigured, `${state} gateway=${gatewayBound}`).toBe(
        state === "OR" && gatewayBound,
      );
    }
  });

  it("a caller's 'verified' flag means nothing for a program that did not resolve to one", () => {
    for (const kind of ["unresolved", "ambiguous", "unsupported"] as const) {
      for (const state of STATES) {
        expect(
          medicaidClaimRouteReadiness(state, "synthetic-mco", true, kind, true)
            .programAssignmentVerified,
          `${state} ${kind}`,
        ).toBe(false);
      }
    }
  });

  it("a historical row with no MCO and no recorded program kind is never read as fee-for-service", () => {
    for (const state of STATES) {
      const readiness = medicaidClaimRouteReadiness(state, null, true);
      expect(readiness.programKind, state).toBe("unresolved");
      expect(readiness.requestedChannel, state).toBeNull();
      expect(readiness.programAssignmentVerified, state).toBe(false);
    }
  });
});
