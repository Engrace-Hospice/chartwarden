import { noeTimeliness5d, type repositories } from "@chartwarden/billing";
// apps/backend/src/modules/23-billing-medicare/__tests__/claim-validation-context-port.test.ts — the production
// ValidationContextPort reads the admission's EFFECTIVE NOE. Before the fix it used
// `NoeRepository.findActiveByAdmission`, which excludes `ack_accepted` (that read means "still in flight"), so a
// claim whose NOE Medicare had ACCEPTED validated as "No Notice of Election".
//
// PARTIAL-mocks `@chartwarden/billing`'s data ports (the claim lines, the patient's claims, the NOE rows) with an
// in-memory NOE table that mirrors both repository reads' documented state filters; every pure derivation
// (facts, HIPPS, the rule) stays real. The SQL itself is proven live (`test:m23:noe-draft:live`).
import { describe, expect, it, vi } from "vitest";
import { buildClaimValidationContextPort } from "../services/claim-validation-context-port";
import { fixedValidationSeams } from "./_validation-seams-fixture";

interface FakeNoe {
  readonly id: string;
  readonly admissionId: string;
  readonly state: string;
  readonly createdAt: Date;
  readonly windowBreachedAt: Date | null;
  readonly electionEffectiveDate: string;
  readonly acceptedAt: Date | null;
  readonly payerStatusDate: string | null;
  readonly payerStatusDateSource: string | null;
  readonly correctsNoticeId?: string | null;
}
const NOES: FakeNoe[] = [];

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/billing")>();
  const latest = (rows: FakeNoe[]) =>
    [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  class NoeRepository {
    async findActiveByAdmission(admissionId: string) {
      return latest(
        NOES.filter(
          (n) =>
            n.admissionId === admissionId &&
            !["ack_accepted", "cancelled", "ack_rejected"].includes(n.state),
        ),
      );
    }
    async findById(id: string) {
      return NOES.find((n) => n.id === id) ?? null;
    }
    async findEffectiveByAdmission(admissionId: string) {
      return latest(
        NOES.filter(
          (n) => n.admissionId === admissionId && !["cancelled", "ack_rejected"].includes(n.state),
        ),
      );
    }
  }
  class ClaimLineRepository {
    async listForClaim() {
      return [];
    }
  }
  class ClaimRepository {
    async listByOrgPage() {
      return { items: [], nextCursor: null };
    }
  }
  class EligibilityCheckRepository {
    async findLatestResolvedForPatient() {
      return null;
    }
  }
  return {
    ...actual,
    repositories: {
      ...actual.repositories,
      NoeRepository,
      ClaimLineRepository,
      ClaimRepository,
      EligibilityCheckRepository,
    },
  };
});

const ADMISSION = "adm-1";

const CLAIM = {
  id: "claim-1",
  providerEntityId: "pe-1",
  patientId: "pat-1",
  admissionId: ADMISSION,
  tob: "812",
  serviceFrom: "2025-11-01",
  serviceTo: "2025-11-15",
  replacesClaimId: null,
  totalChargeCents: 0,
} as unknown as repositories.ClaimRecord;

async function noeRuleFor(rows: FakeNoe[]) {
  NOES.splice(0, NOES.length, ...rows);
  const port = buildClaimValidationContextPort({
    seams: fixedValidationSeams(
      { admissionId: ADMISSION, hospiceAdmissionDate: "2025-11-01" },
      new Date("2025-11-20T00:00:00.000Z"),
    ),
    eligibilityBound: false,
    now: () => new Date("2025-11-20T00:00:00.000Z"),
  });
  const { context } = await port.build(
    {} as never,
    { organizationId: "org-1", userId: "u", membershipId: "m", actorKind: "user" } as never,
    CLAIM,
  );
  return {
    context,
    result: noeTimeliness5d.check(context, noeTimeliness5d.defaultParameters ?? {}),
  };
}

