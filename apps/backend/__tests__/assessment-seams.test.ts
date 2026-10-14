import type { LatestAssessment } from "@wardenx/types";
// apps/backend/__tests__/assessment-seams.test.ts — M9-T04 (§4.7 / D7 LatestAssessmentProvider +
// ScaleSeriesProvider). Both seams are pure orchestration over an injected AssessmentReaderStore; these
// cover the latest-active reads (single + batch), the windowed read-time series (D4, ascending), the
// latest-vs-window delta (≥2-captures rule, §4.1), and the boot wiring (registerAssessmentSeams replaces
// the deny-stubs; validateSeams passes; the deny-stubs deny loudly).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type SeededSeriesPoint,
  createInMemoryAssessmentReaderStore,
  createLatestAssessmentProvider,
  createScaleSeriesProvider,
  registerAssessmentSeams,
} from "../src/modules/09-assessments/index";

const PAT = "pat-1";

const capture = {
  capturedByMembershipId: "mem-1",
  capturedByDiscipline: "rn",
  providerEntityId: "pe-1",
  locationId: "loc-1",
} as const;

function latest(over: Partial<LatestAssessment>): LatestAssessment {
  return {
    assessmentId: "asmt-pps",
    patientId: PAT,
    admissionId: "adm-1",
    scaleType: "pps",
    scaleVersion: "1.0",
    score: 50,
    scoreInterpretation: "PPS 50%",
    capturedAt: "2026-03-10T12:00:00.000Z",
    capture,
    sourceEncounterId: null,
    cosignRequired: false,
    cosignedAt: null,
    status: "active",
    redacted: false,
    ...over,
  };
}

const points: readonly SeededSeriesPoint[] = [
  {
    patientId: PAT,
    scaleType: "pps",
    assessmentId: "p1",
    capturedAt: "2026-03-01T09:00:00.000Z",
    score: 70,
    scoreInterpretation: "PPS 70%",
    significantChange: false,
  },
  {
    patientId: PAT,
    scaleType: "pps",
    assessmentId: "p3",
    capturedAt: "2026-03-20T09:00:00.000Z",
    score: 40,
    scoreInterpretation: "PPS 40%",
    significantChange: true,
  },
  {
    patientId: PAT,
    scaleType: "pps",
    assessmentId: "p2",
    capturedAt: "2026-03-10T09:00:00.000Z",
    score: 50,
    scoreInterpretation: "PPS 50%",
    significantChange: false,
  },
  // out of the test window (April) + a different scale, to prove filtering:
  {
    patientId: PAT,
    scaleType: "pps",
    assessmentId: "p4",
    capturedAt: "2026-04-05T09:00:00.000Z",
    score: 30,
    scoreInterpretation: "PPS 30%",
    significantChange: false,
  },
  {
    patientId: PAT,
    scaleType: "esas_r",
    assessmentId: "e1",
    capturedAt: "2026-03-10T09:00:00.000Z",
    score: 12,
    scoreInterpretation: null,
    significantChange: false,
  },
];

function store() {
  return createInMemoryAssessmentReaderStore({
    latest: [
      latest({}),
      latest({
        assessmentId: "asmt-fast",
        scaleType: "fast",
        score: 7,
        scoreInterpretation: "FAST 7",
      }),
      latest({
        assessmentId: "asmt-aims",
        scaleType: "aims",
        score: 4,
        scoreInterpretation: "AIMS 4",
        redacted: true,
      }),
    ],
    points,
  }).store;
}

describe("LatestAssessmentProvider (§4.7 / D7)", () => {
  it("latest() returns the latest-active row for one scale", async () => {
    const provider = createLatestAssessmentProvider(store());
    const out = await provider.latest(PAT, "pps");
    expect(out?.assessmentId).toBe("asmt-pps");
    expect(out?.score).toBe(50);
  });

  it("latest() returns null when no active capture exists for the scale", async () => {
    const provider = createLatestAssessmentProvider(store());
    expect(await provider.latest(PAT, "braden")).toBeNull();
    expect(await provider.latest("nobody", "pps")).toBeNull();
  });

  it("latestBatch() resolves only the requested scales for the patient", async () => {
    const provider = createLatestAssessmentProvider(store());
    const out = await provider.latestBatch(PAT, ["pps", "fast", "braden"]);
    expect(out.map((l) => l.scaleType).sort()).toEqual(["fast", "pps"]);
  });

  it("carries the store-side D10 redaction flag through unchanged (AIMS/SUD)", async () => {
    const provider = createLatestAssessmentProvider(store());
    expect((await provider.latest(PAT, "aims"))?.redacted).toBe(true);
    expect((await provider.latest(PAT, "pps"))?.redacted).toBe(false);
  });
});

