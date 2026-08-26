// packages/auth/__tests__/portal-session-binder.test.ts — the M2 portal session binder (F-030 / #75).
//
// M31's `select-patient` route header has always said it "hands the binding to M2". It did not: there
// was no M2 surface to hand it to, so `session.scope` never carried a portal account or a bound
// patient, no session ever held one of the three portal classes, and every `portal.*` ABAC predicate
// denied. These tests cover the surface that closes that, and specifically the refusals — the binder
// writes authorization-bearing facts onto a session row, so what it REFUSES matters more than what it
// writes.
import type { PortalSessionClass } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  PortalSessionBindError,
  createInMemoryPortalSessionStore,
  createPortalSessionBinder,
} from "../src/identity/portal-session-binder";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const SCOPE = { orgId: ORG };

function setup() {
  const { store, rows } = createInMemoryPortalSessionStore([
    {
      sessionId: "s-portal",
      organizationId: ORG,
      sessionClass: "caregiver_portal",
      scope: { portalAccountId: "acct-1" },
    },
    { sessionId: "s-fresh", organizationId: ORG, sessionClass: "staff", scope: null },
    { sessionId: "s-staff", organizationId: ORG, sessionClass: "staff", scope: null },
    { sessionId: "s-other-tenant", organizationId: OTHER_ORG, sessionClass: "staff", scope: null },
  ]);
  return { binder: createPortalSessionBinder(store), rows };
}

describe("PortalSessionBinder", () => {
  it("stamps the class and the account onto a session", () => {
    const { binder, rows } = setup();
    return binder
      .bindPortalSession({
        scope: SCOPE,
        sessionId: "s-fresh",
        portalAccountId: "acct-9",
        sessionClass: "patient_portal",
      })
      .then((res) => {
        expect(res.sessionClass).toBe("patient_portal");
        expect(rows.get("s-fresh")).toEqual({
          organizationId: ORG,
          sessionClass: "patient_portal",
          scope: { portalAccountId: "acct-9" },
        });
      });
  });

  it("binds the patient WITHOUT dropping the account — scope is merged, not replaced", () => {
    // The two operations write different keys at different times (account at mint, patient at
    // select-patient). A replacing write would silently drop whichever key it was not carrying, and
    // losing `portalAccountId` would 403 the session on its next request.
    const { binder, rows } = setup();
    return binder
      .bindPortalPatient({ scope: SCOPE, sessionId: "s-portal", patientId: "pt-1" })
      .then(() => {
        expect(rows.get("s-portal")?.scope).toEqual({
          portalAccountId: "acct-1",
          patientId: "pt-1",
        });
      });
  });

  it("refuses to patient-bind a session that is not a portal session", async () => {
    // Without this, a staff session id passed here would acquire a `scope.patientId` — a scope its
    // class does not mean, and one that would then be read back as a portal patient anchor.
    const { binder, rows } = setup();
    await expect(
      binder.bindPortalPatient({ scope: SCOPE, sessionId: "s-staff", patientId: "pt-1" }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
    expect(rows.get("s-staff")?.scope).toBeNull();
  });

  it("refuses a session in another organization, on both operations", async () => {
    const { binder, rows } = setup();
    await expect(
      binder.bindPortalSession({
        scope: SCOPE,
        sessionId: "s-other-tenant",
        portalAccountId: "acct-1",
        sessionClass: "patient_portal",
      }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
    await expect(
      binder.bindPortalPatient({ scope: SCOPE, sessionId: "s-other-tenant", patientId: "pt-1" }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
    // Untouched — the refusal is not merely a thrown error after a write.
    expect(rows.get("s-other-tenant")).toEqual({
      organizationId: OTHER_ORG,
      sessionClass: "staff",
      scope: null,
    });
  });

  it("does not distinguish 'absent' from 'another tenant's' — no session-id probing", async () => {
    const { binder } = setup();
    const missing = await binder
      .bindPortalPatient({ scope: SCOPE, sessionId: "s-does-not-exist", patientId: "pt-1" })
      .catch((e: Error) => e.message);
    const foreign = await binder
      .bindPortalPatient({ scope: SCOPE, sessionId: "s-other-tenant", patientId: "pt-1" })
      .catch((e: Error) => e.message);
    expect(missing).toBe(foreign);
  });

  it("refuses a non-portal class and an empty id (defense in depth past the typed seam)", async () => {
    const { binder } = setup();
    await expect(
      binder.bindPortalSession({
        scope: SCOPE,
        sessionId: "s-fresh",
        portalAccountId: "acct-1",
        // A caller that bypasses the typed seam — the point of the check being tested.
        sessionClass: "staff" as PortalSessionClass,
      }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
    await expect(
      binder.bindPortalSession({
        scope: SCOPE,
        sessionId: "s-fresh",
        portalAccountId: "",
        sessionClass: "patient_portal",
      }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
    await expect(
      binder.bindPortalPatient({ scope: SCOPE, sessionId: "s-portal", patientId: "" }),
    ).rejects.toBeInstanceOf(PortalSessionBindError);
  });
});