const noe = (
  state: string,
  createdAt: string,
  id = state,
  ack: Partial<
    Pick<
      FakeNoe,
      | "acceptedAt"
      | "payerStatusDate"
      | "payerStatusDateSource"
      | "correctsNoticeId"
      | "electionEffectiveDate"
    >
  > = {},
): FakeNoe => ({
  id,
  admissionId: ADMISSION,
  state,
  createdAt: new Date(createdAt),
  windowBreachedAt: null,
  electionEffectiveDate: "2025-11-01",
  acceptedAt: state === "ack_accepted" ? new Date("2025-11-03T15:00:00Z") : null,
  payerStatusDate: state === "ack_accepted" ? "2025-11-03" : null,
  payerStatusDateSource: state === "ack_accepted" ? "277ca_stc02" : null,
  ...ack,
});

describe("ValidationContextPort — the admission's effective NOE", () => {
  it("an ACCEPTED NOE is the NOE (it validated as 'No Notice of Election' before)", async () => {
    const { context, result } = await noeRuleFor([noe("ack_accepted", "2025-11-02T00:00:00Z")]);
    expect(context.noe?.state).toBe("ack_accepted");
    expect(result.passed).toBe(true);
  });

  it("a rejected then re-filed and accepted NOE reads the accepted one", async () => {
    const { context } = await noeRuleFor([
      noe("ack_rejected", "2025-11-02T00:00:00Z"),
      noe("ack_accepted", "2025-11-03T00:00:00Z"),
    ]);
    expect(context.noe?.state).toBe("ack_accepted");
  });

  it("an in-flight NOE is still read (submitted, past the window → block)", async () => {
    const { context, result } = await noeRuleFor([noe("submitted", "2025-11-02T00:00:00Z")]);
    expect(context.noe?.state).toBe("submitted");
    expect(result.passed).toBe(false);
  });

  it("only cancelled / rejected NOEs → no NOE", async () => {
    const { context, result } = await noeRuleFor([
      noe("cancelled", "2025-11-02T00:00:00Z"),
      noe("ack_rejected", "2025-11-03T00:00:00Z"),
    ]);
    expect(context.noe).toBeNull();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/No Notice of Election/);
  });

  it("a corrected NOE accepted late is judged on Medicare's date, from the original admission (OSC 77)", async () => {
    const { context, result } = await noeRuleFor([
      noe("ack_rejected", "2025-11-02T00:00:00Z", "rejected"),
      noe("ack_accepted", "2025-11-09T00:00:00Z", "corrected", {
        acceptedAt: new Date("2025-11-10T02:00:00Z"),
        payerStatusDate: "2025-11-09",
        payerStatusDateSource: "277ca_stc02",
        correctsNoticeId: "rejected",
      }),
    ]);
    expect(context.noe).toMatchObject({
      state: "ack_accepted",
      electionEffectiveDate: "2025-11-01",
      acceptedDate: "2025-11-09",
      acceptedDateSource: "277ca_stc02",
    });
    expect(result.passed).toBe(false);
    expect(result.severity).toBe("info");
    expect(result.annotations?.observed).toMatchObject({
      daysLate: 3,
      occurrenceSpanFrom: "2025-11-01",
      occurrenceSpanThrough: "2025-11-08",
    });
  });

  it("falls back to the day we received the acceptance when no payer date is recorded", async () => {
    const { context } = await noeRuleFor([
      noe("ack_accepted", "2025-11-02T00:00:00Z", "legacy", {
        acceptedAt: new Date("2025-11-04T12:00:00Z"),
        payerStatusDate: null,
        payerStatusDateSource: null,
      }),
    ]);
    expect(context.noe).toMatchObject({
      acceptedDate: "2025-11-04",
      acceptedDateSource: "receipt",
    });
  });

  it("a correction cannot move the clock later: an edited admission date still counts from the original", async () => {
    const { context, result } = await noeRuleFor([
      noe("ack_rejected", "2025-11-02T00:00:00Z", "rejected"),
      noe("ack_accepted", "2025-11-09T00:00:00Z", "corrected", {
        electionEffectiveDate: "2025-11-05",
        payerStatusDate: "2025-11-09",
        correctsNoticeId: "rejected",
      }),
    ]);
    expect(context.noe?.electionEffectiveDate).toBe("2025-11-01");
    expect(result.severity).toBe("info"); // still late (due 11-06)
  });
});
