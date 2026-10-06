import * as billing from "@wardenx/billing";
// apps/backend/src/modules/23-billing-medicare/__tests__/claim-attention.test.ts — the "needs attention" facts a
// claim carries because of how its stay ended (services/claim-attention.ts), the TOB re-derivation they use
// (claim-discharge.ts `rederivedTypeOfBill`), and the Drizzle read service's `attention` decoration + list
// filter over the in-memory repositories (the M6 stay-end facts arrive through the injected port).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDrizzleM23ReadService } from "../routes/read-service-drizzle";
import { type ClaimStayEndFactsRow, claimAttention } from "../services/claim-attention";
import { rederivedTypeOfBill } from "../services/claim-discharge";
import type { FakeStore } from "./_billing-repo-fakes";
import { makeFakeDb } from "./_billing-repo-fakes";

vi.mock("@wardenx/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wardenx/billing")>();
  const { buildFakeRepositories } = await import("./_billing-repo-fakes");
  const { repos, store } = buildFakeRepositories();
  return { ...actual, repositories: { ...actual.repositories, ...repos, __store: store } };
});
const store = (billing.repositories as unknown as { __store: FakeStore }).__store;

const facts = (over: Partial<ClaimStayEndFactsRow> = {}): ClaimStayEndFactsRow => ({
  admissionId: "adm-1",
  dischargeDate: null,
  dischargeReason: null,
  dischargeEventId: null,
  deceasedDate: null,
  placeOfDeath: null,
  transferOut: null,
  revocationDate: null,
  ...over,
});
const claim = (over: Partial<{ tob: string; state: string; serviceTo: string }> = {}) => ({
  claimId: "claim-1",
  admissionId: "adm-1",
  tob: "812",
  state: "ready",
  serviceTo: "2026-03-31",
  ...over,
});

describe("rederivedTypeOfBill", () => {
  const ended = (effectiveDate: string) => ({ kind: "revocation", effectiveDate });
  it("reads the prior-claim half from the stored TOB and re-derives the discharged half", () => {
    expect(rederivedTypeOfBill("812", ended("2026-03-20"), "2026-03-31")).toBe("811");
    expect(rederivedTypeOfBill("813", ended("2026-03-31"), "2026-03-31")).toBe("814");
    expect(rederivedTypeOfBill("813", ended("2026-04-01"), "2026-03-31")).toBe("813");
    expect(rederivedTypeOfBill("811", null, "2026-03-31")).toBe("812");
  });
  it("leaves replacements and voids alone", () => {
    expect(rederivedTypeOfBill("817", ended("2026-03-20"), "2026-03-31")).toBeNull();
    expect(rederivedTypeOfBill("818", null, "2026-03-31")).toBeNull();
  });
});

describe("claimAttention", () => {
  it("flags an interim claim whose stay ended by revocation (812 → 811) with the state's remedy", () => {
    const f = facts({ revocationDate: "2026-03-20" });
    expect(claimAttention(claim(), f)).toMatchObject({
      stayEnd: { kind: "revocation", effectiveDate: "2026-03-20" },
      typeOfBill: { stored: "812", derived: "811", changed: true, remedy: "revalidate" },
      missingDischargeDetail: null,
      flags: ["tob_changed"],
    });
    expect(claimAttention(claim({ state: "submitted" }), f).typeOfBill.remedy).toBe(
      "await_acknowledgment",
    );
    expect(claimAttention(claim({ state: "paid" }), f).typeOfBill.remedy).toBe("replace");
    expect(claimAttention(claim({ state: "denied" }), f).typeOfBill.remedy).toBe("manual");
  });

  it("flags a death with no place of death, addressing the discharge record", () => {
    const view = claimAttention(
      claim({ tob: "814" }),
      facts({
        dischargeDate: "2026-03-10",
        dischargeReason: "death",
        dischargeEventId: "de-1",
        deceasedDate: "2026-03-10",
      }),
    );
    expect(view.flags).toEqual(["missing_discharge_details"]);
    expect(view.missingDischargeDetail).toEqual({
      detail: "place_of_death",
      admissionId: "adm-1",
      dischargeEventId: "de-1",
      transferEventId: null,
      fixPath: "/admissions/adm-1/discharge-details?claimId=claim-1",
    });
  });

  it("flags a transfer-out with no receiving care setting (and its TOB change)", () => {
    const view = claimAttention(
      claim({ tob: "813", state: "ack_accepted" }),
      facts({
        transferOut: {
          transferEventId: "te-1",
          effectiveDate: "2026-03-15",
          receivingCareSetting: null,
        },
      }),
    );
    expect(view.flags).toEqual(["missing_discharge_details", "tob_changed"]);
    expect(view.missingDischargeDetail?.transferEventId).toBe("te-1");
    expect(view.typeOfBill).toMatchObject({ derived: "814", remedy: "replace" });
  });

  it("is quiet for a still-open stay, a superseded claim, or unknown facts", () => {
    expect(claimAttention(claim(), facts()).flags).toEqual([]);
    expect(
      claimAttention(claim({ state: "replaced" }), facts({ revocationDate: "2026-03-01" })).flags,
    ).toEqual([]);
    expect(claimAttention(claim(), undefined).flags).toEqual([]);
  });
});

