import type { HttpRequestContext } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { M31_CONTRIBUTED_PERMISSIONS } from "../src/permissions/contributed";
import {
  SESSION_CLASS_PERMISSIONS,
  sessionClassPermissions,
  withSessionClassPermissions,
} from "../src/rbac/session-class-permissions";

const ctx = (attributes: Record<string, unknown>): HttpRequestContext =>
  ({
    organizationId: "org",
    userId: "user",
    roles: ["clinician"],
    attributes,
  }) as unknown as HttpRequestContext;

describe("session-class permissions (portal / funeral-home sessions hold no membership)", () => {
  it("a portal session gets exactly its class set, regardless of any role on the context", () => {
    const set = sessionClassPermissions(
      ctx({ sessionClass: "caregiver_portal", portalAccountId: "acct" }),
    );
    expect(set).not.toBeNull();
    expect(set?.has("portal.session.read_own")).toBe(true);
    expect(set?.has("portal.care_summary.read")).toBe(true);
    expect(set?.has("patient.read")).toBe(false);
    expect(set?.has("portal.invitation.issue")).toBe(false);
  });

  it("every key a class grants exists in the M31 catalog or is the funeral key (no typo grants nothing silently)", () => {
    const known = new Set<string>(Object.keys(M31_CONTRIBUTED_PERMISSIONS));
    for (const [cls, keys] of Object.entries(SESSION_CLASS_PERMISSIONS)) {
      for (const key of keys) {
        if (cls === "funeral_home") expect(key).toBe("funeral.case_read");
        else expect(known.has(key), `${cls} grants unknown key ${key}`).toBe(true);
      }
    }
  });

  it("never hands a portal class a staff-side portal or telehealth key", () => {
    const staffOnly = [
      "portal.invitation.issue",
      "portal.invitation.read",
      "portal.invitation.revoke",
      "portal.invitation.invite_bereaved",
      "portal.account.suspend",
      "portal.account.reinstate",
      "portal.account.read_list",
      "portal.account.read_grants",
      "portal.account.read_audit",
      "portal.engagement.read_auditor",
      "telehealth.join_clinician",
      "telehealth.record_start",
      "telehealth.record_stop",
      "telehealth.end_visit",
      "telehealth.record_halt_admin",
      "telehealth.read_list",
      "telehealth.read",
    ];
    for (const keys of Object.values(SESSION_CLASS_PERMISSIONS)) {
      for (const key of staffOnly) expect(keys).not.toContain(key);
    }
  });

  it("amendment requests are the patient's right: only patient_portal holds them", () => {
    expect(SESSION_CLASS_PERMISSIONS.patient_portal).toContain("portal.amendment.submit");
    expect(SESSION_CLASS_PERMISSIONS.caregiver_portal).not.toContain("portal.amendment.submit");
    expect(SESSION_CLASS_PERMISSIONS.bereaved_portal).not.toContain("portal.amendment.submit");
  });

  it("a bereaved session holds the bereavement surface, not the care-time reads", () => {
    const keys = SESSION_CLASS_PERMISSIONS.bereaved_portal ?? [];
    expect(keys).toContain("portal.bereavement.read_program");
    expect(keys).not.toContain("portal.medications.read_summary");
    expect(keys).not.toContain("portal.administration.attest");
  });

  it("fails closed: a portal class with no account anchor, and a funeral class with no pinned patient, hold nothing", () => {
    expect(sessionClassPermissions(ctx({ sessionClass: "patient_portal" }))?.size).toBe(0);
    expect(sessionClassPermissions(ctx({ sessionClass: "funeral_home" }))?.size).toBe(0);
    expect(
      sessionClassPermissions(ctx({ sessionClass: "funeral_home", sessionPatientId: "p" }))?.has(
        "funeral.case_read",
      ),
    ).toBe(true);
  });

  it("staff, auditor, collaborator and absent classes fall through to the membership resolver", async () => {
    for (const sessionClass of ["staff", "auditor", "external_collaborator", undefined]) {
      expect(sessionClassPermissions(ctx(sessionClass ? { sessionClass } : {}))).toBeNull();
    }
    const resolver = withSessionClassPermissions(() => new Set(["patient.read"]));
    expect([...(await resolver(ctx({ sessionClass: "staff" })))]).toEqual(["patient.read"]);
    // ...but the base resolver is not even consulted for a portal session.
    const portal = await resolver(ctx({ sessionClass: "patient_portal", portalAccountId: "a" }));
    expect(portal.has("patient.read")).toBe(false);
    expect(portal.has("portal.session.read_own")).toBe(true);
  });
});
