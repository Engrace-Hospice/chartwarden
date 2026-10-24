// ADR-0099 D3/D8/D18 - family access is available only when per-address budgets key on a real client address AND the code pepper is present. Anything else
// fails closed: production, staging, a typo, an unset NODE_ENV, an over-broad proxy list, a short or missing pepper.
import { describe, expect, it } from "vitest";
import { familyEventPayload } from "./family-events";
import { familyAccessAvailability } from "./family-access-gate";

const PEPPER = "z".repeat(32);

describe("familyAccessAvailability", () => {
  it("is available locally with a pepper", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const out = familyAccessAvailability({ NODE_ENV, MESSAGING_FAMILY_CODE_PEPPER: PEPPER });
      expect(out).toMatchObject({ available: true, pepper: PEPPER, warning: null });
    }
  });

  it("is available in production only with a VALID proxy list and a pepper", () => {
    expect(familyAccessAvailability({ NODE_ENV: "production", TRUSTED_PROXY_CIDRS: "10.0.0.0/8", MESSAGING_FAMILY_CODE_PEPPER: PEPPER }).available).toBe(true);
    for (const TRUSTED_PROXY_CIDRS of [undefined, "", "0.0.0.0/0", "*", "true", "10.0.0.0/8,bogus"]) {
      const out = familyAccessAvailability({ NODE_ENV: "production", TRUSTED_PROXY_CIDRS, MESSAGING_FAMILY_CODE_PEPPER: PEPPER });
      expect(out.available, String(TRUSTED_PROXY_CIDRS)).toBe(false);
      expect(out.pepper).toBeNull();
    }
  });

  it("fails closed without a long-enough pepper, even locally", () => {
    for (const MESSAGING_FAMILY_CODE_PEPPER of [undefined, "", "short", "y".repeat(31)]) {
      const out = familyAccessAvailability({ NODE_ENV: "development", MESSAGING_FAMILY_CODE_PEPPER });
      expect(out.available).toBe(false);
      expect(out.warning).toContain("MESSAGING_FAMILY_CODE_PEPPER");
    }
  });

  it("treats staging, prod and an unset NODE_ENV as production", () => {
    for (const NODE_ENV of ["staging", "prod", "", undefined]) {
      expect(familyAccessAvailability({ NODE_ENV, MESSAGING_FAMILY_CODE_PEPPER: PEPPER }).available).toBe(false);
    }
  });

  it("never puts the pepper in the warning", () => {
    const out = familyAccessAvailability({ NODE_ENV: "production", MESSAGING_FAMILY_CODE_PEPPER: PEPPER });
    expect(out.warning).not.toContain(PEPPER);
  });
});

describe("family event payloads carry ids and instants only", () => {
  const at = new Date("2026-10-23T12:00:00Z");
  it("created / revoked / bereavement_mode name the thread link and nothing about the person", () => {
    const org = "org";
    const contactId = "contact";
    const created = familyEventPayload({ kind: "created", orgId: org, contactId, actorUserId: "u", expiresAt: at, at });
    const revoked = familyEventPayload({ kind: "revoked", orgId: org, contactId, actorUserId: "u", reason: "blocked", at });
    const mode = familyEventPayload({ kind: "bereavement_mode", orgId: org, contactId, at });
    expect(Object.keys(created).sort()).toEqual(["at", "contactId", "createdBy", "expiresAt", "organizationId"]);
    expect(Object.keys(revoked).sort()).toEqual(["at", "contactId", "organizationId", "reason", "revokedBy"]);
    expect(Object.keys(mode).sort()).toEqual(["at", "contactId", "organizationId"]);
  });
});
