/**
 * COP27 API seed — chart-level clinical records: care plan content, care-team RN + scheduled visits,
 * medication orders with their hospice coverage determination, and a supply request determined not covered.
 *
 * All of these are patient-scoped (caseload or org-wide scope), so in practice they run as the physician
 * account; with the admin alone they are recorded as skips. Non-covered drugs and supplies are what the
 * FY2027 addendum lists as "items not covered" (418.24(c)(5)).
 */
import type { AdmissionHandle } from "./admission";
import type { SeedContext } from "./context";
import { type SeedCalendar, addDays } from "./dates";
import { ApiError, SkipStep, asAnyone, must, readAsAnyone } from "./http";
import type { ScenarioRun } from "./run";

interface CarePlanView {
  id: string;
  problems: Array<{ id: string; description: string; kind?: string }>;
  goals: Array<{ id: string; originalText?: string }>;
}

async function readCarePlan(ctx: SeedContext, patientId: string): Promise<CarePlanView | null> {
  type Raw = Partial<CarePlanView> & { carePlan?: (Partial<CarePlanView> & { id: string }) | null };
  const raw = await readAsAnyone<Raw>("read care plan", ctx.sessions, (s) =>
    s.client.GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } }),
  );
  // No plan yet reads as `{ carePlan: null }`; a redacted read carries the id without the elements.
  const plan = raw && "carePlan" in raw ? raw.carePlan : raw;
  if (!plan?.id) return null;
  return { id: plan.id, problems: plan.problems ?? [], goals: plan.goals ?? [] };
}

const CARE_PLAN_POLL_ATTEMPTS = 10;
const CARE_PLAN_POLL_MS = 1_000;

const PROBLEMS = [
  {
    icd10Code: "C34.90",
    description: "DEMO — metastatic lung cancer (terminal diagnosis)",
    kind: "terminal",
  },
  {
    icd10Code: "R06.00",
    description: "DEMO — dyspnea related to the terminal illness",
    kind: "related",
  },
  {
    icd10Code: "E11.9",
    description: "DEMO — type 2 diabetes, unrelated to the terminal illness",
    kind: "unrelated",
  },
] as const;

/** The plan of care (opened at activation) gets a terminal, a related and an unrelated problem + a goal. */
export async function ensureCarePlan(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<void> {
  const plan = await run.soft(
    "care plan",
    () => readCarePlan(ctx, adm.patient.id),
    async () => {
      // The admission-activated consumer opens the plan asynchronously, so a read right after activation can
      // miss it and this POST then loses the race: that 409 means the plan exists, so wait for it to read back.
      await asAnyone("open care plan", ctx.sessions, (s) =>
        s.client.POST("/api/v1/patients/{patientId}/care-plan", {
          params: { path: { patientId: adm.patient.id } },
          body: { admissionId: adm.id },
        }),
      ).catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "ONE_ACTIVE_PLAN_PER_ADMISSION") return;
        throw e;
      });
      for (let i = 0; i < CARE_PLAN_POLL_ATTEMPTS; i++) {
        const p = await readCarePlan(ctx, adm.patient.id);
        if (p) return p;
        await new Promise((r) => setTimeout(r, CARE_PLAN_POLL_MS));
      }
      throw new Error("care plan not readable after create");
    },
    (p) => `plan ${p.id}`,
  );
  if (!plan) return;
  for (const problem of PROBLEMS) {
    await run.soft(
      `care plan problem (${problem.kind})`,
      async () => {
        const p = await readCarePlan(ctx, adm.patient.id);
        return p?.problems.find((x) => x.description === problem.description) ?? null;
      },
      async () => {
        await asAnyone("add care plan problem", ctx.sessions, (s) =>
          s.client.POST("/api/v1/care-plans/{planId}/problems", {
            params: { path: { planId: plan.id } },
            body: { ...problem, source: "clinical" },
          }),
        );
        return { id: "", description: problem.description };
      },
    );
  }
  const goalText =
    "DEMO — breathing feels comfortable at rest; dies in the place of their choosing";
  await run.soft(
    "care plan goal",
    async () => {
      const p = await readCarePlan(ctx, adm.patient.id);
      return p?.goals.find((g) => g.originalText === goalText) ?? null;
    },
    async () => {
      const p = await readCarePlan(ctx, adm.patient.id);
      const terminal = p?.problems.find((x) => x.description === PROBLEMS[0].description);
      if (!terminal) throw new SkipStep("the terminal problem is not on the plan");
      await asAnyone("add care plan goal", ctx.sessions, (s) =>
        s.client.POST("/api/v1/care-plans/{planId}/goals", {
          params: { path: { planId: plan.id } },
          body: {
            problemId: terminal.id,
            originalText: goalText,
            source: "patient_stated",
            measurableOutcome: "Dyspnea 3/10 or less at every RN visit",
          },
        }),
      );
      return { id: "" };
    },
  );
}

