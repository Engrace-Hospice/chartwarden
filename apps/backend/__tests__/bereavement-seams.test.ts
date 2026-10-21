// apps/backend/__tests__/bereavement-seams.test.ts — M16-T05 (§4.6 / D13 the seams M16 PUBLISHES).
//
// Seven surfaces registered into the M1 registry by `registerBereavementSeams`. The properties guarded here
// are the ones the providers exist to preserve:
//   • the D4 13-month window is derived ONCE — `windowEndsAt`, `isInBereavementWindow` and the portal
//     capabilities all move together, and a CLOSED plan is outside its window even mid-13-months;
//   • `isInBereavementWindow` is read as an AUTHORIZATION fact and therefore fails CLOSED (absent plan or
//     unreadable store → `false`), while every reporting read PROPAGATES an outage rather than answering
//     "no rows";
//   • the CoP 418.64(d) measure has ONE definition behind two seams — M30 and M33 can never be shown two
//     different bereavement-compliance numbers for the same scope;
//   • counts, never rates: a 0/0 scope stays 0/0 so CMS small-N suppression downstream still works;
//   • the Layer-2 write-back APPENDS and cannot move `rule_tier`, whatever tier the narrative claims.
import {
  BEREAVEMENT_WINDOW_DAYS,
  OPT_OUT_SELF_SERVICE_RESCIND_WINDOW_DAYS,
  weightedScoreToRuleScore,
} from "@chartwarden/bereavement";
import type {
  BereavedContactView,
  BereavementAugmentationResult,
  BereavementOutreachView,
  BereavementRiskFactorInputs,
} from "@chartwarden/types";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_SEAMS, __resetSeamsForTest, validateSeams } from "../src/bootstrap/index";
import {
  type BereavementPlanFacts,
  type BereavementRiskScoreFacts,
  type BereavementSeamStore,
  createBereavedPortalScopeProvider,
  createBereavementAssignmentReader,
  createBereavementComplianceProvider,
  createBereavementOutreachProvider,
  createBereavementPlanProvider,
  createBereavementRiskFactorsProvider,
  createBereavementRiskTierProvider,
  createInMemoryBereavementSeamStore,
  getBereavedPortalScopeProvider,
  getBereavementAssignmentReader,
  getBereavementComplianceProvider,
  getBereavementOutreachProvider,
  getBereavementPlanProvider,
  getBereavementRiskFactorsProvider,
  getBereavementRiskTierProvider,
  planViewOf,
  registerBereavementSeams,
} from "../src/modules/16-bereavement/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const PLAN_B = "3b3b3b3b-3333-3333-3333-333333333333";
const ADMISSION = "44444444-4444-4444-4444-444444444444";
const CONTACT = "55555555-5555-5555-5555-555555555555";
const CONTACT_B = "5b5b5b5b-5555-5555-5555-555555555555";
const COUNSELOR = "66666666-6666-6666-6666-666666666666";
const VOLUNTEER = "77777777-7777-7777-7777-777777777777";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888888888";
const PROVIDER_ENTITY_B = "8b8b8b8b-8888-8888-8888-888888888888";
const LOCATION = "99999999-9999-9999-9999-999999999999";
const PORTAL_ACCOUNT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OUTREACH = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const DEATH_DATE = "2026-01-01";
/** Day 60 of the window — comfortably inside. */
const NOW = "2026-03-02T12:00:00.000Z";
const clock = () => NOW;

