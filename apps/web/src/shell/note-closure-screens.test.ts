// ADR-0113 — the watcher's one decision: a note-closure refusal sends a signed-in clinician to My notes unless they are on a screen
// the gate still allows (that would lose their form), and never moves a signed-out visitor.
import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSURE_HOME,
  isNoteClosureAllowedScreen,
  matchesScreenPattern,
  noteClosureRedirectFor,
} from "./note-closure-screens";

describe("isNoteClosureAllowedScreen", () => {
  it.each([
    "/work/drafts",
    "/work/cosignatures",
    "/work/overdue-notes",
    "/patients",
    "/patients/p-1",
    "/patients/p-1/encounters/e-1",
    "/patients/p-1/encounters/e-1/compose",
    "/patients/p-1/emar",
    "/patients/p-1/administrations/a-1",
    "/orders",
    "/orders/o-1",
    "/medication-orders/m-1",
    "/prescribing/verbal-orders",
    "/standing-orders",
    "/triage",
    "/triage/intake",
    "/triage/calls/c-1/transcript",
    "/me/oncall",
    "/safety/sos/s-1",
    "/safety/incidents/new",
    "/me/safety/check-ins",
    "/messaging",
    "/messaging/on-call",
    "/notifications",
    "/login/organization",
    "/step-up",
    "/expired",
    "/maintenance",
    "/security/passkeys",
  ])("keeps a blocked clinician on %s", (path) => {
    expect(isNoteClosureAllowedScreen(path)).toBe(true);
  });

  it.each([
    "/",
    "/scheduling/visits/v-1",
    "/admin/onboarding",
    "/triage/shifts",
    "/triage/policy",
    // These open with a read the gate refuses (an organization-wide board, the work inbox, the unacknowledged queue, a delivery
    // target): a blocked clinician must be moved to My notes, not left on a permission error.
    "/safety",
    "/safety/check-ins",
    "/messaging/inbox",
    "/messaging/unacknowledged",
    "/n/abc",
    "/safety/policy",
    "/safety/metrics",
    "/messaging/governance/retention",
    "/messaging/export",
    "/search",
    "/work/draftsman",
    "/patients-archive",
    "/orders-archive",
  ])("does not treat %s as allowed", (path) => {
    expect(isNoteClosureAllowedScreen(path)).toBe(false);
  });
});

// A tree says "everything under it", but a few screens under /patients open with a read the server refuses. They are refused by name, so
// the clinician is moved to My notes instead of sitting on a permission error; their siblings stay.
describe("screens under an allowed tree that the server refuses", () => {
  it.each([
    "/patients/p-1/claims",
    "/patients/p-1/consents/c-1",
    "/patients/p-1/consents/new",
    "/patients/p-1/consents/expiring",
    "/patients/p-1/discipline-plans",
    "/patients/p-1/discipline-plans/aide-poc/v-1/edit",
    "/patients/p-1/election-certification",
    "/patients/p-1/reconciliation/w-1",
    "/patients/p-1/signatures",
    "/Patients/p-1/Claims",
  ])("does not treat %s as allowed", (path) => {
    expect(isNoteClosureAllowedScreen(path)).toBe(false);
    expect(noteClosureRedirectFor(path, true)).toBe(NOTE_CLOSURE_HOME);
  });

  it.each([
    "/patients/p-1",
    "/patients/p-1/consents",
    "/patients/p-1/documents",
    "/patients/p-1/emar",
    "/patients/p-1/medications/reconciliation",
    "/patients/p-1/encounters/e-1/compose",
  ])("still keeps a blocked clinician on %s", (path) => {
    expect(isNoteClosureAllowedScreen(path)).toBe(true);
  });
});

describe("matchesScreenPattern", () => {
  it("lets * stand for one segment and names the screen and everything under it", () => {
    expect(matchesScreenPattern("/patients/p-1/consents/c-1", "/patients/*/consents/*")).toBe(true);
    expect(matchesScreenPattern("/patients/p-1/consents/c-1/extra", "/patients/*/consents/*")).toBe(
      true,
    );
    expect(matchesScreenPattern("/patients/p-1/consents", "/patients/*/consents/*")).toBe(false);
    expect(matchesScreenPattern("/patients/p-1/claims", "/patients/*/consents/*")).toBe(false);
  });
});

// react-router matches case-insensitively and ignores a trailing slash, so the screen the router renders is the screen the gate allows.
describe("isNoteClosureAllowedScreen follows the router's matching", () => {
  it.each([
    "/Patients/p-1/encounters/e-1/compose",
    "/WORK/Drafts",
    "/Triage",
    "/triage/",
    "/patients/",
    "/Me/OnCall",
  ])("keeps a blocked clinician on %s", (path) => {
    expect(isNoteClosureAllowedScreen(path)).toBe(true);
  });

  it.each(["/Scheduling/Visits/v-1", "/Triage/Shifts", "/Safety", "/Patients-Archive", "/"])(
    "still does not treat %s as allowed",
    (path) => {
      expect(isNoteClosureAllowedScreen(path)).toBe(false);
    },
  );

  it("does not move a clinician off the composer when its path is typed in another case", () => {
    expect(noteClosureRedirectFor("/Patients/p-1/encounters/e-1/compose", true)).toBeNull();
  });
});

describe("noteClosureRedirectFor", () => {
  it("sends a signed-in clinician off a refused screen to My notes", () => {
    expect(noteClosureRedirectFor("/", true)).toBe(NOTE_CLOSURE_HOME);
    expect(noteClosureRedirectFor("/scheduling/visits/v-1", true)).toBe("/work/drafts");
  });

  it("never navigates away from an allowed screen (it would lose a form), My notes included", () => {
    expect(noteClosureRedirectFor("/patients/p-1/encounters/e-1/compose", true)).toBeNull();
    expect(noteClosureRedirectFor("/work/drafts", true)).toBeNull();
    expect(noteClosureRedirectFor("/orders/o-1", true)).toBeNull();
  });

  it("never moves a signed-out visitor", () => {
    expect(noteClosureRedirectFor("/", false)).toBeNull();
  });
});
