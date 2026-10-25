import { ConflictError, NotFoundError, ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createCommercialAdminService } from "./admin-service";
import type { EligibilityStore, StoredEnrollment } from "./store";

const SCOPE = { organizationId: "org-1", userId: "user-1" };
const PE = "00000000-0000-4000-8000-0000000000e1";
const PAYER = "00000000-0000-4000-8000-0000000000c1";

const stored = (over: Partial<StoredEnrollment> = {}): StoredEnrollment => ({
  id: "enr-1",
  organizationId: "org-1",
  providerEntityId: PE,
  payerId: PAYER,
  clearinghouseKey: "stedi",
  status: "enrolled",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceRef: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...over,
});

function storeWith(over: Partial<EligibilityStore>): EligibilityStore {
  return over as EligibilityStore;
}

const NEW = {
  providerEntityId: PE,
  payerId: PAYER,
  clearinghouseKey: "stedi",
  status: "enrolled" as const,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceRef: null,
};

describe("commercial admin service", () => {
  it("creates an enrollment", async () => {
    const svc = createCommercialAdminService(storeWith({ createEnrollment: async () => stored() }));
    await expect(svc.createEnrollment(SCOPE, NEW)).resolves.toMatchObject({ id: "enr-1" });
  });

  it("maps an overlapping-period database error (23P01) to a 409 ConflictError", async () => {
    const svc = createCommercialAdminService(
      storeWith({
        createEnrollment: async () => {
          throw Object.assign(new Error("conflicting key value violates exclusion constraint"), {
            code: "23P01",
          });
        },
      }),
    );
    await expect(svc.createEnrollment(SCOPE, NEW)).rejects.toBeInstanceOf(ConflictError);
  });

  it("finds the Postgres code on a wrapped cause (drizzle wraps driver errors)", async () => {
    const svc = createCommercialAdminService(
      storeWith({
        createEnrollment: async () => {
          throw new Error("query failed", {
            cause: Object.assign(new Error("x"), { code: "23P01" }),
          });
        },
      }),
    );
    await expect(svc.createEnrollment(SCOPE, NEW)).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps the non-commercial-payer trigger to a 422 ValidationError", async () => {
    const svc = createCommercialAdminService(
      storeWith({
        createEnrollment: async () => {
          throw new Error(
            "M41_PLAN_PAYER_NOT_COMMERCIAL: payer x is not an active commercial or other-program payer",
          );
        },
      }),
    );
    await expect(svc.createEnrollment(SCOPE, NEW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps a CHECK violation (23514) to a 422 ValidationError, not a 500", async () => {
    const svc = createCommercialAdminService(
      storeWith({
        patchEnrollment: async () => {
          throw Object.assign(new Error("violates check constraint"), { code: "23514" });
        },
      }),
    );
    await expect(
      svc.patchEnrollment(SCOPE, PE, "enr-1", { effectiveTo: "2020-01-01" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rethrows an error it does not recognise", async () => {
    const boom = new Error("disk on fire");
    const svc = createCommercialAdminService(
      storeWith({
        createEnrollment: async () => {
          throw boom;
        },
      }),
    );
    await expect(svc.createEnrollment(SCOPE, NEW)).rejects.toBe(boom);
  });

  it("rejects an end date before the start date", async () => {
    const svc = createCommercialAdminService(storeWith({}));
    await expect(
      svc.createEnrollment(SCOPE, { ...NEW, effectiveTo: "2025-12-31" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("patching an enrollment of another provider entity (or tenant) is a 404", async () => {
    const svc = createCommercialAdminService(storeWith({ patchEnrollment: async () => null }));
    await expect(
      svc.patchEnrollment(SCOPE, PE, "enr-1", { status: "suspended" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an empty patch is a 422, not a no-op write", async () => {
    const svc = createCommercialAdminService(storeWith({}));
    await expect(svc.patchEnrollment(SCOPE, PE, "enr-1", {})).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("sets a plan's eligibility policy, 404 for an unknown plan", async () => {
    const plan = {
      id: "p",
      payerId: PAYER,
      eligibilityStalenessPolicy: "block" as const,
      eligibilityMaxAgeDays: 14,
    };
    const ok = createCommercialAdminService(
      storeWith({ setPlanEligibilityPolicy: async () => plan }),
    );
    await expect(ok.setEligibilityPolicy(SCOPE, "p", "block", 14)).resolves.toEqual(plan);
    const missing = createCommercialAdminService(
      storeWith({ setPlanEligibilityPolicy: async () => null }),
    );
    await expect(missing.setEligibilityPolicy(SCOPE, "p", "warn", 30)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects a max age outside 1..365", async () => {
    const svc = createCommercialAdminService(storeWith({}));
    for (const days of [0, 366, 1.5]) {
      await expect(svc.setEligibilityPolicy(SCOPE, "p", "warn", days)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});