interface Member {
  membershipId: string;
  userId: string;
  displayName: string | null;
}

async function rnMember(ctx: SeedContext): Promise<Member | null> {
  if (!ctx.rnMembershipId) return null;
  const r = await must<{ members: Member[] }>(
    "list members",
    ctx.admin.client.GET("/api/v1/orgs/{id}/members", {
      params: { path: { id: ctx.admin.organizationId } },
    }),
  );
  return r.members.find((m) => m.membershipId === ctx.rnMembershipId) ?? null;
}

async function ensurePrimaryAddress(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<string | null> {
  const list = async (): Promise<string | null> => {
    const r = await readAsAnyone<{ addresses: Array<{ id?: string; addressId?: string }> }>(
      "list addresses",
      ctx.sessions,
      (s) =>
        s.client.GET("/api/v1/patients/{id}/addresses", {
          params: { path: { id: adm.patient.id } },
        }),
    );
    const first = r?.addresses[0];
    return first ? (first.id ?? first.addressId ?? null) : null;
  };
  return run.soft("home address", list, async () => {
    const loc = ctx.location?.address;
    const r = await asAnyone<{ addressId: string }>("add address", ctx.sessions, (s) =>
      s.client.POST("/api/v1/patients/{id}/addresses", {
        params: { path: { id: adm.patient.id } },
        body: {
          line1: "1 Demo Data Way (fictional)",
          city: loc?.city ?? "Asheville",
          state: loc?.state ?? "NC",
          postalCode: loc?.postalCode ?? "28801",
          kind: "home",
          isPrimary: true,
        },
      }),
    );
    return r.addressId;
  });
}

/**
 * The org's RN on the care team, then two scheduled RN visits. `slot` staggers the visit hour per scenario so
 * one RN's demo visits never overlap (the scheduler refuses double-booking).
 */
export async function ensureVisits(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
  slot: number,
): Promise<void> {
  const rn = await rnMember(ctx);
  if (!rn) {
    run.skip(
      "RN visits",
      "no member of the organization has the RN discipline (scheduling staff directory)",
    );
    return;
  }
  await run.soft(
    "primary RN on care team",
    async () => {
      const r = await readAsAnyone<{ assignments: Array<{ role: string; current: boolean }> }>(
        "list assignments",
        ctx.sessions,
        (s) =>
          s.client.GET("/api/v1/patients/{id}/assignments", {
            params: { path: { id: adm.patient.id } },
          }),
      );
      return r?.assignments.some((a) => a.role === "primary_rn" && a.current) ? true : null;
    },
    async () => {
      await asAnyone("assign primary RN", ctx.sessions, (s) =>
        s.client.POST("/api/v1/patients/{id}/assignments", {
          params: { path: { id: adm.patient.id } },
          body: {
            clinicianUserId: rn.userId,
            role: "primary_rn",
            reason: "DEMO DATA — primary RN",
          },
        }),
      );
      return true;
    },
    () => rn.displayName ?? rn.membershipId,
  );
  const addressId = await ensurePrimaryAddress(run, ctx, adm);
  if (!addressId) return;
  for (const [i, daysAhead] of [2, 9].entries()) {
    const day = addDays(cal.today, daysAhead);
    // 13:00Z + slot hours ≈ 9:00 local Eastern; ends an hour later.
    const start = new Date(Date.parse(`${day}T13:00:00Z`) + slot * 3_600_000).toISOString();
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    await run.soft(
      `RN visit ${i + 1} (${day})`,
      async () => {
        const r = await readAsAnyone<
          Array<{ id: string; serviceDate: string; admissionId: string }>
        >("list visits", ctx.sessions, (s) =>
          s.client.GET("/api/v1/visits", { params: { query: { patient: adm.patient.id } } }),
        );
        const items = r ?? [];
        return items.find((v) => v.serviceDate === day && v.admissionId === adm.id) ?? null;
      },
      () =>
        asAnyone<{ id: string; serviceDate: string; admissionId: string }>(
          "schedule visit",
          ctx.sessions,
          (s) =>
            s.client.POST("/api/v1/visits", {
              body: {
                patientId: adm.patient.id,
                admissionId: adm.id,
                patientAddressId: addressId,
                externalFacilityId: null,
                assignedMembershipId: rn.membershipId,
                visitPurpose: "routine_visit",
                visitSetting: "patient_home",
                scheduledStartedAt: start,
                scheduledEndedAt: end,
                schedulerInternalNotes: "DEMO DATA — COP27 seed",
              },
            }),
        ),
      (v) => `visit ${v.id}`,
    );
  }
}

interface MedOrder {
  id: string;
  drugName: string;
  status: string;
  hospiceCoverage: string | null;
}

export interface MedSpec {
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly rxcui: string;
  readonly sig: string;
  readonly sigStructured: Record<string, unknown>;
  readonly indication: string;
  readonly coverage: "covered_related" | "not_covered_unrelated";
  readonly reason: string | null;
}

export const COMFORT_MORPHINE: MedSpec = {
  drugName: "DEMO morphine sulfate oral solution",
  strength: "20 mg/mL",
  doseForm: "solution",
  rxcui: "197696",
  sig: "0.25 mL by mouth every 2 hours as needed for pain or dyspnea",
  sigStructured: {
    doseQuantity: 0.25,
    doseUnit: "mL",
    route: "oral",
    frequencyCode: "Q2H",
    asNeeded: true,
    asNeededReasonCode: "pain",
  },
  indication: "Pain or dyspnea related to the terminal illness",
  coverage: "covered_related",
  reason: null,
};

export const UNRELATED_LISINOPRIL: MedSpec = {
  drugName: "DEMO lisinopril",
  strength: "10 mg",
  doseForm: "tablet",
  rxcui: "314076",
  sig: "1 tablet by mouth daily",
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "QD",
    asNeeded: false,
  },
  indication: "Long-standing hypertension",
  coverage: "not_covered_unrelated",
  reason:
    "DEMO — antihypertensive for long-standing hypertension, unrelated to the terminal diagnosis; the patient " +
    "keeps it under Part D.",
};

