// apps/backend/__tests__/orders-service-actor-guards.test.ts — GAP-031 / GAP-030 hardening (M11).
//
// The route layer refuses a discipline the session does not hold (422 DISCIPLINE_NOT_HELD) and an off-caseload
// patient (404). Those checks must ALSO hold at the SERVICE, so a worker / seam consumer / future route that
// calls the service directly cannot bypass them. This suite calls the in-memory service with no HTTP in front.
// A non-human caller names itself with SYSTEM_ORDER_ACTOR (the one explicit, narrow bypass).
import { describe, expect, it } from "vitest";
import {
  type OrderDetailActor,
  SYSTEM_ORDER_ACTOR,
  createInMemoryOrderBackend,
} from "../src/modules/11-orders/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-06-08T12:00:00.000Z";
const ATTEST =
  "Telephone order received from Dr. Patel for a comfort kit; patient has uncontrolled pain at the bedside, read back and verified.";

const CASELOAD: Record<string, readonly string[]> = { user_rn: [PATIENT], user_other: [] };

function backend() {
  return createInMemoryOrderBackend({
    now: () => NOW,
    timeZone: "America/New_York",
    caseloadPatientIds: async ({ userId }) => CASELOAD[userId] ?? [],
  });
}

const actor = (over: Partial<OrderDetailActor> = {}): OrderDetailActor => ({
  membershipId: "m_rn",
  userId: "user_rn",
  roles: ["rn_case_manager"],
  disciplines: ["rn_case_manager"],
  permissions: new Set<string>(),
  ...over,
});

const draftArgs = (over: Record<string, unknown> = {}) => ({
  patientId: PATIENT,
  admissionId: ADMISSION,
  kind: "comfort_kit" as const,
  drafterDiscipline: "rn_case_manager",
  data: { kitSku: "comfort-kit-standard", deploymentSite: "home" },
  orderingPhysicianMdmId: PHYS,
  ...over,
});
const verbalArgs = (over: Record<string, unknown> = {}) => ({
  recorderDiscipline: "rn_case_manager",
  verbalAttestation: ATTEST,
  readBackVerified: true,
  effectiveAt: NOW,
  receivedAt: NOW,
  orderingPhysicianMdmId: PHYS,
  ...over,
});

const DISCIPLINE_REFUSED = expect.objectContaining({ code: "DISCIPLINE_NOT_HELD" });

async function seededDraft(svc: ReturnType<typeof backend>) {
  return svc.createDraft(ORG, "m_rn", draftArgs(), SYSTEM_ORDER_ACTOR);
}

