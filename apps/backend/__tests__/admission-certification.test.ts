// apps/backend/__tests__/admission-certification.test.ts — M6-T08 recert CTI sign (§7.3), F2F window
// math + attest (§7.4), and the compliance-officer F2F window override (§7.5).
//
// Two layers: (1) the PURE org-timezone window math (D4 written-cert deadline + CMS 418.22 F2F window
// + the W-F2F-04 window-monitor verdict + the W-CTI-03/04 recert sign decision), exercised directly so
// the D8 timezone/DST correctness is pinned; (2) the in-memory slice, proving the §7.3 mark-late echo
// computes the deadline off the period start, a signed recert advances its period (W-CTI-03), and an
// out-of-window F2F schedule is refused (W-F2F-01). The route layer is proven once through the full M1
// chain (the §7.5 override + the W-F2F-01 422 mapping).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildAdmissionAbacPredicates,
  computeF2fWindow,
  computeWrittenCertDeadline,
  createInMemoryAdmissionBackend,
  decideF2fWindowStatus,
  decideRecertSign,
  endOfOrgDayInstant,
  isF2fScheduledWithinWindow,
  isWrittenCertOverdue,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";
const F2F_ATTESTATION_NARRATIVE =
  "Face-to-face encounter performed by the hospice clinician; findings support a terminal prognosis of six months or less (GAP-022 fixture).";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const ORG = "org_a";
const ADMISSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERIOD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MD_ID = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "44444444-4444-4444-4444-444444444444";
const CLINICIAN = "55555555-5555-5555-5555-555555555555";

// ── §7.3/§7.4 pure window math (D4 deadline + CMS 418.22 F2F window, in org TZ — D8) ─────────────────

describe("M6-T08 — §7.3 D4 written-cert deadline (org-TZ, calendar-day)", () => {
  it("is period_start + 2 calendar days at 23:59:59.999 in the org TZ (default America/Los_Angeles)", () => {
    // 2026-08-01 + 2 = 2026-08-03; end of that day in PDT (UTC-7) is 2026-08-04T06:59:59.999Z.
    expect(computeWrittenCertDeadline("2026-08-01", "America/Los_Angeles")).toBe(
      "2026-08-04T06:59:59.999Z",
    );
  });

  it("computes the same wall-clock deadline in a different org TZ (America/New_York, UTC-4 in summer)", () => {
    // 2026-08-03 23:59:59.999 EDT (UTC-4) = 2026-08-04T03:59:59.999Z.
    expect(computeWrittenCertDeadline("2026-08-01", "America/New_York")).toBe(
      "2026-08-04T03:59:59.999Z",
    );
  });

  it("crosses a DST fall-back boundary without drift (PST is UTC-8)", () => {
    // 2026-11-01 is the US DST change; period_start 2025-11-01 → deadline day 2025-11-03 is firmly PST.
    expect(endOfOrgDayInstant("2025-11-03", "America/Los_Angeles")).toBe(
      "2025-11-04T07:59:59.999Z",
    );
  });

  it("isWrittenCertOverdue is true only strictly after the deadline instant", () => {
    const deadline = computeWrittenCertDeadline("2026-08-01", "America/Los_Angeles");
    expect(isWrittenCertOverdue(deadline, "2026-08-04T06:59:59.998Z")).toBe(false);
    expect(isWrittenCertOverdue(deadline, "2026-08-04T07:00:00.000Z")).toBe(true);
  });
});