export const UNRELATED_ATORVASTATIN: MedSpec = {
  drugName: "DEMO atorvastatin",
  strength: "20 mg",
  doseForm: "tablet",
  rxcui: "617312",
  sig: "1 tablet by mouth at bedtime",
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "QHS",
    asNeeded: false,
  },
  indication: "Hyperlipidemia",
  coverage: "not_covered_unrelated",
  reason:
    "DEMO — statin for primary prevention; no longer related to the plan of care and not covered by hospice.",
};

async function findMed(
  ctx: SeedContext,
  adm: AdmissionHandle,
  drugName: string,
): Promise<MedOrder | null> {
  const r = await readAsAnyone<{ orders: MedOrder[] }>(
    "list medication orders",
    ctx.sessions,
    (s) =>
      s.client.GET("/api/v1/medication-orders", {
        params: { query: { patientId: adm.patient.id } },
      }),
  );
  return r?.orders.find((m) => m.drugName === drugName && m.status !== "discontinued") ?? null;
}

/** A signed (active) medication order with its coverage determination. Prescribing needs the physician. */
export async function ensureMedication(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  med: MedSpec,
): Promise<void> {
  const label = med.drugName.replace(/^DEMO /, "");
  const order = await run.soft(
    `medication ${label} (signed)`,
    async () => {
      const m = await findMed(ctx, adm, med.drugName);
      return m && m.status !== "draft" && m.status !== "pending_signature" ? m : null;
    },
    async () => {
      if (!ctx.physician) throw new SkipStep("prescribing needs the physician account");
      const prescriberMdm = ctx.hospiceMd;
      if (!prescriberMdm) throw new SkipStep("no MDM prescriber");
      const prescriber = ctx.physician;
      const existing = await findMed(ctx, adm, med.drugName);
      const id =
        existing?.id ??
        (
          await asAnyone<{ id: string }>("draft medication order", [prescriber], (s) =>
            s.client.POST("/api/v1/medication-orders", {
              body: {
                patientId: adm.patient.id,
                admissionId: adm.id,
                medClass: "standard",
                rxnormRxcui: med.rxcui,
                ndc: null,
                drugName: med.drugName,
                strength: med.strength,
                doseForm: med.doseForm,
                route: "oral",
                data: {
                  sigStructured: med.sigStructured,
                  sigFreeText: med.sig,
                  indication: med.indication,
                  refillsAuthorized: 0,
                  dispenseQuantity: {
                    value: 30,
                    unit: med.doseForm === "tablet" ? "tablet" : "mL",
                  },
                  daysSupply: 30,
                  daw: false,
                },
                prescriberDiscipline: "hospice_physician",
                prescribingPhysicianMdmId: prescriberMdm.id,
                refillsAuthorized: 0,
              },
            }),
          )
        ).id;
      if (!existing || existing.status === "draft") {
        await asAnyone("request signature", [prescriber], (s) =>
          s.client.POST("/api/v1/medication-orders/{id}/request-signature", {
            params: { path: { id } },
            body: { signerDiscipline: "hospice_physician" },
          }),
        );
      }
      await asAnyone("sign medication order", [prescriber], (s) =>
        s.client.POST("/api/v1/medication-orders/{id}/sign", {
          params: { path: { id } },
          body: { signedAtClient: new Date().toISOString() },
        }),
      );
      const after = await findMed(ctx, adm, med.drugName);
      if (!after) throw new Error("medication order not visible after signing");
      return after;
    },
    (m) => `order ${m.id} (${m.status})`,
  );
  if (!order) return;
  await run.soft(
    `coverage ${label}: ${med.coverage}`,
    async () =>
      (await findMed(ctx, adm, med.drugName))?.hospiceCoverage === med.coverage ? true : null,
    async () => {
      await asAnyone("set medication coverage", ctx.sessions, (s) =>
        s.client.PUT("/api/v1/medication-orders/{id}/coverage-determination", {
          params: { path: { id: order.id } },
          body: { hospiceCoverage: med.coverage, reason: med.reason },
        }),
      );
      return true;
    },
  );
}

