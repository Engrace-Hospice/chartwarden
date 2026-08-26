/**
 * M2-T03 — Session classes + session fields (M2 spec §2.2.4, §3.6).
 *
 * Accept criterion: "unit tests on session-class scoping." These exercise the class
 * taxonomy, the lifecycle state machine (§2.2.4 diagram), and the scope predicate that
 * mirrors the DB `session_scope_chk` CHECK — so the auth layer rejects a mis-scoped
 * session before it is ever written, and the four classes carry exactly the scope their
 * definition requires.
 */
import { describe, expect, it } from "vitest";
import {
  PORTAL_SESSION_CLASSES,
  SESSION_CLASSES,
  SESSION_CLASS_DESCRIPTORS,
  TERMINAL_SESSION_STATES,
  VENDOR_SESSION_CLASSES,
  assertSessionScope,
  canTransitionSession,
  isPortalSessionClass,
  isSessionScopeValid,
  isVendorSessionClass,
  sessionAllowsConcurrent,
  sessionClassDescriptor,
  sessionPinnedPatientId,
} from "../src/identity/session-classes";

describe("M2-T03 session class taxonomy", () => {
  it("declares the four §2.2.4 classes plus the portal + vendor classes the predicates gate on", () => {
    // The original four are M2 spec §2.2.4. The other five were added by migration 0219 (F-030):
    // M16/M19/M31's ABAC predicates had ALWAYS compared `session_class` against them, and the enum
    // had never contained any of them — so those predicates denied unconditionally, and the whole
    // M31 portal surface with them. This assertion is the reason a sixth cannot be added silently.
    expect([...SESSION_CLASSES].sort()).toEqual(
      [
        "auditor",
        "bereaved_portal",
        "caregiver_portal",
        "external_collaborator",
        "external_triage_operator",
        "external_triage_vendor",
        "funeral_home",
        "patient_portal",
        "staff",
      ].sort(),
    );
  });

  it("every portal / vendor class named by a predicate is a real enum value", () => {
    // The point of the whole fix: the vocabulary the predicates gate on and the vocabulary a session
    // can actually carry are now the same list, because they ARE the same list.
    for (const cls of PORTAL_SESSION_CLASSES) expect(SESSION_CLASSES).toContain(cls);
    for (const cls of VENDOR_SESSION_CLASSES) expect(SESSION_CLASSES).toContain(cls);
    expect(isPortalSessionClass("caregiver_portal")).toBe(true);
    expect(isPortalSessionClass("staff")).toBe(false);
    // An absent class must not read as a portal session — the readers default it to `staff`.
    expect(isPortalSessionClass(undefined)).toBe(false);
    expect(isPortalSessionClass(null)).toBe(false);
    expect(isVendorSessionClass("external_triage_operator")).toBe(true);
    expect(isVendorSessionClass("patient_portal")).toBe(false);
  });

  it("a portal session requires its ACCOUNT, not its patient (the mint-then-select flow)", () => {
    // `session_scope_chk` requires `scope.portalAccountId` and NOT `scope.patientId`, because a portal
    // session legitimately exists between mint and select-patient (M31 §2.3 / D2). Requiring the
    // patient here would make that flow unrepresentable.
    for (const cls of PORTAL_SESSION_CLASSES) {
      expect(isSessionScopeValid({ sessionClass: cls, scope: { portalAccountId: "acct-1" } })).toBe(
        true,
      );
      expect(isSessionScopeValid({ sessionClass: cls, scope: { patientId: "pt-1" } })).toBe(false);
      expect(isSessionScopeValid({ sessionClass: cls, scope: null })).toBe(false);
      // Bound later — and then readable, unlike collaborator/funeral where it is required up front.
      expect(
        sessionPinnedPatientId({
          sessionClass: cls,
          scope: { portalAccountId: "acct-1", patientId: "pt-1" },
        }),
      ).toBe("pt-1");
      expect(sessionPinnedPatientId({ sessionClass: cls, scope: { portalAccountId: "a" } })).toBe(
        null,
      );
    }
  });

  it("a vendor session is VENDOR-scoped — it must name the vendor it acts for (F-030)", () => {
    // This used to assert the opposite ("org-scoped, no patient, no account, like staff"), which is how
    // migration 0220 came to require nothing of these classes. Not being PATIENT-scoped does not make a
    // session unscoped within the org: the vendor id IS the authorization subject
    // `external_triage_actor` compares against, so a vendor session without one is not a wider session,
    // it is one that predicate can never admit.
    for (const cls of VENDOR_SESSION_CLASSES) {
      expect(isSessionScopeValid({ sessionClass: cls, scope: null })).toBe(false);
      expect(isSessionScopeValid({ sessionClass: cls, scope: {} })).toBe(false);
      expect(isSessionScopeValid({ sessionClass: cls, scope: { externalActorId: "v1" } })).toBe(
        true,
      );
      expect(sessionClassDescriptor(cls).scopeKind).toBe("external_vendor");
    }
  });

  it("has a descriptor for every class", () => {
    for (const cls of SESSION_CLASSES) {
      expect(sessionClassDescriptor(cls)).toBe(SESSION_CLASS_DESCRIPTORS[cls]);
    }
  });

  it("scopes each class per §2.2.4 (org / patient / deceased) and read-only for auditor", () => {
    expect(SESSION_CLASS_DESCRIPTORS.staff.scopeKind).toBe("organization");
    expect(SESSION_CLASS_DESCRIPTORS.auditor.scopeKind).toBe("organization");
    expect(SESSION_CLASS_DESCRIPTORS.auditor.readOnly).toBe(true);
    expect(SESSION_CLASS_DESCRIPTORS.external_collaborator.scopeKind).toBe("patient");
    expect(SESSION_CLASS_DESCRIPTORS.funeral_home.scopeKind).toBe("deceased_patient");
  });

  it("encodes the §2.2.4 concurrency column (auditor: none, links: one active)", () => {
    expect(sessionAllowsConcurrent("staff")).toBe(true);
    expect(sessionAllowsConcurrent("auditor")).toBe(false);
    expect(sessionAllowsConcurrent("external_collaborator")).toBe(false);
    expect(sessionAllowsConcurrent("funeral_home")).toBe(false);
    expect(SESSION_CLASS_DESCRIPTORS.external_collaborator.concurrency).toBe("one_active_per_link");
  });
});

