// @chartwarden/messaging — M36-T01 unit tests (spec §2.3, §3.2).
//
// Locks the single `channel_kind` discriminator (§2.3): the descriptor table covers every
// kind exactly once, and each kind's subject requirement + retention class match the §2.3
// table the schema CHECK (M36-T02) will enforce. This is the app-layer mirror of that CHECK.
import { describe, expect, it } from "vitest";
import { CHANNEL_KINDS, CHANNEL_KIND_DESCRIPTORS, type ChannelKind } from "../src/index";

describe("channel kind discriminator (§2.3)", () => {
  it("has a descriptor for every kind, keyed by its own kind", () => {
    for (const kind of CHANNEL_KINDS) {
      const d = CHANNEL_KIND_DESCRIPTORS[kind];
      expect(d).toBeDefined();
      expect(d.kind).toBe(kind);
    }
    // descriptor table has no extra/missing kinds
    expect(Object.keys(CHANNEL_KIND_DESCRIPTORS).sort()).toEqual([...CHANNEL_KINDS].sort());
  });

  it("subject requirement matches the subject column (§2.5 subject-by-kind)", () => {
    for (const kind of CHANNEL_KINDS) {
      const d = CHANNEL_KIND_DESCRIPTORS[kind];
      if (d.subjectRequirement === "required") expect(d.subject).not.toBeNull();
      else expect(d.subject).toBeNull();
    }
  });

  it("only `announcement` is operational; clinical channels are care_related (§2.3, M36-F02)", () => {
    const operational = CHANNEL_KINDS.filter(
      (k) => CHANNEL_KIND_DESCRIPTORS[k].retentionClass === "operational",
    );
    expect(operational).toEqual(["announcement"]);
    expect(CHANNEL_KIND_DESCRIPTORS.dm.retentionClass).toBe("care_related");
    expect(CHANNEL_KIND_DESCRIPTORS.bereavement.retentionClass).toBe("bereavement");
  });

  it("the four auto-synced kinds carry a subject and an auto membership source (§2.3)", () => {
    const auto = CHANNEL_KINDS.filter(
      (k) => CHANNEL_KIND_DESCRIPTORS[k].membershipSource === "auto",
    );
    expect(auto.sort()).toEqual(
      (
        ["care_team", "discipline", "location", "on_call", "bereavement", "family"] as ChannelKind[]
      ).sort(),
    );
    for (const k of auto) expect(CHANNEL_KIND_DESCRIPTORS[k].subject).not.toBeNull();
  });
});