interface SupplyRequestView {
  supplyRequestId: string;
  patientId: string;
  kind: string;
  hospiceCoverage: string | null;
  updatedAt: string;
}

const DEMO_SKU_CODE = "DEMO-COP27-COMMODE";

/** The org catalog's DME SKU (class E with HCPCS) when it has one; else a demo tenant-local supply item. */
async function ensureSupplySku(
  run: ScenarioRun,
  ctx: SeedContext,
): Promise<{ id: string; kind: "dme" | "supply"; hcpcs: string | null } | null> {
  const page = await must<{
    data: Array<{
      supplyItemId: string;
      hcpcs: string | null;
      skuClass: string;
      isActive: boolean;
      localSkuCode: string | null;
    }>;
  }>(
    "list supply catalog",
    ctx.admin.client.GET("/api/v1/supplies/supply-items", {
      params: { query: { skuClass: "E", limit: 20 } },
    }),
  );
  const dme = page.data.find((i) => i.isActive && i.hcpcs);
  if (dme) return { id: dme.supplyItemId, kind: "dme", hcpcs: dme.hcpcs };
  return run.soft(
    "demo supply catalog item (no DME SKU in the catalog)",
    async () => {
      const r = await must<{ data: Array<{ supplyItemId: string; localSkuCode: string | null }> }>(
        "search supply catalog",
        ctx.admin.client.GET("/api/v1/supplies/supply-items", {
          params: { query: { q: "DEMO-COP27", limit: 20 } },
        }),
      );
      const hit = r.data.find((i) => i.localSkuCode === DEMO_SKU_CODE);
      return hit ? { id: hit.supplyItemId, kind: "supply" as const, hcpcs: null } : null;
    },
    async () => {
      const r = await must<{ supplyItemId: string }>(
        "create demo catalog item",
        ctx.admin.client.POST("/api/v1/supplies/tenant-supply-items", {
          body: {
            name: "DEMO-COP27 bedside commode (demo catalog item)",
            localSkuCode: DEMO_SKU_CODE,
            defaultUnit: "each",
          },
        }),
      );
      return { id: r.supplyItemId, kind: "supply" as const, hcpcs: null };
    },
    (s) => `sku ${s.id}`,
  );
}

