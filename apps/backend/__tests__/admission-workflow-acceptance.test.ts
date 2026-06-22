// apps/backend/__tests__/admission-workflow-acceptance.test.ts — M6-T12 the §7 workflow-acceptance
// suite. One scenario per §7 user story (W-RF / W-AD / W-CTI / W-F2F / W-OVR / W-DC) plus the §6.6
// cross-tenant denial, exercised end-to-end over the in-memory AdmissionRouteService (the same backend
// the routes compose over — service + emitted-events array). Deterministic: no infra, injected clock.
// The route-auth handshake (§4.5/§4.6) is proven separately in admission-routes.test.ts; this suite
// asserts the WORKFLOW outcomes (state transitions, gates, side-effects, outbox emissions).
import { describe, expect, it } from "vitest";
import {
  ActivationPreconditionError,
  ExternalReferralAlreadyIngestedError,
  F2fScheduleOutOfWindowError,
  createInMemoryAdmissionBackend,
} from "../src/modules/06-admission/index";

const ORG = "org_a";
const ORG_B = "org_b";
const U = "user_1";

/** Drive an accepted referral → a fully activatable admission (election + NOR + period-1 CTI signed). */
async function activatableAdmission() {
  const backend = createInMemoryAdmissionBackend();
  const svc = backend.service;
  const ref = await svc.createReferral(
    ORG,
    {
      source: "phone",
      receivedAt: "2026-06-01T00:00:00Z",
      receivingUserId: U,
      patientNameAtReceipt: "x",
    },
    U,
  );
  const tri = await svc.triageReferral(ORG, ref.id, "eligible", ref.version);
  const acc = await svc.acceptReferral(
    ORG,
    ref.id,
    { primaryDiagnosisIcd10: "C00", attendingPhysicianId: "doc_1" },
    tri.version,
    U,
  );
  const periods = (await svc.listElectionPeriods(ORG, acc.admissionId)) ?? [];
  const period1 = periods[0]!;
  const es = await svc.draftElectionStatement(ORG, acc.admissionId, period1.id);
  await svc.signElection(ORG, es.id, es.version, U);
  await svc.acknowledgeNor(ORG, acc.admissionId, U);
  const cti = await svc.draftCti(
    ORG,
    {
      electionPeriodId: period1.id,
      hospiceMedicalDirectorId: "md_1",
      attendingPhysicianId: "doc_1",
      isRecert: false,
    },
    U,
  );
  const s1 = await svc.signCtiHospiceMd(ORG, cti.id, cti.version, U); // period 1 + attending → awaiting_attending
  await svc.signCtiAttending(ORG, cti.id, s1.version, U); // → signed
  return { backend, svc, admissionId: acc.admissionId };
}

describe("M6-T12 §7.1 — receive & triage referral (W-RF)", () => {
  it("W-RF-01/03/04: create → triage → accept drafts the admission bundle and emits the outbox chain", async () => {
    const backend = createInMemoryAdmissionBackend();
    const svc = backend.service;
    const ref = await svc.createReferral(
      ORG,
      {
        source: "phone",
        receivedAt: "2026-06-01T00:00:00Z",
        receivingUserId: U,
        patientNameAtReceipt: "x",
      },
      U,
    );
    expect(ref.state).toBe("received");
    const tri = await svc.triageReferral(ORG, ref.id, "eligible", ref.version);
    expect(tri.state).toBe("triaged");
    const acc = await svc.acceptReferral(
      ORG,
      ref.id,
      { primaryDiagnosisIcd10: "C00" },
      tri.version,
      U,
    );
    expect(acc.state).toBe("accepted");
    expect(acc.admissionId).toBeTruthy();
    // the draft bundle: a period-1 + an open NOR compliance window exist on the new admission.
    expect((await svc.listElectionPeriods(ORG, acc.admissionId))?.length).toBe(1);
    expect(backend.events).toEqual(
      expect.arrayContaining([
        "m6.referral.received",
        "m6.referral.triaged",
        "m6.referral.accepted",
        "m6.admission.draft_created",
      ]),
    );
  });

  it("W-RF-02: re-ingest of a known externalReferralId is a 409, never a duplicate row", async () => {
    const svc = createInMemoryAdmissionBackend().service;
    const base = {
      source: "hearthnote",
      receivedAt: "2026-06-01T00:00:00Z",
      receivingUserId: U,
      patientNameAtReceipt: "x",
      externalReferralId: "EXT-1",
    };
    await svc.createReferral(ORG, base, U);
    await expect(svc.createReferral(ORG, base, U)).rejects.toBeInstanceOf(
      ExternalReferralAlreadyIngestedError,
    );
  });
});