describe("read service — attention decoration and filter", () => {
  const ACTOR = { organizationId: "org-1", userId: "u-1", roles: [], providerEntityIds: [] };
  const seed = (id: string, admissionId: string, tob: string) =>
    store.claims.set(id, {
      id,
      organizationId: "org-1",
      providerEntityId: "pe-1",
      patientId: "pat-1",
      admissionId,
      tob,
      state: "ready",
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
      claimControlNumber: id,
      payerClaimControlNumber: null,
      macJurisdiction: "ngs_j6",
      totalChargeCents: 0,
      totalExpectedPaymentCents: 0,
      version: 0,
    });
  const port = {
    forAdmissions: vi.fn(async (_org: string, ids: readonly string[]) =>
      ids.map((admissionId) =>
        admissionId === "adm-revoked"
          ? facts({ admissionId, revocationDate: "2026-03-20" })
          : admissionId === "adm-death"
            ? facts({
                admissionId,
                dischargeDate: "2026-03-10",
                dischargeReason: "death",
                dischargeEventId: "de-1",
              })
            : facts({ admissionId }),
      ),
    ),
  };

  beforeEach(() => {
    store.reset();
    port.forAdmissions.mockClear();
    seed("c-open", "adm-open", "812");
    seed("c-revoked", "adm-revoked", "812");
    seed("c-death", "adm-death", "814");
  });

  it("decorates every list item from ONE batched M6 read", async () => {
    const svc = buildDrizzleM23ReadService(makeFakeDb() as never, { stayEndFacts: port });
    const page = await svc.listClaims(ACTOR as never, {}, undefined, 50);
    expect(port.forAdmissions).toHaveBeenCalledTimes(1);
    const byId = new Map(page.items.map((c) => [c.claimId, c.attention?.flags]));
    expect(byId.get("c-open")).toEqual([]);
    expect(byId.get("c-revoked")).toEqual(["tob_changed"]);
    expect(byId.get("c-death")).toEqual(["missing_discharge_details"]);
  });

  it("filters to one attention flag", async () => {
    const svc = buildDrizzleM23ReadService(makeFakeDb() as never, { stayEndFacts: port });
    const missing = await svc.listClaims(
      ACTOR as never,
      { attention: "missing_discharge_details" },
      undefined,
      50,
    );
    expect(missing.items.map((c) => c.claimId)).toEqual(["c-death"]);
    const tob = await svc.listClaims(ACTOR as never, { attention: "tob_changed" }, undefined, 50);
    expect(tob.items.map((c) => c.claimId)).toEqual(["c-revoked"]);
    expect(tob.nextCursor).toBeNull();
  });

  it("without the port: no attention block, and an attention filter matches nothing", async () => {
    const svc = buildDrizzleM23ReadService(makeFakeDb() as never);
    const page = await svc.listClaims(ACTOR as never, {}, undefined, 50);
    expect(page.items.every((c) => c.attention === undefined)).toBe(true);
    const filtered = await svc.listClaims(
      ACTOR as never,
      { attention: "tob_changed" },
      undefined,
      50,
    );
    expect(filtered.items).toEqual([]);
  });
});
