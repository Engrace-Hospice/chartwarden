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
  SESSION_CLASSES,
  SESSION_CLASS_DESCRIPTORS,
  TERMINAL_SESSION_STATES,
  assertSessionScope,
  canTransitionSession,
  isSessionScopeValid,
  sessionAllowsConcurrent,
  sessionClassDescriptor,
  sessionPinnedPatientId,
} from "../src/identity/session-classes";

describe("M2-T03 session class taxonomy", () => {
  it("declares exactly the four classes (M2 spec §2.2.4)", () => {
    expect([...SESSION_CLASSES].sort()).toEqual(
      ["auditor", "external_collaborator", "funeral_home", "staff"].sort(),
    );
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