describe("M6-T12 §7.2 — admission wizard + activation gate (W-AD)", () => {
  it("W-AD-02/04: signing the election + acknowledging the NOR emit their outbox events and close the window", async () => {
    const { backend } = await activatableAdmission();
    expect(backend.events).toEqual(
      expect.arrayContaining([
        "m6.election.signed",
        "m6.nor.acknowledged",
        "m6.compliance.window.closed",
      ]),
    );
  });

  it("W-AD-05: with every precondition met the admission activates; the gate is server-truth", async () => {
    const { backend, svc, admissionId } = await activatableAdmission();
    const det = await svc.getAdmission(ORG, admissionId);
    expect(det?.activationGate.ready).toBe(true);
    const act = await svc.activateAdmission(ORG, admissionId, det!.version);
    expect(act.state).toBe("active");
    expect(backend.events).toContain("m6.admission.activated");
  });

  it("W-AD-05 edge: activation blocked surfaces the missing[] gate codes (412 PRECONDITION_FAILED)", async () => {
    const svc = createInMemoryAdmissionBackend().service;
    const adm = await svc.createAdmission(
      ORG,
      { patientId: "pat_x", intakeMethod: "phone", hospiceMedicalDirectorId: "md_1" },
      U,
    );
    await expect(svc.activateAdmission(ORG, adm.id, adm.version)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(svc.activateAdmission(ORG, adm.id, adm.version)).rejects.toBeInstanceOf(
      ActivationPreconditionError,
    );
  });
});

describe("M6-T12 §7.3 — recertification CTI sign (W-CTI)", () => {
  it("W-CTI-03: a recert (period ≥2) MD signature fully signs the CTI and advances the period to active", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_recert",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_r",
        },
        {
          id: "period2",
          organizationId: ORG,
          kind: "election_period",
          state: "pending",
          admissionId: "adm_recert",
          sequence: 2,
          periodStartDate: "2026-09-27",
        },
      ],
    });
    const svc = backend.service;
    const cti = await svc.draftCti(
      ORG,
      { electionPeriodId: "period2", hospiceMedicalDirectorId: "md_1", isRecert: true },
      U,
    );
    const signed = await svc.signCtiHospiceMd(ORG, cti.id, cti.version, U);
    expect(signed.state).toBe("signed"); // no attending on a recert → fully signed on the MD signature alone
    expect(backend.events).toEqual(
      expect.arrayContaining(["m6.cti.signed", "m6.election.period_started"]),
    );
  });
});

describe("M6-T12 §7.4 — conduct & attest F2F (W-F2F)", () => {
  it("W-F2F-01: a scheduled date outside the CMS 418.22 prior-to window is rejected (422)", async () => {
    const svc = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_f",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_f",
        },
        {
          id: "period_f",
          organizationId: ORG,
          kind: "election_period",
          state: "active",
          admissionId: "adm_f",
          sequence: 3,
          periodStartDate: "2026-09-27",
        },
      ],
    }).service;
    // window = [2026-08-28, 2026-09-26]; 2026-10-15 is past it.
    await expect(
      svc.scheduleF2f(ORG, {
        admissionId: "adm_f",
        electionPeriodId: "period_f",
        scheduledClinicianId: "np_1",
        clinicianRole: "np",
        scheduledDate: "2026-10-15",
      }),
    ).rejects.toBeInstanceOf(F2fScheduleOutOfWindowError);
  });

  it("W-F2F-02/03: schedule-in-window → complete → attest closes the F2F and emits m6.f2f.attested", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_f",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_f",
        },
        {
          id: "period_f",
          organizationId: ORG,
          kind: "election_period",
          state: "active",
          admissionId: "adm_f",
          sequence: 3,
          periodStartDate: "2026-09-27",
        },
      ],
    });
    const svc = backend.service;
    const f2f = await svc.scheduleF2f(ORG, {
      admissionId: "adm_f",
      electionPeriodId: "period_f",
      scheduledClinicianId: "np_1",
      clinicianRole: "np",
      scheduledDate: "2026-09-01",
    });
    const done = await svc.completeF2f(ORG, f2f.id, f2f.version);
    expect(done.state).toBe("completed");
    const att = await svc.attestF2f(ORG, f2f.id, done.version, "np_1");
    expect(att.state).toBe("attested");
    expect(backend.events).toEqual(expect.arrayContaining(["m6.f2f.scheduled", "m6.f2f.attested"]));
  });
});

