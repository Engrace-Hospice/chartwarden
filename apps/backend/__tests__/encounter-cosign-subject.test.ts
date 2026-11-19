// S1 PR E2b - the cosignature workflow generalised by SUBJECT (ADR-0114 VN-D30): the note's own request or the request an amending addendum opened. The
// pure parts: which subject a route names, and the display status of an amendment's cosignature. The state machine itself is unchanged (encounter-cosignature.test.ts).
import { describe, expect, it } from "vitest";
import {
  COSIGN_OPEN_STATUSES,
  cosignDisplayStatus,
  cosignSubjectOf,
  eligibleCosigner,
} from "../src/modules/08-encounters/cosignature/subject";

const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";

describe("cosignSubjectOf", () => {
  it("is the note's own request when no addendum is named", () => {
    expect(cosignSubjectOf(ENCOUNTER)).toEqual({ kind: "note", encounterId: ENCOUNTER });
    expect(cosignSubjectOf(ENCOUNTER, undefined)).toEqual({ kind: "note", encounterId: ENCOUNTER });
  });

  it("is an addendum's request when one is named, always under its own encounter", () => {
    expect(cosignSubjectOf(ENCOUNTER, ADDENDUM)).toEqual({
      kind: "addendum",
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
    });
  });
});

describe("cosignDisplayStatus: where an amendment's cosignature stands, for a screen", () => {
  it("no request means none is required", () => {
    expect(cosignDisplayStatus(null)).toBe("not_required");
  });

  it("every status that still awaits the cosigner is pending (the SLA stages are alerts, not a different answer)", () => {
    for (const status of [
      "pending",
      "routed",
      "acknowledged",
      "escalated",
      "hard_cap_reached",
    ] as const) {
      expect(cosignDisplayStatus(status), status).toBe("pending");
    }
  });

  it("a supervisor release is released (the cosigner still has to sign), and a signed request is cosigned", () => {
    expect(cosignDisplayStatus("supervisor_released")).toBe("released");
    expect(cosignDisplayStatus("signed")).toBe("cosigned");
  });

  it("the queue lists exactly the requests that still await a signature", () => {
    expect([...COSIGN_OPEN_STATUSES].sort()).toEqual(
      ["acknowledged", "escalated", "hard_cap_reached", "routed", "supervisor_released"].sort(),
    );
  });
});

describe("eligibleCosigner: the RN a request may be routed to (C3)", () => {
  const RN = "00000000-0000-4000-8000-0000000000a1";
  const SIGNER = "00000000-0000-4000-8000-0000000000a2";
  const NOTE_AUTHOR = "00000000-0000-4000-8000-0000000000a3";

  it("is the case-management RN when nobody excluded is that RN", () => {
    expect(eligibleCosigner(RN, [SIGNER, NOTE_AUTHOR])).toBe(RN);
  });

  it("is nobody when the care team names no RN", () => {
    expect(eligibleCosigner(null, [SIGNER])).toBeNull();
  });

  it("is nobody when the RN is the signer: a request never cosigns itself", () => {
    expect(eligibleCosigner(SIGNER, [SIGNER])).toBeNull();
  });

  it("is nobody when the RN is the note's author, whom the cosign service refuses at acknowledge and sign: the request would wait for ever", () => {
    expect(eligibleCosigner(NOTE_AUTHOR, [SIGNER, NOTE_AUTHOR])).toBeNull();
  });
});
