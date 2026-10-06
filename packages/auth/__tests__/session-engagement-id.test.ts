// packages/auth/__tests__/session-engagement-id.test.ts — GAP-093(c): the auditor's engagement id is a
// SERVER-SIDE session fact. It is read off `session.scope.engagementId` through the CLASS predicate, so
// a staff session carrying a stray key stamps nothing, and an auditor session without its window columns
// (which `session_scope_chk` would refuse to write) resolves no engagement either.
import { describe, expect, it } from "vitest";
import { toSessionContextRecord } from "../src/identity/db-session-store";
import { sessionEngagementId } from "../src/identity/session-classes";

const ENGAGEMENT = "44444444-4444-4444-8444-444444444444";
const WINDOW = { engagementStart: "2026-10-01T00:00:00Z", engagementEnd: "2026-10-15T00:00:00Z" };

describe("sessionEngagementId (class-gated)", () => {
  it("returns the engagement for an auditor session with its window", () => {
    expect(
      sessionEngagementId({
        sessionClass: "auditor",
        scope: { engagementId: ENGAGEMENT },
        ...WINDOW,
      }),
    ).toBe(ENGAGEMENT);
  });

  it("returns null on every class that is not auditor, even with a stray key", () => {
    for (const sessionClass of [
      "staff",
      "external_collaborator",
      "funeral_home",
      "patient_portal",
      "caregiver_portal",
      "bereaved_portal",
    ] as const) {
      expect(
        sessionEngagementId({
          sessionClass,
          scope: { engagementId: ENGAGEMENT, patientId: "p", portalAccountId: "a" },
          ...WINDOW,
        }),
      ).toBeNull();
    }
  });

  it("returns null for an auditor session missing the key or either window bound", () => {
    expect(sessionEngagementId({ sessionClass: "auditor", scope: {}, ...WINDOW })).toBeNull();
    expect(sessionEngagementId({ sessionClass: "auditor", scope: null, ...WINDOW })).toBeNull();
    expect(
      sessionEngagementId({ sessionClass: "auditor", scope: { engagementId: ENGAGEMENT } }),
    ).toBeNull();
    expect(
      sessionEngagementId({
        sessionClass: "auditor",
        scope: { engagementId: ENGAGEMENT },
        engagementStart: WINDOW.engagementStart,
        engagementEnd: null,
      }),
    ).toBeNull();
    expect(
      sessionEngagementId({ sessionClass: "auditor", scope: { engagementId: "" }, ...WINDOW }),
    ).toBeNull();
  });
});

describe("toSessionContextRecord — engagementId", () => {
  const base = {
    userId: "u1",
    activeOrganizationId: "org1",
    lastStepUpAt: null,
    lastStepUpFactor: null,
    deviceAttestation: null,
  };

  it("carries an auditor session's engagement off the row", () => {
    const rec = toSessionContextRecord(
      {
        ...base,
        sessionClass: "auditor",
        scope: { engagementId: ENGAGEMENT },
        engagementStart: new Date(WINDOW.engagementStart),
        engagementEnd: new Date(WINDOW.engagementEnd),
      },
      "s1",
    );
    expect(rec.sessionClass).toBe("auditor");
    expect(rec.engagementId).toBe(ENGAGEMENT);
  });

  it("reads null for a staff session carrying a stray engagementId", () => {
    const rec = toSessionContextRecord(
      { ...base, sessionClass: "staff", scope: { engagementId: ENGAGEMENT } },
      "s2",
    );
    expect(rec.engagementId).toBeNull();
  });

  it("survives a malformed scope", () => {
    for (const scope of [null, undefined, "x", 42, { engagementId: 7 }]) {
      const rec = toSessionContextRecord(
        {
          ...base,
          sessionClass: "auditor",
          scope,
          engagementStart: new Date(WINDOW.engagementStart),
          engagementEnd: new Date(WINDOW.engagementEnd),
        },
        "s3",
      );
      expect(rec.engagementId).toBeNull();
    }
  });
});