describe("M6-T12 §7.5 — F2F window override (W-OVR)", () => {
  it("W-OVR-02: a compliance-officer override emits m6.f2f.window_overridden (high severity at emit)", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "f2f_o",
          organizationId: ORG,
          kind: "f2f",
          state: "scheduled",
          scheduledClinicianId: "np_1",
          admissionId: "adm_f",
        },
      ],
    });
    const out = await backend.service.overrideF2fWindow(
      ORG,
      "f2f_o",
      "documentation supports the late F2F",
      1,
      U,
    );
    expect(out.id).toBe("f2f_o");
    expect(backend.events).toContain("m6.f2f.window_overridden");
  });
});

describe("M6-T12 §7.6 — discharge workflows (W-DC)", () => {
  it("W-DC-01: a death discharge routes to bereavement and fires bereavement eligibility", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_d",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_d",
        },
        {
          id: "period_d",
          organizationId: ORG,
          kind: "election_period",
          state: "active",
          admissionId: "adm_d",
          sequence: 1,
          periodStartDate: "2026-01-30",
        },
      ],
    });
    const res = await backend.service.discharge(
      ORG,
      "adm_d",
      { reason: "death", dischargeDate: "2026-03-15", narrative: "patient passed at home" },
      U,
    );
    expect(res.reason).toBe("death");
    const adm = await backend.service.getAdmission(ORG, "adm_d");
    expect(adm?.state).toBe("bereavement");
    expect(backend.events).toEqual(
      expect.arrayContaining([
        "m6.discharge.created",
        "m6.discharge.death",
        "m6.bereavement.eligible",
      ]),
    );
  });

  it("W-DC-01: the M5 bereavement opt-out suppresses m6.bereavement.eligible", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_d2",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_d2",
          bereavementOptOut: true,
        },
        {
          id: "period_d2",
          organizationId: ORG,
          kind: "election_period",
          state: "active",
          admissionId: "adm_d2",
          sequence: 1,
          periodStartDate: "2026-01-30",
        },
      ],
    });
    await backend.service.discharge(
      ORG,
      "adm_d2",
      { reason: "death", dischargeDate: "2026-03-15", narrative: "patient passed at home" },
      U,
    );
    expect(backend.events).not.toContain("m6.bereavement.eligible");
  });

  it("W-DC-02: a for-cause discharge keeps the admission active until the medical-director cosign", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_fc",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_fc",
        },
      ],
    });
    const svc = backend.service;
    const filed = await svc.discharge(
      ORG,
      "adm_fc",
      {
        reason: "for_cause",
        dischargeDate: "2026-06-10",
        narrative: "see for-cause reason",
        forCauseReason: "repeated abusive behavior toward staff",
      },
      U,
    );
    expect(filed.requiresMedicalDirectorCosign).toBe(true);
    expect((await svc.getAdmission(ORG, "adm_fc"))?.state).toBe("active"); // not yet discharged (D11)
    await svc.cosignDischarge(ORG, filed.id, filed.version, "md_1");
    expect((await svc.getAdmission(ORG, "adm_fc"))?.state).toBe("discharged");
    expect(backend.events).toContain("m6.discharge.cosigned");
  });

  it("W-DC-03: transfer-in inherits the prior period as active and opens our next period as pending", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        {
          id: "adm_ti",
          organizationId: ORG,
          kind: "admission",
          state: "active",
          patientId: "pat_ti",
        },
      ],
    });
    const svc = backend.service;
    const res = await svc.transferIn(
      ORG,
      "adm_ti",
      { priorBenefitPeriodSequence: 3, priorElectionStartDate: "2026-04-01" },
      U,
    );
    expect(res.currentElectionPeriodSequence).toBe(3);
    const periods = (await svc.listElectionPeriods(ORG, "adm_ti")) ?? [];
    expect(periods.map((p) => p.state).sort()).toEqual(["active", "pending"]);
    expect(backend.events).toEqual(
      expect.arrayContaining(["m6.transfer.created", "m6.election.period_started"]),
    );
  });
});

describe("M6-T12 §6.6 — cross-tenant denial", () => {
  it("a resource created in org_a is invisible (null, no leak) to org_b", async () => {
    const svc = createInMemoryAdmissionBackend().service;
    const ref = await svc.createReferral(
      ORG,
      {
        source: "phone",
        receivedAt: "2026-06-01T00:00:00Z",
        receivingUserId: U,
        patientNameAtReceipt: "x",
      },
      U,
    );
    expect(await svc.getReferral(ORG, ref.id)).not.toBeNull();
    expect(await svc.getReferral(ORG_B, ref.id)).toBeNull(); // §6.6 — tenant predicate before role/ABAC
  });
});