const MS_PER_DAY = 86_400_000;
const daysAfterDeath = (days: number): string =>
  new Date(Date.parse(`${DEATH_DATE}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString();

const plan = (over: Partial<BereavementPlanFacts> = {}): BereavementPlanFacts => ({
  planId: PLAN,
  patientId: PATIENT,
  admissionId: ADMISSION,
  providerEntityId: PROVIDER_ENTITY,
  locationId: LOCATION,
  status: "active",
  deathDate: DEATH_DATE,
  openedAt: "2026-01-03T00:00:00.000Z",
  closedAt: null,
  assignedCounselorUserId: COUNSELOR,
  assignedVolunteerUserId: null,
  currentRiskTier: "moderate",
  externalSource: null,
  ...over,
});

const contact = (over: Partial<BereavedContactView> = {}): BereavedContactView => ({
  contactId: CONTACT,
  planId: PLAN,
  status: "active",
  relationshipCode: "spouse",
  displayName: "A. Survivor",
  preferredLanguageIso639: "en",
  portalAccountId: PORTAL_ACCOUNT,
  consentRecordId: null,
  currentRiskTier: "moderate",
  volunteerVisibleOnly: false,
  allowedOutreachKinds: ["phone_call", "sympathy_card"],
  confirmedAt: "2026-01-05T00:00:00.000Z",
  optedOutAt: null,
  ...over,
});

const outreach = (over: Partial<BereavementOutreachView> = {}): BereavementOutreachView => ({
  outreachId: OUTREACH,
  planId: PLAN,
  contactId: CONTACT,
  kind: "phone_call",
  status: "scheduled",
  anniversaryMark: null,
  dueAt: daysAfterDeath(30),
  lateGraceUntil: daysAfterDeath(37),
  completedAt: null,
  assigneeUserId: COUNSELOR,
  renderedDocumentId: null,
  sourceEncounterId: null,
  ...over,
});

const FACTORS: BereavementRiskFactorInputs = {
  ambivalentRelationship: false,
  suddenUnexpectedDeath: true,
  priorUnresolvedLoss: "unknown",
  preExistingMentalHealth: false,
  socialIsolation: true,
  financialStrain: false,
  primaryCaregiverRole: true,
  activeSubstanceUse: "unknown",
};

const score = (over: Partial<BereavementRiskScoreFacts> = {}): BereavementRiskScoreFacts => ({
  scoreId: "score-1",
  planId: PLAN,
  contactId: CONTACT,
  providerEntityId: PROVIDER_ENTITY,
  locationId: LOCATION,
  assessedAt: "2026-02-01T00:00:00.000Z",
  factors: FACTORS,
  pg13Score: null,
  ipgrScore: null,
  redactedCategories: [],
  ruleScore: weightedScoreToRuleScore(0.51),
  ruleTier: "moderate",
  dataCompleteness: "partial",
  confidenceBand: "MEDIUM",
  ...over,
});

/** A store whose every method rejects — the outage case each seam's fail posture is decided against. */
const brokenStore = (): BereavementSeamStore => {
  const boom = async (): Promise<never> => {
    throw new Error("connection terminated");
  };
  return {
    planById: boom,
    planByAdmissionId: boom,
    plansForCounselor: boom,
    contactsForPlan: boom,
    outreachStatsForPlan: boom,
    closureForPlan: boom,
    outreachForPlan: boom,
    outreachStatusCounts: boom,
    copOutreachCounts: boom,
    riskScreeningCompletenessCounts: boom,
    planClosureCounts: boom,
    latestScoreForContact: boom,
    appendAugmentedScore: boom,
    tierCounts: boom,
    contactsForPortalAccount: boom,
  };
};

afterEach(() => __resetSeamsForTest());

describe("M16-T05 — registration into the M1 seam registry (§4.6 / D13)", () => {
  it("declares all seven seams in REQUIRED_SEAMS owned by M16, each with a deny-stub", () => {
    const keys = [
      "BereavementPlanProvider",
      "BereavementOutreachProvider",
      "BereavementRiskFactorsProvider",
      "BereavementAssignmentReader",
      "BereavedPortalScopeProvider",
      "BereavementComplianceProvider",
      "BereavementRiskTierProvider",
    ] as const;
    for (const key of keys) {
      const entry = REQUIRED_SEAMS.find((r) => r.key === key);
      expect(entry, key).toBeDefined();
      expect(entry?.ownerModule).toBe(16);
      expect(entry?.denyStub).toBeDefined();
    }
  });

  it("marks the subject-linked reads PHI and the aggregate rollups not", () => {
    const phiOf = (key: string) => REQUIRED_SEAMS.find((r) => r.key === key)?.phi;
    expect(phiOf("BereavementPlanProvider")).toBe(true);
    expect(phiOf("BereavementOutreachProvider")).toBe(true);
    expect(phiOf("BereavementRiskFactorsProvider")).toBe(true);
    expect(phiOf("BereavementAssignmentReader")).toBe(true);
    expect(phiOf("BereavedPortalScopeProvider")).toBe(true);
    // Counts over a scope — no subject id crosses (the M15 `DisciplineComplianceProvider` precedent).
    expect(phiOf("BereavementComplianceProvider")).toBe(false);
    expect(phiOf("BereavementRiskTierProvider")).toBe(false);
  });

  it("denies LOUDLY on every seam until M16 is wired (fail-closed default)", () => {
    __resetSeamsForTest();
    validateSeams();
    expect(() => getBereavementPlanProvider().planById(ORG, PLAN)).toThrow(/not implemented/);
    expect(() => getBereavementOutreachProvider().countByStatus({ orgId: ORG })).toThrow(
      /not implemented/,
    );
    expect(() => getBereavementRiskFactorsProvider().deterministicScore(ORG, CONTACT)).toThrow(
      /not implemented/,
    );
    expect(() => getBereavementAssignmentReader().assignmentForPlan(ORG, PLAN)).toThrow(
      /not implemented/,
    );
    expect(() =>
      getBereavedPortalScopeProvider().scopeForPortalAccount(ORG, PORTAL_ACCOUNT),
    ).toThrow(/not implemented/);
    expect(() => getBereavementComplianceProvider().copOutreachCounts({ orgId: ORG })).toThrow(
      /not implemented/,
    );
    expect(() => getBereavementRiskTierProvider().tierDistribution({ orgId: ORG })).toThrow(
      /not implemented/,
    );
  });

  it("registers all seven and still boots (validateSeams)", async () => {
    __resetSeamsForTest();
    const { store } = createInMemoryBereavementSeamStore({ plans: [plan()] });
    registerBereavementSeams({ store, clock });
    expect(() => validateSeams()).not.toThrow();
    await expect(getBereavementPlanProvider().planById(ORG, PLAN)).resolves.toMatchObject({
      planId: PLAN,
    });
    await expect(
      getBereavementAssignmentReader().assignmentForPlan(ORG, PLAN),
    ).resolves.toMatchObject({ counselorUserId: COUNSELOR });
  });
});

describe("BereavementPlanProvider — the D4 window has ONE implementation (§4.6)", () => {
  it("derives windowEndsAt as death_date + 396 days rather than reading a column", () => {
    const view = planViewOf(plan());
    expect(view.windowEndsAt).toBe(daysAfterDeath(BEREAVEMENT_WINDOW_DAYS));
  });

  it("answers the window inside, and closes it on the 396th day (half-open)", async () => {
    const { store } = createInMemoryBereavementSeamStore({ plans: [plan()] });
    const provider = createBereavementPlanProvider(store);
    await expect(provider.isInBereavementWindow(ORG, PLAN, daysAfterDeath(395))).resolves.toBe(
      true,
    );
    await expect(
      provider.isInBereavementWindow(ORG, PLAN, daysAfterDeath(BEREAVEMENT_WINDOW_DAYS)),
    ).resolves.toBe(false);
  });

  it("puts a CLOSED plan outside its window even mid-13-months (M36 archives the channel with it)", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan({ status: "closed_declined", closedAt: daysAfterDeath(20) })],
    });
    const provider = createBereavementPlanProvider(store);
    await expect(provider.isInBereavementWindow(ORG, PLAN, NOW)).resolves.toBe(false);
  });

  it("DENIES the window for an absent plan and for an unreadable store (authorization fail-closed)", async () => {
    const { store } = createInMemoryBereavementSeamStore();
    await expect(
      createBereavementPlanProvider(store).isInBereavementWindow(ORG, PLAN, NOW),
    ).resolves.toBe(false);
    // The whole point: an outage must not GRANT. This is the one method that swallows a store failure.
    await expect(
      createBereavementPlanProvider(brokenStore()).isInBereavementWindow(ORG, PLAN, NOW),
    ).resolves.toBe(false);
  });

  it("PROPAGATES a store failure on the reporting reads rather than answering 'no rows'", async () => {
    const provider = createBereavementPlanProvider(brokenStore());
    await expect(provider.planById(ORG, PLAN)).rejects.toThrow(/connection terminated/);
    await expect(provider.contactsForPlan(ORG, PLAN)).rejects.toThrow(/connection terminated/);
    await expect(provider.summarize(ORG, PLAN)).rejects.toThrow(/connection terminated/);
  });

  it("summarizes the plan with its roster, stats and closure; null when there is no plan", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan({ status: "closed_completed", closedAt: daysAfterDeath(396) })],
      contacts: [contact(), contact({ contactId: CONTACT_B, status: "opted_out" })],
      stats: [
        {
          planId: PLAN,
          completedCount: 12,
          missedCount: 1,
          contactsActiveCount: 1,
          contactsOptedOutCount: 1,
        },
      ],
      closures: [{ planId: PLAN, reason: "thirteen_month_completion", closureDocumentId: "doc-1" }],
    });
    const provider = createBereavementPlanProvider(store);
    const summary = await provider.summarize(ORG, PLAN);
    expect(summary?.contacts).toHaveLength(2);
    expect(summary?.stats.completedCount).toBe(12);
    expect(summary?.closureReason).toBe("thirteen_month_completion");
    expect(summary?.closureDocumentId).toBe("doc-1");
    await expect(provider.summarize(ORG, PLAN_B)).resolves.toBeNull();
  });

  it("resolves the plan by admission id (M36's channel seed reads the admission, not the plan)", async () => {
    const { store } = createInMemoryBereavementSeamStore({ plans: [plan()] });
    const provider = createBereavementPlanProvider(store);
    await expect(provider.planByAdmissionId(ORG, ADMISSION)).resolves.toMatchObject({
      planId: PLAN,
    });
    await expect(provider.planByAdmissionId(ORG, PLAN_B)).resolves.toBeNull();
  });
});

describe("BereavementOutreachProvider — filters + CoP counts (§4.6)", () => {
  const rows = [
    outreach(),
    outreach({
      outreachId: "o-2",
      contactId: CONTACT_B,
      kind: "sympathy_card",
      status: "completed",
      dueAt: daysAfterDeath(90),
      completedAt: daysAfterDeath(91),
    }),
    outreach({
      outreachId: "o-3",
      kind: "anniversary_letter",
      status: "missed",
      anniversaryMark: "anniversary",
      dueAt: daysAfterDeath(365),
    }),
  ];

  it("applies the contact / status / kind / due-range filter set", async () => {
    const { store } = createInMemoryBereavementSeamStore({ plans: [plan()], outreach: rows });
    const provider = createBereavementOutreachProvider(store);
    await expect(provider.listForPlan(ORG, PLAN, {})).resolves.toHaveLength(3);
    await expect(provider.listForPlan(ORG, PLAN, { contactId: CONTACT_B })).resolves.toHaveLength(
      1,
    );
    await expect(
      provider.listForPlan(ORG, PLAN, { status: ["missed", "completed"] }),
    ).resolves.toHaveLength(2);
    await expect(provider.listForPlan(ORG, PLAN, { kind: ["phone_call"] })).resolves.toHaveLength(
      1,
    );
    await expect(
      provider.listForPlan(ORG, PLAN, {
        dueFromIso: daysAfterDeath(60),
        dueToIso: daysAfterDeath(200),
      }),
    ).resolves.toHaveLength(1);
  });

  it("answers the CoP measure as COUNTS, and 0/0 stays 0/0 (small-N suppression stays possible)", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      copCounts: { numerator: 0, denominator: 0 },
    });
    await expect(
      createBereavementOutreachProvider(store).copComplianceCounts({ orgId: ORG }),
    ).resolves.toEqual({ numerator: 0, denominator: 0 });
  });

  it("shares ONE CoP definition with BereavementComplianceProvider — M30 and M33 cannot drift", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      copCounts: { numerator: 7, denominator: 9 },
    });
    const scope = { orgId: ORG, providerEntityId: PROVIDER_ENTITY };
    const viaOutreach = await createBereavementOutreachProvider(store).copComplianceCounts(scope);
    const viaCompliance = await createBereavementComplianceProvider(store).copOutreachCounts(scope);
    expect(viaOutreach).toEqual(viaCompliance);
    expect(viaCompliance).toEqual({ numerator: 7, denominator: 9 });
  });

  it("reports every outreach status, so a status with no rows is a real 0", async () => {
    const { store } = createInMemoryBereavementSeamStore();
    const counts = await createBereavementOutreachProvider(store).countByStatus({ orgId: ORG });
    expect(Object.keys(counts).sort()).toEqual([
      "cancelled",
      "completed",
      "declined",
      "in_progress",
      "missed",
      "no_response",
      "scheduled",
    ]);
    expect(counts.completed).toBe(0);
  });
});

describe("BereavementRiskFactorsProvider — the read + the ONE write (§4.6, D3/D8/D17)", () => {
  const augmentation = (
    over: Partial<BereavementAugmentationResult> = {},
  ): BereavementAugmentationResult => ({
    narrative: "The survivor's isolation is compounded by the suddenness of the death.",
    modelRef: "m32/bereavement-narrative@2026-06",
    requestId: "req-1",
    augmentedScore: 88,
    augmentedTier: "high",
    ...over,
  });

  it("unscales the 0..100 rule_score column back to the contract's [0,1] weighted score", async () => {
    const { store } = createInMemoryBereavementSeamStore({ scores: [score()] });
    const provider = createBereavementRiskFactorsProvider(store, clock);
    await expect(provider.deterministicScore(ORG, CONTACT)).resolves.toMatchObject({
      score: 0.51,
      tier: "moderate",
      dataCompleteness: "partial",
      confidenceBand: "MEDIUM",
    });
  });

  it("carries the §7.13 redaction categories through, so an `unknown` reads as withheld, not unasked", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      scores: [score({ redactedCategories: ["sud"] })],
    });
    const snapshot = await createBereavementRiskFactorsProvider(store, clock).factorsForContact(
      ORG,
      CONTACT,
      NOW,
    );
    expect(snapshot?.redactedCategories).toEqual(["sud"]);
    expect(snapshot?.factors.activeSubstanceUse).toBe("unknown");
  });

  it("reads the ledger BACKWARDS from asOf — a later score never leaks into an earlier snapshot", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      scores: [
        score({ scoreId: "old", assessedAt: "2026-01-10T00:00:00.000Z", ruleTier: "low" }),
        score({ scoreId: "new", assessedAt: "2026-02-20T00:00:00.000Z", ruleTier: "high" }),
      ],
    });
    const provider = createBereavementRiskFactorsProvider(store, clock);
    await expect(
      provider.factorsForContact(ORG, CONTACT, "2026-01-15T00:00:00.000Z"),
    ).resolves.toMatchObject({ asOf: "2026-01-15T00:00:00.000Z" });
    await expect(provider.deterministicScore(ORG, CONTACT)).resolves.toMatchObject({
      scoreId: "new",
      tier: "high",
    });
  });

  it("APPENDS the Layer-2 row and keeps rule_tier verbatim — the narrative cannot move the tier", async () => {
    const { store, appended } = createInMemoryBereavementSeamStore({
      scores: [score({ ruleTier: "moderate" })],
    });
    const provider = createBereavementRiskFactorsProvider(store, clock);
    const newId = await provider.registerAugmentation(ORG, CONTACT, augmentation());

    expect(appended).toHaveLength(1);
    const draft = appended[0];
    // The M32 result claimed `high`; the deterministic tier is what rides `rule_tier`.
    expect(draft?.ruleTier).toBe("moderate");
    expect(draft?.columns.augmentedTier).toBe("high");
    expect(draft?.columns.scoreKind).toBe("llm_augmented");
    expect(draft?.amendedFromScoreId).toBe("score-1");
    // The append is visible next read, and the cadence-driving tier is still the rubric's.
    await expect(provider.deterministicScore(ORG, CONTACT)).resolves.toMatchObject({
      scoreId: newId,
      tier: "moderate",
    });
  });

  it("degrades to the deterministic columns when M32 answered without a score or a model ref", async () => {
    const { store, appended } = createInMemoryBereavementSeamStore({ scores: [score()] });
    const provider = createBereavementRiskFactorsProvider(store, clock);
    await provider.registerAugmentation(ORG, CONTACT, augmentation({ augmentedScore: null }));
    // §3.3.3's `berv_risk_llm_requires_rule` CHECK would refuse an llm_augmented row without both.
    expect(appended[0]?.columns.scoreKind).toBe("rule_deterministic");
    expect(appended[0]?.columns.augmentedNarrativeRedacted).toBeNull();
  });

  it("REFUSES to augment a contact with no deterministic score rather than inventing a base row", async () => {
    const { store } = createInMemoryBereavementSeamStore();
    const provider = createBereavementRiskFactorsProvider(store, clock);
    await expect(provider.registerAugmentation(ORG, CONTACT, augmentation())).rejects.toMatchObject(
      { code: "RISK_SCORE_NOT_FOUND", statusCode: 404 },
    );
  });
});

describe("BereavementAssignmentReader + BereavementRiskTierProvider (§4.6 / D13)", () => {
  it("derives the assignment off the plan row, so it can never disagree with the plan header", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan({ assignedVolunteerUserId: VOLUNTEER })],
    });
    const reader = createBereavementAssignmentReader(store);
    await expect(reader.assignmentForPlan(ORG, PLAN)).resolves.toEqual({
      planId: PLAN,
      counselorUserId: COUNSELOR,
      volunteerUserId: VOLUNTEER,
      status: "active",
    });
    await expect(reader.assignmentForPlan(ORG, PLAN_B)).resolves.toBeNull();
  });

  it("lists a counselor's caseload as plan VIEWS (window included), not raw rows", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan(), plan({ planId: PLAN_B, assignedCounselorUserId: null })],
    });
    const plans = await createBereavementAssignmentReader(store).plansForCounselor(ORG, COUNSELOR);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.windowEndsAt).toBe(daysAfterDeath(BEREAVEMENT_WINDOW_DAYS));
  });

  it("distributes tiers with every tier present, scoped by the denormalized provider entity", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan(), plan({ planId: PLAN_B, providerEntityId: PROVIDER_ENTITY_B })],
      contacts: [
        contact({ currentRiskTier: "high" }),
        contact({ contactId: CONTACT_B, planId: PLAN_B, currentRiskTier: "low" }),
      ],
    });
    const provider = createBereavementRiskTierProvider(store);
    await expect(provider.tierDistribution({ orgId: ORG })).resolves.toEqual({
      low: 1,
      moderate: 0,
      high: 1,
      complicated: 0,
    });
    await expect(
      provider.tierDistribution({ orgId: ORG, providerEntityId: PROVIDER_ENTITY_B }),
    ).resolves.toEqual({ low: 1, moderate: 0, high: 0, complicated: 0 });
  });
});

describe("BereavedPortalScopeProvider — the M31 bereaved-family scope (§4.6 / D9 / D10)", () => {
  it("offers opt-out inside an open window and withdraws it once the program ends", async () => {
    const open = createInMemoryBereavementSeamStore({
      plans: [plan()],
      contacts: [contact()],
    }).store;
    const [scope] = await createBereavedPortalScopeProvider(open, clock).scopeForPortalAccount(
      ORG,
      PORTAL_ACCOUNT,
    );
    expect(scope).toMatchObject({
      contactId: CONTACT,
      inBereavementWindow: true,
      mayOptOut: true,
      mayRescindOptOut: false,
    });

    const closed = createInMemoryBereavementSeamStore({
      plans: [plan({ status: "closed_completed", closedAt: daysAfterDeath(30) })],
      contacts: [contact()],
    }).store;
    const [ended] = await createBereavedPortalScopeProvider(closed, clock).scopeForPortalAccount(
      ORG,
      PORTAL_ACCOUNT,
    );
    expect(ended).toMatchObject({ inBereavementWindow: false, mayOptOut: false });
  });

  it("allows a self-service rescind only inside the D9 90-day window", async () => {
    const optedOutRecently = Date.parse(NOW) - 10 * MS_PER_DAY;
    const optedOutLongAgo =
      Date.parse(NOW) - (OPT_OUT_SELF_SERVICE_RESCIND_WINDOW_DAYS + 5) * MS_PER_DAY;

    const recent = createInMemoryBereavementSeamStore({
      plans: [plan()],
      contacts: [
        contact({ status: "opted_out", optedOutAt: new Date(optedOutRecently).toISOString() }),
      ],
    }).store;
    const [inWindow] = await createBereavedPortalScopeProvider(recent, clock).scopeForPortalAccount(
      ORG,
      PORTAL_ACCOUNT,
    );
    expect(inWindow).toMatchObject({ mayOptOut: false, mayRescindOptOut: true });

    const stale = createInMemoryBereavementSeamStore({
      plans: [plan()],
      contacts: [
        contact({ status: "opted_out", optedOutAt: new Date(optedOutLongAgo).toISOString() }),
      ],
    }).store;
    const [expired] = await createBereavedPortalScopeProvider(stale, clock).scopeForPortalAccount(
      ORG,
      PORTAL_ACCOUNT,
    );
    // Past 90 days re-enrollment is counselor-driven with fresh M39 consent, not a portal click.
    expect(expired).toMatchObject({ mayRescindOptOut: false });
  });

  it("returns only the account's OWN contacts — never the rest of the roster", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      plans: [plan()],
      contacts: [contact(), contact({ contactId: CONTACT_B, portalAccountId: null })],
    });
    const scopes = await createBereavedPortalScopeProvider(store, clock).scopeForPortalAccount(
      ORG,
      PORTAL_ACCOUNT,
    );
    expect(scopes.map((s) => s.contactId)).toEqual([CONTACT]);
  });
});

describe("BereavementComplianceProvider — rollups as counts (§4.6 / D17)", () => {
  it("keeps the screening denominator separate so `minimal` rows can be excluded, not zeroed", async () => {
    const { store } = createInMemoryBereavementSeamStore({
      screeningCounts: { numerator: 4, denominator: 5 },
    });
    await expect(
      createBereavementComplianceProvider(store).riskScreeningCompletenessCounts({ orgId: ORG }),
    ).resolves.toEqual({ numerator: 4, denominator: 5 });
  });

  it("tallies every closure reason, so a reason with no closures reads as a real 0", async () => {
    const { store } = createInMemoryBereavementSeamStore();
    const counts = await createBereavementComplianceProvider(store).planClosureCounts({
      orgId: ORG,
    });
    expect(counts.thirteen_month_completion).toBe(0);
    expect(counts.all_contacts_declined).toBe(0);
    expect(Object.keys(counts)).toHaveLength(9);
  });

  it("PROPAGATES a store outage rather than reporting a zero the agency did not earn", async () => {
    const provider = createBereavementComplianceProvider(brokenStore());
    await expect(provider.copOutreachCounts({ orgId: ORG })).rejects.toThrow(
      /connection terminated/,
    );
  });
});