describe("M2-T03 lifecycle state machine (§2.2.4 diagram)", () => {
  it("allows the drawn transitions and forbids the rest", () => {
    expect(canTransitionSession("active", "screen_locked")).toBe(true);
    expect(canTransitionSession("active", "expired_idle")).toBe(true);
    expect(canTransitionSession("active", "revoked")).toBe(true);
    expect(canTransitionSession("active", "window_closed")).toBe(true);
    expect(canTransitionSession("screen_locked", "active")).toBe(true); // re-auth
    // not drawn:
    expect(canTransitionSession("screen_locked", "screen_locked")).toBe(false);
    expect(canTransitionSession("revoked", "active")).toBe(false);
  });

  it("treats expired/revoked/window_closed as terminal (no outbound transition)", () => {
    for (const s of TERMINAL_SESSION_STATES) {
      expect(canTransitionSession(s, "active")).toBe(false);
    }
  });
});

describe("M2-T03 scope predicate (mirrors session_scope_chk, §3.6)", () => {
  it("staff sessions need no extra scope", () => {
    expect(isSessionScopeValid({ sessionClass: "staff" })).toBe(true);
    expect(sessionPinnedPatientId({ sessionClass: "staff" })).toBeNull();
  });

  it("external_collaborator / funeral_home require scope.patientId", () => {
    for (const cls of ["external_collaborator", "funeral_home"] as const) {
      expect(isSessionScopeValid({ sessionClass: cls })).toBe(false);
      expect(isSessionScopeValid({ sessionClass: cls, scope: { patientId: "" } })).toBe(false);
      expect(isSessionScopeValid({ sessionClass: cls, scope: { patientId: "p-1" } })).toBe(true);
      expect(sessionPinnedPatientId({ sessionClass: cls, scope: { patientId: "p-1" } })).toBe(
        "p-1",
      );
    }
  });

  it("auditor sessions require both engagement bounds", () => {
    expect(isSessionScopeValid({ sessionClass: "auditor" })).toBe(false);
    expect(isSessionScopeValid({ sessionClass: "auditor", engagementStart: new Date(0) })).toBe(
      false,
    );
    expect(
      isSessionScopeValid({
        sessionClass: "auditor",
        engagementStart: new Date(0),
        engagementEnd: new Date(1),
      }),
    ).toBe(true);
  });

  it("assertSessionScope throws on a mis-scoped session", () => {
    expect(() => assertSessionScope({ sessionClass: "external_collaborator" })).toThrow(
      /session_scope_chk/,
    );
    expect(() =>
      assertSessionScope({ sessionClass: "external_collaborator", scope: { patientId: "p-9" } }),
    ).not.toThrow();
  });
});
