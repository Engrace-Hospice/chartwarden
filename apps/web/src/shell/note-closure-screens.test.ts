// ADR-0113 — the watcher's one decision: a note-closure refusal sends a signed-in clinician to My notes unless they are on a screen
// the gate still allows (that would lose their form), and never moves a signed-out visitor.
import { describe, expect, it } from "vitest";
import {
  NOTE_CLOSURE_HOME,
  isNoteClosureAllowedScreen,
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
    "/safety",
    "/safety/sos/s-1",
    "/safety/incidents/new",
    "/me/safety/check-ins",
    "/messaging",
    "/messaging/inbox",
    "/messaging/unacknowledged",
    "/notifications",
    "/n/abc",
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
