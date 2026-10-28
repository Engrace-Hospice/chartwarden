import type {
  HopeJ2051Event,
  HopeSubmissionStatusView,
  HopeTimepointStatus,
} from "@chartwarden/types";
// apps/backend/__tests__/hope-seams.test.ts — M10-T05 (§2 / D10 HopeTimepointProvider + HopeJ2051Provider
// + HopeSubmissionProvider). All three seams are pure orchestration over an injected HopeSeamStore; these
// cover the open-window narrowing (status === "open"), the per-admission timeline (full set), the J2051
// history read-order (ascending by triggeredAt), the open-SFV narrowing (fired triggers with an open/
// overdue SFV, D3), the latest-per-PE + by-id submission reads, and the boot wiring (registerHopeSeams
// replaces the deny-stubs; validateSeams passes; the deny-stubs deny loudly).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
  createInMemoryHopeSeamStore,
  registerHopeSeams,
} from "../src/modules/10-hope/index";

const PAT = "pat-1";
const ADM = "adm-1";
const PE = "pe-1";

function timepoint(over: Partial<HopeTimepointStatus>): HopeTimepointStatus {
  return {
    scheduleId: "sch-1",
    patientId: PAT,
    admissionId: ADM,
    rfaKind: "01_admission",
    status: "open",
    windowOpensAt: "2026-03-01T00:00:00.000Z",
    windowClosesAt: "2026-03-05T23:59:59.999Z",
    lateDeadlineAt: "2026-03-12T23:59:59.999Z",
    completedByAssessmentId: null,
    generatedBy: "auto_admission",
    ...over,
  };
}

function j2051(over: Partial<HopeJ2051Event>): HopeJ2051Event {
  return {
    assessmentId: "asmt-1",
    sfvId: null,
    patientId: PAT,
    maxSeverity: "moderate",
    triggerFired: true,
    triggeredAt: "2026-03-10T12:00:00.000Z",
    sfvDueAt: "2026-03-12T12:00:00.000Z",
    sfvStatus: "open",
    ...over,
  };
}

function submission(over: Partial<HopeSubmissionStatusView>): HopeSubmissionStatusView {
  return {
    submissionId: "sub-1",
    providerEntityId: PE,
    submissionPeriod: "2026Q1",
    status: "accepted",
    itemCount: 10,
    acceptedCount: 10,
    rejectedCount: 0,
    transmittedAt: "2026-04-01T00:00:00.000Z",
    acceptedAt: "2026-04-02T00:00:00.000Z",
    ...over,
  };
}

function store() {
  return createInMemoryHopeSeamStore({
    timepoints: [
      timepoint({
        scheduleId: "sch-adm",
        rfaKind: "01_admission",
        status: "completed",
        completedByAssessmentId: "asmt-adm",
      }),
      timepoint({ scheduleId: "sch-huv1", rfaKind: "02_huv1", status: "open" }),
      timepoint({ scheduleId: "sch-huv2", rfaKind: "03_huv2", status: "expired" }),
      // a different admission/patient, to prove filtering:
      timepoint({
        scheduleId: "sch-other",
        admissionId: "adm-2",
        patientId: "pat-2",
        status: "open",
      }),
    ],
    j2051Events: [
      j2051({
        assessmentId: "j3",
        triggeredAt: "2026-03-20T09:00:00.000Z",
        triggerFired: true,
        sfvStatus: "overdue",
      }),
      j2051({
        assessmentId: "j1",
        triggeredAt: "2026-03-01T09:00:00.000Z",
        triggerFired: true,
        sfvStatus: "completed",
      }),
      j2051({
        assessmentId: "j2",
        triggeredAt: "2026-03-10T09:00:00.000Z",
        triggerFired: true,
        sfvStatus: "open",
      }),
      // a non-firing event (no SFV obligation) + a different patient:
      j2051({
        assessmentId: "j4",
        triggeredAt: "2026-03-25T09:00:00.000Z",
        triggerFired: false,
        sfvStatus: null,
      }),
      j2051({
        assessmentId: "j-other",
        patientId: "pat-2",
        triggeredAt: "2026-03-15T09:00:00.000Z",
      }),
    ],
    submissions: [
      submission({ submissionId: "sub-old", transmittedAt: "2026-01-01T00:00:00.000Z" }),
      submission({
        submissionId: "sub-new",
        transmittedAt: "2026-04-01T00:00:00.000Z",
        status: "partially_accepted",
        acceptedCount: 8,
        rejectedCount: 2,
      }),
      submission({
        submissionId: "sub-other-pe",
        providerEntityId: "pe-2",
        transmittedAt: "2026-05-01T00:00:00.000Z",
      }),
    ],
  }).store;
}

