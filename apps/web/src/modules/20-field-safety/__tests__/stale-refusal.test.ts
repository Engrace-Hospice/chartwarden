// M20 Field Safety — the sentence for a write the server refused as stale, after the record was re-read.
//
// It says only what is known: a version that moved proves the record changed; one that did not move proves nothing did
// (and that an earlier attempt which got no answer was not recorded, since it would have bumped the version); a failed
// re-read proves nothing, and the recovery it names belongs to the screen that asks.
import { describe, expect, it } from "vitest";
import { staleRefusalMessage } from "../safety-api";

const base = {
  subject: "The acknowledgment",
  staleVersion: 3,
  lostReply: false,
  ifNotReread: "Cancel and open it again.",
};

describe("staleRefusalMessage", () => {
  it("says the record changed, and what was kept, when the version moved", () => {
    const message = staleRefusalMessage({ ...base, freshVersion: 4 });
    expect(message).toContain("The acknowledgment was not recorded.");
    expect(message).toContain("The record changed while you were working");
    expect(message).toContain("re-read (now version 4)");
    expect(message).toContain("what you typed is kept");
  });

  it("claims no change when the version did not move, and does not say an earlier attempt may have landed", () => {
    for (const lostReply of [false, true]) {
      const message = staleRefusalMessage({ ...base, freshVersion: 3, lostReply });
      expect(message).toContain("still at version 3");
      expect(message).toContain("The acknowledgment was not recorded.");
      expect(message).not.toContain("changed");
      expect(message).not.toContain("may have been recorded");
      expect(message).not.toContain("earlier attempt");
    }
  });

  it("says an earlier attempt may have landed only when the version moved after a lost reply", () => {
    const message = staleRefusalMessage({ ...base, freshVersion: 4, lostReply: true });
    expect(message).toContain("an earlier attempt got no answer and may have been recorded");
  });

  it("claims no change when the record could not be re-read, and gives the caller's own recovery", () => {
    const sosActive = staleRefusalMessage({ ...base, freshVersion: null });
    expect(sosActive).toContain("could not be re-read to see why");
    expect(sosActive).not.toContain("record changed");
    expect(sosActive).toContain("Cancel and open it again.");
    const detail = staleRefusalMessage({
      ...base,
      freshVersion: null,
      ifNotReread: "Cancel and Reload the page, then try again.",
    });
    expect(detail).toContain("Cancel and Reload the page, then try again.");
    expect(detail).not.toContain("open it again");
  });
});
