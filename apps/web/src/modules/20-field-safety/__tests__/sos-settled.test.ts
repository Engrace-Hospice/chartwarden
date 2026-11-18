// M20 Field Safety — has an alert, re-read after a stale refusal, POSITIVELY moved past what the write was for?
//
// It must fail open. "Open" comes from a client mirror of the server's list, so a state the mirror does not know would
// read as closed under a "not in the open list" test, and a responder would be locked out of a write that is still
// needed. Only states known to be finished, or an acknowledgment on record, settle anything.
import { describe, expect, it } from "vitest";
import {
  SOS_CLOSED_STATES,
  SOS_OPEN_STATES,
  sosAlreadySettled,
  sosSettledMessage,
} from "../safety-status";

const alert = (lifecycleState: string, acknowledgedAt: string | null = null) => ({
  lifecycleState,
  acknowledgedAt,
});
const AT = "2026-11-18T12:01:00.000Z";

describe("sosAlreadySettled", () => {
  it("never overlaps the open states", () => {
    for (const state of SOS_CLOSED_STATES) expect(SOS_OPEN_STATES).not.toContain(state);
  });

  it("settles both writes once the alert is known to be closed", () => {
    for (const state of SOS_CLOSED_STATES) {
      expect(sosAlreadySettled("acknowledge", alert(state))).toBe(true);
      expect(sosAlreadySettled("resolve", alert(state))).toBe(true);
    }
  });

  it("settles an acknowledgment (but not a resolution) once somebody acknowledged a live alert", () => {
    expect(sosAlreadySettled("acknowledge", alert("acknowledged", AT))).toBe(true);
    expect(sosAlreadySettled("resolve", alert("acknowledged", AT))).toBe(false);
  });

  it("settles nothing for a live alert nobody has acknowledged", () => {
    expect(sosAlreadySettled("acknowledge", alert("escalation_tier_1"))).toBe(false);
    expect(sosAlreadySettled("resolve", alert("escalation_tier_1"))).toBe(false);
  });

  it("settles nothing for a state this client does not know, so the write stays available", () => {
    for (const state of ["escalation_tier_9", "brand_new_server_state", ""]) {
      expect(sosAlreadySettled("acknowledge", alert(state))).toBe(false);
      expect(sosAlreadySettled("resolve", alert(state))).toBe(false);
    }
    // A rejected cancel leaves the alert running: it is not a closed state.
    expect(sosAlreadySettled("acknowledge", alert("cancel_attempted_but_rejected"))).toBe(false);
  });

  it("still honours an acknowledgment on record whatever the state is called", () => {
    expect(sosAlreadySettled("acknowledge", alert("brand_new_server_state", AT))).toBe(true);
    expect(sosAlreadySettled("resolve", alert("brand_new_server_state", AT))).toBe(false);
  });
});

describe("sosSettledMessage", () => {
  it("says a closed alert is no longer open", () => {
    const message = sosSettledMessage("resolve", "This alert", alert("resolved"), false);
    expect(message).toContain("is no longer open (Resolved)");
    expect(message).not.toContain("earlier attempt");
  });

  it("says an acknowledged alert was already acknowledged, and a lost reply may be the one that landed", () => {
    const message = sosSettledMessage("acknowledge", "This alert", alert("acknowledged", AT), true);
    expect(message).toContain("was already acknowledged");
    expect(message).toContain("it may be the one that landed");
    expect(message).not.toContain("no longer open");
  });
});