describe("HopeTimepointProvider (§2 / D10)", () => {
  it("openTimepoints() returns only the still-open windows for the patient", async () => {
    const provider = createHopeTimepointProvider(store());
    const out = await provider.openTimepoints(PAT);
    expect(out.map((t) => t.scheduleId)).toEqual(["sch-huv1"]);
  });

  it("openTimepoints() excludes other patients' windows", async () => {
    const provider = createHopeTimepointProvider(store());
    expect(await provider.openTimepoints("nobody")).toEqual([]);
  });

  it("forAdmission() returns the FULL schedule set for one admission (any status)", async () => {
    const provider = createHopeTimepointProvider(store());
    const out = await provider.forAdmission(ADM);
    expect(out.map((t) => t.scheduleId).sort()).toEqual(["sch-adm", "sch-huv1", "sch-huv2"]);
  });
});

describe("HopeJ2051Provider (§2 / D10)", () => {
  it("history() returns the patient's trigger events ascending by triggeredAt", async () => {
    const provider = createHopeJ2051Provider(store());
    const out = await provider.history(PAT);
    expect(out.map((e) => e.assessmentId)).toEqual(["j1", "j2", "j3", "j4"]);
  });

  it("openSfvs() returns only fired triggers whose SFV is still open or overdue", async () => {
    const provider = createHopeJ2051Provider(store());
    const out = await provider.openSfvs(PAT);
    // j1 completed (terminal), j4 did not fire → excluded; j2 open + j3 overdue remain.
    expect(out.map((e) => e.assessmentId).sort()).toEqual(["j2", "j3"]);
  });
});

describe("HopeSubmissionProvider (§2 / D10)", () => {
  it("latestForProviderEntity() returns the most recently transmitted batch for the PE", async () => {
    const provider = createHopeSubmissionProvider(store());
    const out = await provider.latestForProviderEntity(PE);
    expect(out?.submissionId).toBe("sub-new");
    expect(out?.status).toBe("partially_accepted");
  });

  it("latestForProviderEntity() returns null when the PE has no submissions", async () => {
    const provider = createHopeSubmissionProvider(store());
    expect(await provider.latestForProviderEntity("pe-unknown")).toBeNull();
  });

  it("submission() resolves one batch by id, null when absent", async () => {
    const provider = createHopeSubmissionProvider(store());
    expect((await provider.submission("sub-old"))?.submissionId).toBe("sub-old");
    expect(await provider.submission("missing")).toBeNull();
  });
});

describe("boot wiring (registerHopeSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers all three seams so validateSeams passes and they resolve as real impls", async () => {
    registerHopeSeams({ store: store() });
    expect(() => validateSeams()).not.toThrow();
    expect(
      (await getSeam("HopeTimepointProvider").openTimepoints(PAT)).map((t) => t.scheduleId),
    ).toEqual(["sch-huv1"]);
    expect(
      (await getSeam("HopeJ2051Provider").openSfvs(PAT)).map((e) => e.assessmentId).sort(),
    ).toEqual(["j2", "j3"]);
    expect(
      (await getSeam("HopeSubmissionProvider").latestForProviderEntity(PE))?.submissionId,
    ).toBe("sub-new");
  });

  it("falls back to fail-closed deny-stubs when M10 does not register", () => {
    validateSeams();
    expect(() => getSeam("HopeTimepointProvider").openTimepoints(PAT)).toThrow(/not implemented/);
    expect(() => getSeam("HopeJ2051Provider").history(PAT)).toThrow(/not implemented/);
    expect(() => getSeam("HopeSubmissionProvider").latestForProviderEntity(PE)).toThrow(
      /not implemented/,
    );
  });
});
