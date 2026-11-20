// apps/backend/__tests__/discipline-plans-signer-floor.test.ts — M15 §3.5 D11: a tenant may TIGHTEN the required-signer
// quorum a version seals at finalize (add a slot, raise a count) but never loosen it. Without this a caller holding
// `discipline_plan.finalize` could seal `[]` (an unsignable version) or drop the CHHA acknowledgment / the MSW slot and sign
// the rest alone. Pure core: `resolveTightenedSignerSet` and the finalize transition that seals it.
import { requiredSignersFor } from "@chartwarden/discipline-plans";
import type { DisciplineRequiredSignerSet, DisciplineSignerRole } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  resolveRequiredSignerSet,
  resolveTightenedSignerSet,
  transitionDisciplinePlanVersion,
} from "../src/modules/15-discipline-care-plans/lifecycle/index";

const AIDE_FLOOR = requiredSignersFor("aide_poc", "initial");
const rn = { role: "rn_case_manager", count: 1, isAcknowledgment: false } as const;
const chha = { role: "chha_acknowledgment", count: 1, isAcknowledgment: true } as const;
const msw = { role: "msw", count: 1, isAcknowledgment: false } as const;

const refused = (floor: DisciplineRequiredSignerSet, requested: DisciplineRequiredSignerSet) =>
  expect(() => resolveTightenedSignerSet(floor, requested)).toThrowError(
    expect.objectContaining({ code: "INSUFFICIENT_SIGNERS" }),
  );

describe("resolveTightenedSignerSet", () => {
  it("accepts the floor itself and an added known slot", () => {
    expect(resolveTightenedSignerSet(AIDE_FLOOR, [rn, chha])).toEqual([rn, chha]);
    expect(resolveTightenedSignerSet(AIDE_FLOOR, [rn, chha, msw])).toHaveLength(3);
  });

  it("refuses an empty set and a set missing a floor slot", () => {
    refused(AIDE_FLOOR, []);
    refused(AIDE_FLOOR, [rn]);
    refused(AIDE_FLOOR, [chha]);
  });

  it("refuses a slot whose acknowledgment flag differs from the floor's", () => {
    refused(AIDE_FLOOR, [rn, { ...chha, isAcknowledgment: false }]);
    refused(AIDE_FLOOR, [{ ...rn, isAcknowledgment: true }, chha]);
  });

  it("refuses a count below the floor, a repeated role and an unknown role", () => {
    refused(AIDE_FLOOR, [{ ...rn, count: 0 }, chha]);
    refused(AIDE_FLOOR, [rn, rn, chha]);
    refused(AIDE_FLOOR, [
      rn,
      chha,
      { role: "janitor" as unknown as DisciplineSignerRole, count: 1, isAcknowledgment: false },
    ]);
  });

  it("refuses a count above one: a signer role fills one slot per version (unique index), so it could never be met", () => {
    refused(AIDE_FLOOR, [{ ...rn, count: 2 }, chha]);
    refused(AIDE_FLOOR, [rn, chha, { ...msw, count: 3 }]);
  });

  it("lets any known set stand over an empty floor (the system-signed discharge version)", () => {
    expect(resolveTightenedSignerSet([], [])).toEqual([]);
  });
});

describe("the finalize transition seals only a quorum at or above the floor", () => {
  const finalize = (
    planKind: "aide_poc" | "msw_plan",
    requiredSignerSet?: DisciplineRequiredSignerSet,
  ) =>
    transitionDisciplinePlanVersion("draft", {
      type: "finalize",
      planKind,
      versionKind: "initial",
      at: "2026-01-01T00:00:00.000Z",
      readiness: {
        hasAideAssigned: true,
        hasSupervisingRn: true,
        hasActiveVolunteerAssignment: false,
        volunteerOutOfScopeAcknowledged: [],
      },
      requiredSignerSet,
    } as never);

  it("seals the floor when no set is sent, and a tightened set when one is", () => {
    const snapshotOf = (t: ReturnType<typeof finalize>) =>
      t.effects.find((e) => e.kind === "snapshot") as { requiredSignerSet: unknown } | undefined;
    expect(snapshotOf(finalize("aide_poc"))?.requiredSignerSet).toEqual(
      resolveRequiredSignerSet("aide_poc", "initial"),
    );
    expect(snapshotOf(finalize("aide_poc", [rn, chha, msw]))?.requiredSignerSet).toHaveLength(3);
  });

  it("refuses an Aide POC set without the CHHA acknowledgment and an MSW plan set without the MSW slot", () => {
    expect(() => finalize("aide_poc", [rn])).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_SIGNERS" }),
    );
    expect(() => finalize("aide_poc", [])).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_SIGNERS" }),
    );
    expect(() => finalize("msw_plan", [rn])).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_SIGNERS" }),
    );
  });
});
