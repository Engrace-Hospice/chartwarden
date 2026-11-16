import { describe, expect, it } from "vitest";
import {
  HOPE_ATTESTATION_VERSION,
  HOPE_SFV_ATTESTATION_STATEMENT,
  HOPE_SIGN_ATTESTATION_STATEMENT,
} from "./hope";

// The audit row of a HOPE signature records HOPE_ATTESTATION_VERSION, so "what did the signer attest to?" is only
// answerable if a version always names the same words, and if the words of every version stay recoverable. This table
// is that record: the FULL text of each statement as it stood in every version. When the wording changes, bump
// HOPE_ATTESTATION_VERSION and ADD an entry for the new version; never edit or remove an existing entry, which would
// rewrite what an earlier signature meant. (Editing an entry in place is the one thing this test cannot see: that is
// for review.)
const PINNED_WORDING: Readonly<Record<string, { sign: string; sfv: string }>> = {
  "2026-11-15.1": {
    sign: "I attest that this HOPE record is complete and accurate to the best of my knowledge. I understand that signing makes it read-only.",
    sfv: "I attest that this symptom follow-up visit took place as recorded and that the information is accurate to the best of my knowledge. I understand that it is recorded as a signed HOPE record.",
  },
};

/**
 * Orders dotted dates-and-counters ("2026-11-15.9" before "2026-11-15.10") by their numeric parts, which a string sort
 * gets wrong as soon as a counter reaches two digits. Negative: a before b.
 */
function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[-.]/).map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const newestPinned = (): string | undefined =>
  Object.keys(PINNED_WORDING).sort(compareVersions).at(-1);

describe("compareVersions", () => {
  it("orders a counter of two digits after one of one digit", () => {
    expect(compareVersions("2026-11-15.9", "2026-11-15.10")).toBeLessThan(0);
    expect(compareVersions("2026-11-15.10", "2026-11-15.9")).toBeGreaterThan(0);
  });

  it("orders by date first, then counter, and treats equal versions as equal", () => {
    expect(compareVersions("2026-11-15.7", "2026-12-01.1")).toBeLessThan(0);
    expect(compareVersions("2027-01-01.1", "2026-12-31.9")).toBeGreaterThan(0);
    expect(compareVersions("2026-11-15.1", "2026-11-15.1")).toBe(0);
  });

  it("finds the newest of several pinned versions numerically, not alphabetically", () => {
    expect(["2026-11-15.9", "2026-11-15.10", "2026-11-15.2"].sort(compareVersions).at(-1)).toBe(
      "2026-11-15.10",
    );
  });
});

describe("HOPE attestation wording", () => {
  const pinned = PINNED_WORDING[HOPE_ATTESTATION_VERSION];

  it("has a pinned wording for the version the audit row records", () => {
    expect(
      pinned,
      `HOPE_ATTESTATION_VERSION is ${HOPE_ATTESTATION_VERSION} but PINNED_WORDING has no entry for it: add one with the full text of the statements this version names`,
    ).toBeDefined();
  });

  // Without an entry the first test already says why; comparing against nothing would only add a false reason.
  it.skipIf(pinned === undefined)(
    "keeps the timepoint sign statement as pinned for the current version",
    () => {
      expect(
        HOPE_SIGN_ATTESTATION_STATEMENT,
        `the sign statement no longer matches what was pinned for ${HOPE_ATTESTATION_VERSION}: its wording changed without a new version. Bump HOPE_ATTESTATION_VERSION and add a new PINNED_WORDING entry`,
      ).toBe(pinned?.sign);
    },
  );

  it.skipIf(pinned === undefined)(
    "keeps the SFV completion statement as pinned for the current version",
    () => {
      expect(
        HOPE_SFV_ATTESTATION_STATEMENT,
        `the SFV statement no longer matches what was pinned for ${HOPE_ATTESTATION_VERSION}: its wording changed without a new version. Bump HOPE_ATTESTATION_VERSION and add a new PINNED_WORDING entry`,
      ).toBe(pinned?.sfv);
    },
  );

  it("is the newest pinned version, so a version pinned ahead of the constant is not forgotten", () => {
    expect(
      HOPE_ATTESTATION_VERSION,
      `PINNED_WORDING already holds ${newestPinned()}: set HOPE_ATTESTATION_VERSION to it, or remove the entry`,
    ).toBe(newestPinned());
  });

  it("keeps the two statements distinct (a signer affirms what they are signing)", () => {
    expect(HOPE_SIGN_ATTESTATION_STATEMENT).not.toBe(HOPE_SFV_ATTESTATION_STATEMENT);
  });
});