describe("ScaleSeriesProvider.series (§4.7 / D4)", () => {
  it("returns the in-window scored captures of one scale, ascending by capturedAt", async () => {
    const provider = createScaleSeriesProvider(store());
    const out = await provider.series(
      PAT,
      "pps",
      "2026-03-01T00:00:00.000Z",
      "2026-03-31T23:59:59.999Z",
    );
    // p4 (April) and the esas_r point are excluded; order is ascending.
    expect(out.points.map((p) => p.assessmentId)).toEqual(["p1", "p2", "p3"]);
    expect(out.scaleType).toBe("pps");
    expect(out.points.find((p) => p.assessmentId === "p3")?.significantChange).toBe(true);
  });

  it("returns an empty series when no captures fall in the window", async () => {
    const provider = createScaleSeriesProvider(store());
    const out = await provider.series(
      PAT,
      "pps",
      "2026-01-01T00:00:00.000Z",
      "2026-01-31T23:59:59.999Z",
    );
    expect(out.points).toEqual([]);
  });
});

describe("ScaleSeriesProvider.delta (§4.1)", () => {
  it("computes latest-vs-window from the earliest and most recent in-window captures", async () => {
    const provider = createScaleSeriesProvider(store());
    const out = await provider.delta(PAT, "pps", { from: "2026-03-01", to: "2026-03-31" });
    expect(out.priorScore).toBe(70); // earliest (p1)
    expect(out.latestScore).toBe(40); // most recent (p3)
    expect(out.delta).toBe(-30);
  });

  it("returns all-null when fewer than two comparable captures exist in the window", async () => {
    const provider = createScaleSeriesProvider(store());
    const out = await provider.delta(PAT, "esas_r", { from: "2026-03-01", to: "2026-03-31" });
    expect(out).toMatchObject({ latestScore: null, priorScore: null, delta: null });
  });
});

describe("boot wiring (registerAssessmentSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers both seams so validateSeams passes and they resolve as real impls", async () => {
    registerAssessmentSeams({ store: store() });
    expect(() => validateSeams()).not.toThrow();
    expect((await getSeam("LatestAssessmentProvider").latest(PAT, "pps"))?.score).toBe(50);
    const series = await getSeam("ScaleSeriesProvider").series(
      PAT,
      "pps",
      "2026-03-01T00:00:00.000Z",
      "2026-03-31T23:59:59.999Z",
    );
    expect(series.points).toHaveLength(3);
  });

  it("falls back to fail-closed deny-stubs when M9 does not register", () => {
    validateSeams();
    expect(() => getSeam("LatestAssessmentProvider").latest(PAT, "pps")).toThrow(/not implemented/);
    expect(() =>
      getSeam("ScaleSeriesProvider").delta(PAT, "pps", { from: "2026-03-01", to: "2026-03-31" }),
    ).toThrow(/not implemented/);
  });
});

describe("LatestAssessmentProvider.linkSummary (M36 WP 3.2)", () => {
  const ORG = "org-1";
  const link = (over: Record<string, unknown> = {}) => ({
    id: "asmt-pps",
    organizationId: ORG,
    patientId: PAT,
    status: "active",
    occurredAt: "2026-03-10T12:00:00.000Z",
    ...over,
  });
  const provider = (links: ReturnType<typeof link>[]) =>
    createLatestAssessmentProvider(createInMemoryAssessmentReaderStore({ links }).store);

  it("returns id/patient/status/occurredAt only", async () => {
    const out = await provider([link()]).linkSummary(ORG, "asmt-pps");
    expect(out).toEqual({
      id: "asmt-pps",
      patientId: PAT,
      status: "active",
      occurredAt: "2026-03-10T12:00:00.000Z",
    });
    expect(Object.keys(out ?? {})).toHaveLength(4);
  });

  it("returns null for an unknown id and for another org's row", async () => {
    const p = provider([link()]);
    expect(await p.linkSummary(ORG, "nope")).toBeNull();
    expect(await p.linkSummary("org-2", "asmt-pps")).toBeNull();
  });

  it("withholds a SUD-context row like a missing one", async () => {
    expect(await provider([link({ sudContext: true })]).linkSummary(ORG, "asmt-pps")).toBeNull();
  });

  it("throws on a blank organizationId or id", async () => {
    const p = provider([link()]);
    await expect(p.linkSummary("", "asmt-pps")).rejects.toThrow(/organizationId/);
    await expect(p.linkSummary(ORG, "  ")).rejects.toThrow(/id required/);
  });
});
