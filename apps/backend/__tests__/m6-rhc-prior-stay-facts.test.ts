// M6 → M23 two-tier RHC carry-over facts: a transfer-in's sending hospice span (8xC, CMS Pub. 100-04 ch. 11
// §20.1.3) joins our earlier stays, for an earlier transfer-in AND for the stay being priced.
import { describe, expect, it } from "vitest";
import {
  type PriorEpisode,
  type TransferInSource,
  rhcPriorStayFacts,
} from "../src/modules/06-admission/seams/prior-episodes";

const source = (over: Partial<TransferInSource> = {}): TransferInSource => ({
  transferEventId: "te-1",
  sendingStartedOn: "2026-01-01",
  transferOn: "2026-01-20",
  sendingNpi: "1649726464",
  ...over,
});

const episode = (over: Partial<PriorEpisode> = {}): PriorEpisode => ({
  admissionId: "adm-1",
  patientId: "pat-1",
  admissionState: "discharged",
  startedOn: "2026-01-20",
  endedOn: "2026-02-10",
  endKind: "live_discharge",
  dischargeType: "no_longer_terminal",
  lastRanSequence: 2,
  endingEventId: "de-1",
  transferredIn: null,
  ...over,
});

describe("rhcPriorStayFacts", () => {
  it("maps a plain earlier stay as ours", () => {
    expect(rhcPriorStayFacts([episode()])).toEqual([
      { admissionId: "adm-1", startedOn: "2026-01-20", endedOn: "2026-02-10" },
    ]);
  });

  it("adds an earlier transfer-in's sending hospice span, flagged as another hospice's", () => {
    const facts = rhcPriorStayFacts([episode({ transferredIn: source() })]);
    expect(facts).toContainEqual({
      admissionId: "adm-1",
      startedOn: "2026-01-01",
      endedOn: "2026-01-20",
      otherHospice: { npi: "1649726464" },
    });
    expect(facts).toHaveLength(2);
  });

  it("adds the CURRENT stay's sending hospice span when it is a transfer-in", () => {
    const facts = rhcPriorStayFacts([], {
      admissionId: "adm-now",
      transferredIn: source({ sendingNpi: null }),
    });
    expect(facts).toEqual([
      {
        admissionId: "adm-now",
        startedOn: "2026-01-01",
        endedOn: "2026-01-20",
        otherHospice: { npi: null },
      },
    ]);
  });

  it("skips a legacy transfer-in with no inherited period start, or an inverted span", () => {
    expect(
      rhcPriorStayFacts([], {
        admissionId: "a",
        transferredIn: source({ sendingStartedOn: null }),
      }),
    ).toEqual([]);
    expect(
      rhcPriorStayFacts([], {
        admissionId: "a",
        transferredIn: source({ sendingStartedOn: "2026-02-01" }),
      }),
    ).toEqual([]);
  });
});
