import * as billing from "@chartwarden/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDrizzleM23ReadService } from "../routes/read-service-drizzle";
import type { FakeStore } from "./_billing-repo-fakes";
import { makeFakeDb } from "./_billing-repo-fakes";

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/billing")>();
  const { buildFakeRepositories } = await import("./_billing-repo-fakes");
  const { repos, store } = buildFakeRepositories();
  return { ...actual, repositories: { ...actual.repositories, ...repos, __store: store } };
});
const store = (billing.repositories as unknown as { __store: FakeStore }).__store;

const ACTOR = { organizationId: "org-1", userId: "u-1", roles: [], providerEntityIds: [] };
const seedClaim = (id: string) =>
  store.claims.set(id, {
    id,
    organizationId: "org-1",
    providerEntityId: "pe-1",
    patientId: "pat-1",
    admissionId: `adm-${id}`,
    tob: "812",
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
const seedRun = (id: string, claimId: string, outcome: string, completedAt: string) =>
  store.runs.set(id, { id, claimId, outcome, completedAt: new Date(completedAt) });

describe("claim list - latestValidationSummary", () => {
  beforeEach(() => {
    store.reset();
    seedClaim("c-pass");
    seedClaim("c-fail");
    seedClaim("c-never");
    seedRun("r1", "c-fail", "pass", "2026-04-01T00:00:00.000Z");
    seedRun("r2", "c-fail", "fail", "2026-04-02T00:00:00.000Z");
    seedRun("r3", "c-pass", "pass", "2026-04-03T00:00:00.000Z");
  });

  it("attaches the newest run's outcome and time, and null for never-validated claims", async () => {
    const svc = buildDrizzleM23ReadService(makeFakeDb() as never);
    const page = await svc.listClaims(ACTOR as never, {}, undefined, 50);
    const byId = new Map(page.items.map((c) => [c.claimId, c.latestValidationSummary]));
    expect(byId.get("c-fail")).toEqual({ outcome: "fail", runAt: "2026-04-02T00:00:00.000Z" });
    expect(byId.get("c-pass")).toEqual({ outcome: "pass", runAt: "2026-04-03T00:00:00.000Z" });
    expect(byId.get("c-never")).toBeNull();
  });

  it("reads the latest runs with ONE batched repository call per page", async () => {
    const spy = vi.spyOn(
      billing.repositories.ValidationRunRepository.prototype,
      "findLatestForClaims",
    );
    const svc = buildDrizzleM23ReadService(makeFakeDb() as never);
    await svc.listClaims(ACTOR as never, {}, undefined, 50);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