async function findSupplyRequest(
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<SupplyRequestView | null> {
  const r = await readAsAnyone<{ data: SupplyRequestView[] }>(
    "list supply requests",
    ctx.sessions,
    (s) =>
      s.client.GET("/api/v1/supplies/supply-requests", {
        params: { query: { patientId: adm.patient.id } },
      }),
  );
  return (
    r?.data.find(
      (x) => x.patientId === adm.patient.id && (x.kind === "dme" || x.kind === "supply"),
    ) ?? null
  );
}

/** One DME/supply request for the admission, determined NOT covered (unrelated) with a reason. */
export async function ensureNonCoveredSupply(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<void> {
  if (!ctx.location) {
    run.skip("supply request", "no service location");
    return;
  }
  const sku = await ensureSupplySku(run, ctx);
  if (!sku) return;
  const locationId = ctx.location.id;
  const address = ctx.location.address;
  const req = await run.soft(
    `${sku.kind === "dme" ? "DME" : "supply"} request`,
    () => findSupplyRequest(ctx, adm),
    async () => {
      const deliveryAddress = {
        line1: "1 Demo Data Way (fictional)",
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
      };
      const kindPayload =
        sku.kind === "dme"
          ? {
              kind: "dme" as const,
              skuId: sku.id,
              hcpcs: sku.hcpcs,
              hcpcsModifiers: [],
              quantity: 1,
              needsInstallation: false,
              needsPatientEducation: true,
            }
          : { kind: "supply" as const, skuId: sku.id, quantity: 1, unit: "each" };
      await asAnyone("create supply request", ctx.sessions, (s) =>
        s.client.POST("/api/v1/supplies/supply-requests", {
          body: {
            patientId: adm.patient.id,
            admissionId: adm.id,
            locationId,
            deliveryAddress,
            deliveryInstructions: "DEMO DATA — call the caregiver 30 minutes ahead.",
            kindPayload,
          },
        }),
      );
      const created = await findSupplyRequest(ctx, adm);
      if (!created) throw new Error("supply request not visible after create");
      return created;
    },
    (r) => `request ${r.supplyRequestId} (${r.kind})`,
  );
  if (!req) return;
  await run.soft(
    "supply coverage: not_covered_unrelated",
    async () =>
      (await findSupplyRequest(ctx, adm))?.hospiceCoverage === "not_covered_unrelated"
        ? true
        : null,
    async () => {
      const cur = await asAnyone<SupplyRequestView>("read supply request", ctx.sessions, (s) =>
        s.client.GET("/api/v1/supplies/supply-requests/{supplyRequestId}", {
          params: { path: { supplyRequestId: req.supplyRequestId } },
        }),
      );
      await asAnyone("set supply coverage", ctx.sessions, (s) =>
        s.client.PUT("/api/v1/supplies/supply-requests/{supplyRequestId}/coverage-determination", {
          params: { path: { supplyRequestId: req.supplyRequestId } },
          headers: { "If-Match": cur.updatedAt },
          body: {
            hospiceCoverage: "not_covered_unrelated",
            reason:
              "DEMO — requested for a long-standing orthopedic condition unrelated to the terminal diagnosis; " +
              "the family arranges it through the patient's other coverage.",
          },
        }),
      );
      return true;
    },
  );
}

/**
 * The addendum item categories this admission's records should produce: `drug` for a medication order not
 * covered, `item` for a DME/supply request not covered, `condition` for an unrelated care-plan problem.
 */
export async function expectedAddendumCategories(
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<ReadonlySet<string>> {
  const expected = new Set<string>();
  const meds = await readAsAnyone<{ orders: MedOrder[] }>(
    "list medication orders",
    ctx.sessions,
    (s) =>
      s.client.GET("/api/v1/medication-orders", {
        params: { query: { patientId: adm.patient.id } },
      }),
  );
  if (meds?.orders.some((m) => m.hospiceCoverage && m.hospiceCoverage !== "covered_related"))
    expected.add("drug");
  const supply = await findSupplyRequest(ctx, adm);
  if (supply?.hospiceCoverage && supply.hospiceCoverage !== "covered_related") expected.add("item");
  const plan = await readCarePlan(ctx, adm.patient.id);
  if (plan?.problems.some((p) => p.kind === "unrelated")) expected.add("condition");
  return expected;
}
