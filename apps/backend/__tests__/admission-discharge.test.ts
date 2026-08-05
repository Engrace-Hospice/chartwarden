// apps/backend/__tests__/admission-discharge.test.ts — M6-T09 discharge / revocation / transfer / LOC
// (§6.3 reason-specific permission mapping + §7.6 workflows).
//
// Three layers: (1) the PURE §6.3 reason→permission derivation + per-reason narrative gates, the
// M6-owned bereavement-eligibility rule (W-DC-01), the for-cause cosign cascade (W-DC-02), and the
// transfer-in inherited-period sequencing (W-DC-03), exercised directly so the policy table is pinned;
// (2) the in-memory slice, proving for-cause keeps the admission active until cosign, death routes to
// bereavement + fires `m6.bereavement.eligible`, and transfer-in inherits the period sequence; (3) the
// route layer (full M1 chain), proving the §6.3 reason-derived permission and the per-reason narrative
// gate map to the right status codes.
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  DISCHARGE_POLICY,
  checkDischargeNarrative,
  createInMemoryAdmissionBackend,
  decideBereavementEligibility,
  deriveDischargePermissionKey,
  fileForCauseDischarge,
  isDischargeReason,
  planTransferIn,
  registerAdmissionAbacPredicates,
  registerAdmissionRoutes,
  resolveForCauseDischarge,
} from "../src/modules/06-admission/index";

const ORG = "org_a";
const ADMISSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERIOD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ── §6.3 reason-specific permission mapping (pure) ───────────────────────────────────────────────────

describe("M6-T09 — §6.3 discharge reason → permission key derivation", () => {
  it("derives the spec's per-reason key for each of the five reasons", () => {
    expect(deriveDischargePermissionKey("death")).toBe("discharge.death");
    expect(deriveDischargePermissionKey("moved_out_of_service_area")).toBe("discharge.moved");
    expect(deriveDischargePermissionKey("no_longer_terminal")).toBe("discharge.no_longer_terminal");
    expect(deriveDischargePermissionKey("for_cause")).toBe("discharge.for_cause");
    expect(deriveDischargePermissionKey("other")).toBe("discharge.other");
  });

  it("falls back to the broadest discharge.create gate for an absent / unrecognised reason", () => {
    expect(deriveDischargePermissionKey(undefined)).toBe("discharge.create");
    expect(deriveDischargePermissionKey("bogus")).toBe("discharge.create");
    expect(deriveDischargePermissionKey(42)).toBe("discharge.create");
  });

  it("isDischargeReason recognises exactly the five reasons", () => {
    expect(isDischargeReason("death")).toBe(true);
    expect(isDischargeReason("for_cause")).toBe(true);
    expect(isDischargeReason("revocation")).toBe(false);
    expect(isDischargeReason(undefined)).toBe(false);
  });

  it("only for_cause requires a medical-director cosign (D11)", () => {
    expect(DISCHARGE_POLICY.for_cause.requiresMedicalDirectorCosign).toBe(true);
    expect(DISCHARGE_POLICY.death.requiresMedicalDirectorCosign).toBe(false);
    expect(DISCHARGE_POLICY.no_longer_terminal.requiresMedicalDirectorCosign).toBe(false);
    expect(DISCHARGE_POLICY.moved_out_of_service_area.requiresMedicalDirectorCosign).toBe(false);
    expect(DISCHARGE_POLICY.other.requiresMedicalDirectorCosign).toBe(false);
  });

  it("D11 tightens the narrative minimum for no_longer_terminal (≥20) and other (≥40)", () => {
    expect(DISCHARGE_POLICY.no_longer_terminal.minNarrativeChars).toBe(20);
    expect(DISCHARGE_POLICY.other.minNarrativeChars).toBe(40);
    expect(DISCHARGE_POLICY.death.minNarrativeChars).toBe(10);
  });
});

describe("M6-T09 — §6.3 per-reason narrative gates", () => {
  it("for_cause requires a forCauseReason ≥ 20 chars (NARRATIVE_REQUIRED_FOR_CAUSE)", () => {
    expect(checkDischargeNarrative("for_cause", "y".repeat(40), undefined)?.code).toBe(
      "NARRATIVE_REQUIRED_FOR_CAUSE",
    );
    expect(checkDischargeNarrative("for_cause", "y".repeat(40), "too short")?.code).toBe(
      "NARRATIVE_REQUIRED_FOR_CAUSE",
    );
    expect(checkDischargeNarrative("for_cause", "y".repeat(40), "z".repeat(20))).toBeNull();
  });

  it("no_longer_terminal needs ≥20 chars and other ≥40 (DISCHARGE_NARRATIVE_TOO_SHORT)", () => {
    expect(checkDischargeNarrative("no_longer_terminal", "x".repeat(19))?.code).toBe(
      "DISCHARGE_NARRATIVE_TOO_SHORT",
    );
    expect(checkDischargeNarrative("no_longer_terminal", "x".repeat(20))).toBeNull();
    expect(checkDischargeNarrative("other", "x".repeat(39))?.code).toBe(
      "DISCHARGE_NARRATIVE_TOO_SHORT",
    );
    expect(checkDischargeNarrative("other", "x".repeat(40))).toBeNull();
  });

  it("death/moved pass with the base ≥10-char narrative", () => {
    expect(checkDischargeNarrative("death", "expired at home")).toBeNull();
    expect(checkDischargeNarrative("moved_out_of_service_area", "moved to FL")).toBeNull();
  });
});

