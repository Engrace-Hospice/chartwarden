// apps/backend/__tests__/m6-election-cert-picks.test.ts — the Election & Certification view's
// one-row-per-period pick (election-cert-picks.ts). A voided CTI used to hide the live one because the
// read kept whichever row came back last; every case below feeds the rows in the ADVERSE order.
import { describe, expect, it } from "vitest";
import {
  CTI_STATUS_RANK,
  ELECTION_STATEMENT_STATUS_RANK,
  F2F_STATUS_RANK,
  pickOnePerPeriod,
} from "../src/modules/06-admission/election-cert-picks";
import { createInMemoryAdmissionBackend } from "../src/modules/06-admission/index";

const P = "ep_1";
const at = (iso: string) => new Date(iso);

describe("pickOnePerPeriod — CTI", () => {
  it("prefers the live CTI over a NEWER voided one", () => {
    const live = {
      id: "live",
      electionPeriodId: P,
      status: "drafted",
      createdAt: at("2026-06-01"),
    };
    const voided = {
      id: "void",
      electionPeriodId: P,
      status: "voided",
      createdAt: at("2026-06-05"),
    };
    expect(pickOnePerPeriod([live, voided], CTI_STATUS_RANK).get(P)?.id).toBe("live");
    expect(pickOnePerPeriod([voided, live], CTI_STATUS_RANK).get(P)?.id).toBe("live");
  });

  it("prefers signed over an in-flight state", () => {
    const signed = { id: "s", electionPeriodId: P, status: "signed", createdAt: at("2026-06-01") };
    const draft = { id: "d", electionPeriodId: P, status: "drafted", createdAt: at("2026-06-09") };
    expect(pickOnePerPeriod([signed, draft], CTI_STATUS_RANK).get(P)?.id).toBe("s");
  });

  it("shows the newest voided CTI when no live one exists", () => {
    const older = { id: "v1", electionPeriodId: P, status: "voided", createdAt: at("2026-06-01") };
    const newer = { id: "v2", electionPeriodId: P, status: "voided", createdAt: at("2026-06-03") };
    const pick = pickOnePerPeriod([newer, older], CTI_STATUS_RANK).get(P);
    expect(pick?.id).toBe("v2");
    expect(pick?.status).toBe("voided");
  });

  it("breaks a createdAt tie on version", () => {
    const t = at("2026-06-01");
    const v3 = { id: "v3", electionPeriodId: P, status: "voided", createdAt: t, version: 3 };
    const v1 = { id: "v1", electionPeriodId: P, status: "voided", createdAt: t, version: 1 };
    expect(pickOnePerPeriod([v3, v1], CTI_STATUS_RANK).get(P)?.id).toBe("v3");
  });

  it("keeps periods apart", () => {
    const a = { id: "a", electionPeriodId: "ep_a", status: "voided" };
    const b = { id: "b", electionPeriodId: "ep_b", status: "signed" };
    const m = pickOnePerPeriod([a, b], CTI_STATUS_RANK);
    expect(m.get("ep_a")?.id).toBe("a");
    expect(m.get("ep_b")?.id).toBe("b");
  });
});

describe("pickOnePerPeriod — F2F and election statement", () => {
  it("prefers the attested F2F over a newer scheduled one", () => {
    const attested = {
      id: "att",
      electionPeriodId: P,
      status: "attested",
      createdAt: at("2026-06-01"),
    };
    const sched = {
      id: "sch",
      electionPeriodId: P,
      status: "scheduled",
      createdAt: at("2026-06-07"),
    };
    expect(pickOnePerPeriod([attested, sched], F2F_STATUS_RANK).get(P)?.id).toBe("att");
  });

  it("prefers a signed election statement over a voided one", () => {
    const signed = { id: "s", electionPeriodId: P, status: "signed", createdAt: at("2026-06-01") };
    const voided = { id: "v", electionPeriodId: P, status: "voided", createdAt: at("2026-06-02") };
    expect(pickOnePerPeriod([signed, voided], ELECTION_STATEMENT_STATUS_RANK).get(P)?.id).toBe("s");
  });
});

describe("in-memory getPatientElectionCertification — voided CTI inserted after the live one", () => {
  it("shows the live CTI, not the voided one", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        { id: "adm", organizationId: "org", kind: "admission", state: "active", patientId: "pat" },
        {
          id: P,
          organizationId: "org",
          kind: "election_period",
          state: "active",
          admissionId: "adm",
          sequence: 1,
        },
        {
          id: "cti_live",
          organizationId: "org",
          kind: "cti",
          state: "signed",
          electionPeriodId: P,
        },
        {
          id: "cti_void",
          organizationId: "org",
          kind: "cti",
          state: "voided",
          electionPeriodId: P,
        },
        {
          id: "f2f_att",
          organizationId: "org",
          kind: "face_to_face",
          state: "attested",
          electionPeriodId: P,
        },
        {
          id: "f2f_sch",
          organizationId: "org",
          kind: "face_to_face",
          state: "scheduled",
          electionPeriodId: P,
        },
      ],
    });
    const view = await backend.service.getPatientElectionCertification("org", "pat");
    expect(view.periods[0]?.cti?.id).toBe("cti_live");
    expect(view.periods[0]?.cti?.status).toBe("signed");
    expect(view.periods[0]?.faceToFace?.id).toBe("f2f_att");
  });

  it("shows the voided CTI as voided when it is the only one", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        { id: "adm", organizationId: "org", kind: "admission", state: "active", patientId: "pat" },
        {
          id: P,
          organizationId: "org",
          kind: "election_period",
          state: "active",
          admissionId: "adm",
          sequence: 1,
        },
        {
          id: "cti_void",
          organizationId: "org",
          kind: "cti",
          state: "voided",
          electionPeriodId: P,
        },
      ],
    });
    const view = await backend.service.getPatientElectionCertification("org", "pat");
    expect(view.periods[0]?.cti).toMatchObject({ id: "cti_void", status: "voided" });
  });
});