describe("service-level claimed-discipline check (actor.disciplines)", () => {
  it("refuses createDraft naming a discipline the actor does not hold", async () => {
    const svc = backend();
    await expect(
      svc.createDraft(ORG, "m_rn", draftArgs({ drafterDiscipline: "hospice_physician" }), actor()),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
  });

  it("refuses createDraft from the empty default actor (no disciplines)", async () => {
    const svc = backend();
    await expect(svc.createDraft(ORG, "m_rn", draftArgs())).rejects.toEqual(DISCIPLINE_REFUSED);
  });

  it("refuses createVerbalOrder naming a discipline the actor does not hold", async () => {
    const svc = backend();
    await expect(
      svc.createVerbalOrder(
        ORG,
        "m_rn",
        {
          order: draftArgs({ drafterDiscipline: "hospice_physician" }),
          verbal: verbalArgs(),
        },
        actor(),
      ),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
  });

  it("refuses requestSignature, sign, sign-on-behalf, recordVerbal and correct with an unheld discipline", async () => {
    const svc = backend();
    const draft = await seededDraft(svc);
    const rn = actor();
    await expect(
      svc.requestSignature(ORG, draft.id, { signerDiscipline: "medical_director" }, rn),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
    await expect(
      svc.signOrder(
        ORG,
        "m_rn",
        draft.id,
        { signerDiscipline: "hospice_physician", signedAtClient: NOW },
        rn,
      ),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
    await expect(
      svc.signOnBehalf(
        ORG,
        "m_rn",
        draft.id,
        {
          signerDiscipline: "medical_director",
          signedAtClient: NOW,
          onBehalfOf: PHYS,
          reason: "physician unavailable",
        },
        rn,
      ),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
    await expect(
      svc.recordVerbal(ORG, "m_rn", draft.id, verbalArgs({ recorderDiscipline: "np" }), rn),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
    await expect(
      svc.correctOrder(
        ORG,
        "m_rn",
        draft.id,
        draftArgs({ drafterDiscipline: "hospice_physician" }),
        rn,
      ),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
  });

  it("matches the held discipline case- and whitespace-insensitively", async () => {
    const svc = backend();
    const res = await svc.createDraft(
      ORG,
      "m_rn",
      draftArgs({ drafterDiscipline: " RN_Case_Manager " }),
      actor(),
    );
    expect(res.status).toBe("draft");
  });
});

describe("service-level caseload re-check", () => {
  it("refuses a write on an off-caseload patient with a not-found", async () => {
    const svc = backend();
    const draft = await seededDraft(svc);
    const stranger = actor({ userId: "user_other" });
    const notFound = expect.objectContaining({ statusCode: 404 });
    await expect(svc.createDraft(ORG, "m_x", draftArgs(), stranger)).rejects.toEqual(notFound);
    await expect(
      svc.createVerbalOrder(ORG, "m_x", { order: draftArgs(), verbal: verbalArgs() }, stranger),
    ).rejects.toEqual(notFound);
    await expect(svc.editDraft(ORG, draft.id, {}, undefined, stranger)).rejects.toEqual(notFound);
    await expect(
      svc.requestSignature(ORG, draft.id, { signerDiscipline: "rn_case_manager" }, stranger),
    ).rejects.toEqual(notFound);
    await expect(svc.recordVerbal(ORG, "m_x", draft.id, verbalArgs(), stranger)).rejects.toEqual(
      notFound,
    );
    await expect(
      svc.discontinueOrder(
        ORG,
        "m_x",
        draft.id,
        { reason: "clinical_judgement", effectiveAt: NOW },
        stranger,
      ),
    ).rejects.toEqual(notFound);
    await expect(svc.correctOrder(ORG, "m_x", draft.id, draftArgs(), stranger)).rejects.toEqual(
      notFound,
    );
  });

  it("refuses a corrected order that moves the chart to an off-caseload patient", async () => {
    const svc = backend();
    const draft = await seededDraft(svc);
    await expect(
      svc.correctOrder(ORG, "m_rn", draft.id, draftArgs({ patientId: OTHER_PATIENT }), actor()),
    ).rejects.toEqual(expect.objectContaining({ statusCode: 404 }));
  });

  it("fails closed when the caseload cannot be resolved", async () => {
    const svc = createInMemoryOrderBackend({
      now: () => NOW,
      caseloadPatientIds: async () => {
        throw new Error("seam down");
      },
    });
    await expect(svc.createDraft(ORG, "m_rn", draftArgs(), actor())).rejects.toEqual(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("allows an on-caseload actor, an org-wide actor, and a session pinned to the patient", async () => {
    const svc = backend();
    expect((await svc.createDraft(ORG, "m_rn", draftArgs(), actor())).status).toBe("draft");
    const orgWide = actor({ userId: "user_other", orgWide: true });
    expect((await svc.createDraft(ORG, "m_ow", draftArgs(), orgWide)).status).toBe("draft");
    const pinned = actor({ userId: "user_other", sessionPatientId: PATIENT });
    expect((await svc.createDraft(ORG, "m_p", draftArgs(), pinned)).status).toBe("draft");
  });
});

describe("SYSTEM_ORDER_ACTOR (workers / consumers / service-level suites)", () => {
  it("is exempt from both the discipline claim and the caseload check", async () => {
    const svc = backend();
    const draft = await svc.createDraft(
      ORG,
      "m_sys",
      draftArgs({ patientId: OTHER_PATIENT, drafterDiscipline: "hospice_physician" }),
      SYSTEM_ORDER_ACTOR,
    );
    expect(draft.status).toBe("draft");
  });

  it("cannot be forged by a plain actor that merely lacks the marker", async () => {
    const svc = backend();
    const forged = { ...actor({ userId: "user_other" }), kind: "user" as const };
    await expect(
      svc.createDraft(ORG, "m_x", draftArgs({ drafterDiscipline: "hospice_physician" }), forged),
    ).rejects.toEqual(DISCIPLINE_REFUSED);
  });

  it("is frozen so a caller cannot mutate the shared marker", () => {
    expect(Object.isFrozen(SYSTEM_ORDER_ACTOR)).toBe(true);
    expect(SYSTEM_ORDER_ACTOR.kind).toBe("system");
  });
});
