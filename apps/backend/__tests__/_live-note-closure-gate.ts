// apps/backend/__tests__/_live-note-closure-gate.ts — the explicit "this clinician is not note-blocked" gate for a test that builds the
// authenticate hook but does not exercise the visit-note closure gate (bootstrap/note-closure-gate.ts). `SessionAuthenticateDeps.
// noteClosureGate` is required, so a hook can never silently skip the control; a test that does not care says so with this. Production
// code never imports it (it lives beside the tests).
import type { NoteClosureGate } from "../src/bootstrap/note-closure-gate";

export const liveNoteClosureGate: NoteClosureGate = {
  assertMayCall: async () => {},
};