describe("M6-T08 — §7.4 F2F window (CMS 418.22 prior-to window)", () => {
  it("computes [period_start − 30, period_start − 1] in org-local dates", () => {
    const w = computeF2fWindow("2026-09-30", "America/Los_Angeles");
    expect(w.windowStart).toBe("2026-08-31");
    expect(w.windowEnd).toBe("2026-09-29");
  });

  it("W-F2F-01: a date inside the window passes; the boundaries are inclusive; outside fails", () => {
    const w = computeF2fWindow("2026-09-30", "America/Los_Angeles");
    expect(isF2fScheduledWithinWindow("2026-09-15", w)).toBe(true);
    expect(isF2fScheduledWithinWindow("2026-08-31", w)).toBe(true); // earliest
    expect(isF2fScheduledWithinWindow("2026-09-29", w)).toBe(true); // latest
    expect(isF2fScheduledWithinWindow("2026-08-30", w)).toBe(false); // too early
    expect(isF2fScheduledWithinWindow("2026-09-30", w)).toBe(false); // the period start itself
  });

  it("W-F2F-04: the window monitor reports open / missed / attested", () => {
    const w = computeF2fWindow("2026-09-30", "America/Los_Angeles");
    expect(decideF2fWindowStatus({ today: "2026-09-15", window: w, attested: false })).toBe("open");
    expect(decideF2fWindowStatus({ today: "2026-09-30", window: w, attested: false })).toBe(
      "missed",
    );
    expect(decideF2fWindowStatus({ today: "2026-09-30", window: w, attested: true })).toBe(
      "attested",
    );
  });
});

describe("M6-T08 — §7.3 recert sign decision (W-CTI-03/04)", () => {
  it("period 1 with an attending needs the co-sign and never advances the period", () => {
    const afterMd = decideRecertSign({
      sequence: 1,
      patientHasAttending: true,
      hospiceMdSigned: true,
      attendingSigned: false,
    });
    expect(afterMd).toEqual({
      progress: "awaiting_attending",
      fullySigned: false,
      activatesPeriod: false,
    });
    const afterBoth = decideRecertSign({
      sequence: 1,
      patientHasAttending: true,
      hospiceMdSigned: true,
      attendingSigned: true,
    });
    expect(afterBoth).toEqual({ progress: "signed", fullySigned: true, activatesPeriod: false });
  });

  it("a recert (period ≥ 2) is fully signed on the MD signature and advances its period", () => {
    expect(
      decideRecertSign({
        sequence: 2,
        patientHasAttending: false,
        hospiceMdSigned: true,
        attendingSigned: false,
      }),
    ).toEqual({
      progress: "signed",
      fullySigned: true,
      activatesPeriod: true,
    });
  });
});

// ── slice wiring (in-memory backend) ────────────────────────────────────────────────────────────────

/** Seed an admission + an election period (sequence/start configurable) for the recert/F2F flows. */
function seedBackend(period: { sequence: number; periodStartDate: string }) {
  return createInMemoryAdmissionBackend({
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "pending",
        patientId: "pat_1",
      },
      {
        id: PERIOD,
        organizationId: ORG,
        kind: "election_period",
        state: "pending",
        admissionId: ADMISSION,
        sequence: period.sequence,
        periodStartDate: period.periodStartDate,
      },
    ],
  });
}