// ── §7.6 W-DC-01 bereavement eligibility (M6-owned rule) ─────────────────────────────────────────────

describe("M6-T09 — §7.6 W-DC-01 bereavement eligibility rule (D6)", () => {
  it("eligible when death + active election ≥ 1 day + opt-out NOT set", () => {
    expect(
      decideBereavementEligibility({
        reason: "death",
        daysOnActiveElectionBeforeDeath: 45,
        bereavementOptOut: false,
      }).eligible,
    ).toBe(true);
  });
  it("suppressed by the M5 opt-out flag", () => {
    expect(
      decideBereavementEligibility({
        reason: "death",
        daysOnActiveElectionBeforeDeath: 45,
        bereavementOptOut: true,
      }).eligible,
    ).toBe(false);
  });
  it("suppressed when the election was shorter than one day", () => {
    expect(
      decideBereavementEligibility({
        reason: "death",
        daysOnActiveElectionBeforeDeath: 0,
        bereavementOptOut: false,
      }).eligible,
    ).toBe(false);
  });
  it("never fires for a non-death discharge", () => {
    expect(
      decideBereavementEligibility({
        reason: "for_cause",
        daysOnActiveElectionBeforeDeath: 45,
        bereavementOptOut: false,
      }).eligible,
    ).toBe(false);
  });
});

// ── §7.6 W-DC-02 for-cause cosign cascade (D11) + W-DC-03 transfer-in (D9) ────────────────────────────

describe("M6-T09 — §7.6 W-DC-02 for-cause cosign cascade", () => {
  it("filing keeps the admission active and emits only m6.discharge.created", () => {
    expect(fileForCauseDischarge()).toEqual({
      dischargeState: "awaiting_cosign",
      admissionState: "active",
      pendingForCauseDischarge: true,
      events: ["m6.discharge.created"],
    });
  });
  it("cosign completes the discharge and discharges the admission", () => {
    const o = resolveForCauseDischarge("cosign");
    expect(o.dischargeState).toBe("completed");
    expect(o.admissionState).toBe("discharged");
    expect(o.events).toEqual(["m6.discharge.cosigned", "m6.admission.discharged"]);
  });
  it("reject voids the discharge and returns the admission to active (no fan-out)", () => {
    const o = resolveForCauseDischarge("reject");
    expect(o.dischargeState).toBe("voided");
    expect(o.admissionState).toBe("active");
    expect(o.events).toEqual([]);
  });
});

describe("M6-T09 — §7.6 W-DC-03 transfer-in inherited period sequencing (D9)", () => {
  it("inherits the carried sequence as the active period and opens the next pending period", () => {
    const plan = planTransferIn({
      priorBenefitPeriodSequence: 3,
      priorElectionStartDate: "2026-04-01",
    });
    expect(plan.inherited).toEqual({ sequence: 3, state: "active", ctiRequired: false });
    expect(plan.next).toEqual({ sequence: 4, state: "pending", ctiRequired: true });
  });
});

// ── slice wiring (in-memory backend) ────────────────────────────────────────────────────────────────

function seedAdmission(opts: { bereavementOptOut?: boolean; periodStart?: string } = {}) {
  return createInMemoryAdmissionBackend({
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: "pat_1",
        bereavementOptOut: opts.bereavementOptOut,
      },
      ...(opts.periodStart
        ? [
            {
              id: PERIOD,
              organizationId: ORG,
              kind: "election_period",
              state: "active",
              admissionId: ADMISSION,
              sequence: 1,
              periodStartDate: opts.periodStart,
            },
          ]
        : []),
    ],
  });
}

