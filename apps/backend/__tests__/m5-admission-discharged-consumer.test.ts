// M5 §2.4.1 live-discharge consumer — the decisions taken BEFORE any patient write (no DB): a death is
// the death cascade's, an unknown admission / a re-admission under care / a not-yet-ended admission are
// skipped. The patient-row edges themselves are proven live in `m5-admission-siting.live.test.ts`.
import type { AdmissionPatientCare } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  M5_ADMISSION_DISCHARGED_CONSUMER,
  buildM5AdmissionDischargedConsumer,
} from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";

const ORG = "11111111-1111-1111-1111-111111111111";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

/** A db/outbox that fail the test if the consumer ever reaches the patient write. */
const untouchable = {
  db: new Proxy({}, { get: () => () => Promise.reject(new Error("db must not be touched")) }),
  outbox: { publish: () => Promise.reject(new Error("outbox must not be touched")) },
} as never;

function withCare(care: AdmissionPatientCare | null): string[] {
  const asked: string[] = [];
  registerSeam("AdmissionStatusReader", {
    getAdmissionSummary: () => Promise.reject(new Error("not used")),
    getAdmissionSiting: () => Promise.reject(new Error("not used")),
    getAdmissionPatientCare: async (organizationId, admissionId) => {
      asked.push(`${organizationId}/${admissionId}`);
      return care;
    },
  });
  return asked;
}

const care = (over: Partial<AdmissionPatientCare> = {}): AdmissionPatientCare =>
  ({
    admissionId: ADMISSION,
    patientId: "44444444-4444-4444-4444-444444444444",
    status: "discharged",
    otherAdmissionUnderCare: false,
    ...over,
  }) as AdmissionPatientCare;

const deliver = (reason: string, payload: Record<string, unknown> = {}) =>
  buildM5AdmissionDischargedConsumer(untouchable).handle({
    organizationId: ORG,
    payload: { admissionId: ADMISSION, reason, dischargeDate: "2026-06-01", ...payload },
  });

describe("M5 m6.admission.discharged consumer — pre-write decisions", () => {
  afterEach(() => __resetSeamsForTest());

  it("binds m6.admission.discharged as module m5", () => {
    const consumer = buildM5AdmissionDischargedConsumer(untouchable);
    expect(consumer.consumerModule).toBe("m5");
    expect(consumer.eventTypes).toEqual([M5_ADMISSION_DISCHARGED_CONSUMER.eventName]);
    expect(M5_ADMISSION_DISCHARGED_CONSUMER.eventName).toBe("m6.admission.discharged");
  });

  it("skips a death discharge without even resolving the admission", async () => {
    const asked = withCare(care());
    expect(await deliver("death")).toBe("skipped_death");
    expect(asked).toEqual([]);
  });

  it("resolves the patient through M6's org-explicit seam with the event's own org", async () => {
    const asked = withCare(null);
    expect(await deliver("revocation")).toBe("skipped_unknown_admission");
    expect(asked).toEqual([`${ORG}/${ADMISSION}`]);
  });

  it("never discharges a patient whom another admission holds under care", async () => {
    withCare(care({ otherAdmissionUnderCare: true }));
    expect(await deliver("transfer")).toBe("skipped_other_admission_under_care");
  });

  it("skips when the named admission has not actually ended", async () => {
    withCare(care({ status: "active" }));
    expect(await deliver("other")).toBe("skipped_admission_not_ended");
  });

  it("throws on a payload with no admissionId or reason (a contract drift, not a skip)", async () => {
    withCare(care());
    await expect(deliver("", {})).rejects.toThrow(/payload has no reason/);
    await expect(deliver("other", { admissionId: "" })).rejects.toThrow(
      /payload has no admissionId/,
    );
  });
});