describe("M6-T08 — §7.3 slice: mark-late echoes the D4 deadline; recert sign advances the period", () => {
  it("mark-late computes writtenCertDeadlineAt from the period start in org TZ", async () => {
    const { service } = seedBackend({ sequence: 2, periodStartDate: "2026-08-01" });
    const cti = await service.draftCti(
      ORG,
      {
        electionPeriodId: PERIOD,
        hospiceMedicalDirectorId: MD_ID,
        ...CTI_CLINICAL,
        isRecert: true,
      },
      "u1",
    );
    const late = await service.markCtiLate(ORG, cti.id, cti.version);
    expect(late.writtenCertDeadlineAt).toBe(
      computeWrittenCertDeadline("2026-08-01", "America/Los_Angeles"),
    );
  });

  it("W-CTI-03: signing a recert CTI moves it to signed, advances the period, emits both events", async () => {
    const { service, events } = seedBackend({ sequence: 2, periodStartDate: "2026-08-01" });
    const cti = await service.draftCti(
      ORG,
      {
        electionPeriodId: PERIOD,
        hospiceMedicalDirectorId: MD_ID,
        ...CTI_CLINICAL,
        isRecert: true,
      },
      "u1",
    );
    const signed = await service.signCtiHospiceMd(ORG, cti.id, cti.version, "u1");
    expect(signed.state).toBe("signed");
    expect(events).toContain("m6.cti.signed");
    expect(events).toContain("m6.election.period_started");
    const periods = await service.listElectionPeriods(ORG, ADMISSION);
    expect(periods?.find((p) => p.id === PERIOD)?.state).toBe("active");
  });

  it("W-CTI-04: a period-1 CTI with an attending awaits the co-sign and does NOT advance the period", async () => {
    const { service, events } = seedBackend({ sequence: 1, periodStartDate: "2026-06-20" });
    const cti = await service.draftCti(
      ORG,
      {
        electionPeriodId: PERIOD,
        hospiceMedicalDirectorId: MD_ID,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      "u1",
    );
    const afterMd = await service.signCtiHospiceMd(ORG, cti.id, cti.version, "u1");
    expect(afterMd.state).toBe("awaiting_attending");
    expect(events).not.toContain("m6.election.period_started");
    const afterAttending = await service.signCtiAttending(ORG, cti.id, afterMd.version, "u1");
    expect(afterAttending.state).toBe("signed");
  });
});

describe("M6-T08 — §7.4 slice: F2F schedule is gated by the recert window", () => {
  it("W-F2F-01: a date inside the window schedules; an out-of-window date is refused (F2F_OUTSIDE_WINDOW)", async () => {
    const { service, events } = seedBackend({ sequence: 3, periodStartDate: "2026-09-30" });
    const ok = await service.scheduleF2f(ORG, {
      admissionId: ADMISSION,
      electionPeriodId: PERIOD,
      scheduledClinicianId: CLINICIAN,
      clinicianRole: "hospice_np",
      actor: SYSTEM_F2F_ACTOR,
      scheduledDate: "2026-09-15",
    });
    expect(ok.state).toBe("scheduled");
    expect(events).toContain("m6.f2f.scheduled");

    await expect(
      service.scheduleF2f(ORG, {
        admissionId: ADMISSION,
        electionPeriodId: PERIOD,
        scheduledClinicianId: CLINICIAN,
        clinicianRole: "hospice_np",
        actor: SYSTEM_F2F_ACTOR,
        scheduledDate: "2026-08-01", // before period_start − 30
      }),
    ).rejects.toMatchObject({ code: "F2F_OUTSIDE_WINDOW", statusCode: 422 });
  });
});

// ── route layer (full M1 chain) — §7.5 override + W-F2F-01 422 mapping ───────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const F2F_SEED = "ffffffff-ffff-4fff-8fff-ffffffffffff";

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
      {
        id: PERIOD,
        organizationId: ORG,
        kind: "election_period",
        state: "active",
        admissionId: ADMISSION,
        sequence: 3,
        periodStartDate: "2026-09-30",
      },
      {
        id: F2F_SEED,
        organizationId: ORG,
        kind: "f2f",
        state: "completed",
        admissionId: ADMISSION,
        scheduledClinicianId: CLINICIAN,
      },
    ],
  });
  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "compliance_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["f2f.schedule", "f2f.window_override"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH registry per server — see admission-routes.test.ts's `makeServer()` for why.
  const registry = createPredicateRegistry();
  const predicates = buildAdmissionAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, { service: backend.service });
  return { app, backend };
}

const COMPLIANCE = {
  "x-test-user": "compliance_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M6-T08 — route layer", () => {
  it("W-F2F-01: scheduling an out-of-window F2F returns 422 F2F_OUTSIDE_WINDOW through the M1 chain", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
      headers: COMPLIANCE,
      payload: {
        electionPeriodId: PERIOD,
        scheduledDate: "2026-08-01",
        windowStart: "2026-08-31",
        windowEnd: "2026-09-29",
        clinicianRole: "hospice_np",
        actor: SYSTEM_F2F_ACTOR,
        scheduledClinicianId: CLINICIAN,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("F2F_OUTSIDE_WINDOW");
    await app.close();
  });

  it("W-OVR-02/03: a compliance officer overrides the F2F window; the event fires", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F_SEED}/override-window`,
      headers: COMPLIANCE,
      payload: {
        reason: "Documentation supports a same-day override per chart review.",
        ifVersion: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(backend.events).toContain("m6.f2f.window_overridden");
    await app.close();
  });
});