describe("M6-T09 — slice: discharge cascades (§7.6)", () => {
  it("W-DC-01: death routes the admission to bereavement and fires the bereavement-eligible event", async () => {
    const { service, events } = seedAdmission({ periodStart: "2026-01-30" });
    const res = await service.discharge(
      ORG,
      ADMISSION,
      { reason: "death", dischargeDate: "2026-03-15", narrative: "patient expired at home" },
      "u1",
    );
    expect(res.requiresMedicalDirectorCosign).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        "m6.discharge.created",
        "m6.admission.discharged",
        "m6.discharge.death",
        "m6.bereavement.eligible",
      ]),
    );
    const adm = await service.getAdmission(ORG, ADMISSION);
    expect(adm?.state).toBe("bereavement");
  });

  it("W-DC-01: the M5 opt-out flag suppresses the bereavement-eligible event", async () => {
    const { service, events } = seedAdmission({
      bereavementOptOut: true,
      periodStart: "2026-01-30",
    });
    await service.discharge(
      ORG,
      ADMISSION,
      { reason: "death", dischargeDate: "2026-03-15", narrative: "patient expired at home" },
      "u1",
    );
    expect(events).toContain("m6.discharge.death");
    expect(events).not.toContain("m6.bereavement.eligible");
  });

  it("W-DC-02: filing a for-cause discharge keeps the admission active until cosign", async () => {
    const { service, events } = seedAdmission();
    const filed = await service.discharge(
      ORG,
      ADMISSION,
      {
        reason: "for_cause",
        dischargeDate: "2026-06-20",
        narrative: "for-cause per 418.26",
        forCauseReason: "z".repeat(30),
      },
      "u1",
    );
    expect(filed.requiresMedicalDirectorCosign).toBe(true);
    expect(filed.state).toBe("awaiting_cosign");
    expect(events).toContain("m6.discharge.created");
    expect(events).not.toContain("m6.admission.discharged");
    expect((await service.getAdmission(ORG, ADMISSION))?.state).toBe("active");

    const cosigned = await service.cosignDischarge(ORG, filed.id, filed.version, "md_1");
    expect(cosigned.state).toBe("completed");
    expect(events).toContain("m6.discharge.cosigned");
    expect(events).toContain("m6.admission.discharged");
    expect((await service.getAdmission(ORG, ADMISSION))?.state).toBe("discharged");
  });

  it("§6.3: a too-short no_longer_terminal narrative is rejected (DISCHARGE_NARRATIVE_TOO_SHORT)", async () => {
    const { service } = seedAdmission();
    await expect(
      service.discharge(
        ORG,
        ADMISSION,
        { reason: "no_longer_terminal", dischargeDate: "2026-06-20", narrative: "too short" },
        "u1",
      ),
    ).rejects.toMatchObject({ code: "DISCHARGE_NARRATIVE_TOO_SHORT", statusCode: 422 });
  });

  it("W-DC-03: transfer-in creates the inherited active + next pending periods (no counter restart)", async () => {
    const { service, events } = seedAdmission();
    const res = await service.transferIn(
      ORG,
      ADMISSION,
      {
        priorBenefitPeriodSequence: 3,
        priorElectionStartDate: "2026-04-01",
        hospiceMedicalDirectorId: "md_1",
      },
      "u1",
    );
    expect(res.currentElectionPeriodSequence).toBe(3);
    expect(events).toContain("m6.transfer.created");
    const periods = await service.listElectionPeriods(ORG, ADMISSION);
    expect(periods?.length).toBe(2);
  });

  it("revocation and transfer-out discharge the admission; LOC change emits m6.loc.changed", async () => {
    const rev = seedAdmission();
    await rev.service.createRevocation(ORG, ADMISSION, "u1");
    expect(rev.events).toEqual(
      expect.arrayContaining(["m6.revocation.created", "m6.admission.discharged"]),
    );

    const xfer = seedAdmission();
    await xfer.service.transferOut(ORG, ADMISSION, "u1");
    expect(xfer.events).toEqual(
      expect.arrayContaining(["m6.transfer.created", "m6.admission.discharged"]),
    );

    const loc = seedAdmission();
    await loc.service.changeLoc(ORG, ADMISSION, "gip");
    expect(loc.events).toContain("m6.loc.changed");
  });
});

// ── route layer (full M1 chain) — §6.3 reason-derived permission + narrative gate ────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

function makeServer() {
  const backend = createInMemoryAdmissionBackend({
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: "pat_1",
      },
    ],
  });
  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "md_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [
            "discharge.no_longer_terminal",
            "discharge.for_cause",
            "discharge.death",
          ],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);
  registerAdmissionAbacPredicates({ resolver: backend.resolver, isInCaseload: async () => true });
  registerAbacRegistry();

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, { service: backend.service });
  return { app, backend };
}

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "medical_director" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M6-T09 — route layer (§6.3)", () => {
  it("a too-short no_longer_terminal narrative returns 422 DISCHARGE_NARRATIVE_TOO_SHORT through the chain", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: MD,
      payload: {
        reason: "no_longer_terminal",
        dischargeDate: "2026-06-20",
        narrative: "too short!",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCHARGE_NARRATIVE_TOO_SHORT");
    await app.close();
  });

  it("for_cause without a forCauseReason returns 412 NARRATIVE_REQUIRED_FOR_CAUSE", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: MD,
      payload: {
        reason: "for_cause",
        dischargeDate: "2026-06-20",
        narrative: "for-cause discharge per 418.26",
      },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("NARRATIVE_REQUIRED_FOR_CAUSE");
    await app.close();
  });
});
