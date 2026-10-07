// apps/backend/__tests__/idg-packet-content.test.ts — the packet CONTENT read model
// (GET /idg/meetings/:meetingId/packets/:patientId): the frozen `built_snapshot` shaped for the packet page.
//   1. snapshot -> view mapping (pure `mapPacketContent`), over snapshots produced by the REAL pure builder:
//      populated sections map 1:1, legitimately-empty/never-captured sections stay empty/null (never
//      back-filled), the cover summary is deterministic, an unsupported/absent snapshot yields `content: null`.
//   2. W-SUD-01 through the full route stack (`inject`): a SUD-flagged packet is redacted for a caller WITHOUT a
//      Part 2 release (every source-derived block elided, banner set, cover text/counts describe what is shown),
//      returned in full for a caller WITH one, fail-closed when the consent port throws or is absent, and the
//      consent round-trip is skipped entirely for a non-SUD patient.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type PacketBuildInput, buildPacketSnapshot } from "@wardenx/idg";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  type PacketDisclosurePort,
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";
import {
  SUD_REDACTION_NOTICE,
  composeCoverSummary,
  mapPacketContent,
} from "../src/modules/14-idg/routes/packet-content";
import { sudDisclosureAllowedForPacket } from "../src/modules/14-idg/routes/packet-disclosure";

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const MTG = "11111111-1111-4111-8111-111111111111";
const P_PLAIN = "22222222-2222-4222-8222-222222222222";
const P_SUD = "33333333-3333-4333-8333-333333333333";
const P_EMPTY = "55555555-5555-4555-8555-555555555555";

function input(over: { sud?: boolean; populated?: boolean }): PacketBuildInput {
  const populated = over.populated ?? true;
  return {
    context: {
      meetingId: MTG as never,
      patientId: P_PLAIN as never,
      admissionId: "66666666-6666-4666-8666-666666666666" as never,
      locationId: LOC as never,
      builtAt: "2026-06-16T09:00:00.000Z",
      builderJobId: "job-1",
      priorIdgAdjournedAt: "2026-06-02T15:00:00.000Z",
      admissionActivatedAt: "2026-01-01T00:00:00.000Z",
    },
    cover: {
      firstName: "Ada",
      lastInitial: "L",
      age: 81,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Malignant neoplasm of lung",
      levelOfCare: "routine",
      nextRecertDueAt: "2026-07-01T00:00:00.000Z",
      f2fWindowState: "window_open",
      activeDpoa: null,
      activeSudFlag: over.sud ?? false,
    },
    sinceLastIdg: {
      encounters: populated
        ? [
            {
              encounterId: "enc-1",
              encounterType: "rn_visit",
              signedAt: "2026-06-10T10:00:00.000Z",
              authorDiscipline: "rn",
            },
            {
              encounterId: "enc-old",
              encounterType: "rn_visit",
              signedAt: "2026-05-01T10:00:00.000Z", // before the cursor — the builder drops it
              authorDiscipline: "rn",
            },
          ]
        : [],
      significantAssessmentChanges: populated
        ? [
            {
              assessmentId: "asm-1",
              scaleKind: "pain",
              changeKind: "worsened",
              occurredAt: "2026-06-11T10:00:00.000Z",
            },
          ]
        : [],
      j2051Triggers: populated
        ? [
            {
              hopeAssessmentId: "hope-1",
              triggerKind: "symptom_impact",
              firedAt: "2026-06-12T00:00:00.000Z",
            },
          ]
        : [],
      ordersChanged: populated
        ? [
            {
              orderId: "ord-1",
              orderKind: "lab",
              changeKind: "signed",
              changedAt: "2026-06-12T00:00:00.000Z",
            },
          ]
        : [],
      medicationsChanged: populated
        ? [
            {
              medicationOrderId: "med-1",
              drugLabel: "Morphine 5 mg",
              changeKind: "dose_changed",
              changedAt: "2026-06-13T00:00:00.000Z",
            },
          ]
        : [],
      flaggedEvents: populated
        ? [
            {
              kind: "fall",
              sourceId: "flag-1",
              occurredAt: "2026-06-14T00:00:00.000Z",
              severity: "urgent",
            },
          ]
        : [],
    },
    carePlanSummary: {
      activeProblemCount: 2,
      activeGoalCount: 3,
      activeInterventionCount: 1,
      lastSignedVersionId: "cpv-1",
      lastSignedAt: "2026-06-01T00:00:00.000Z",
      nextReviewDueAt: "2026-06-30T00:00:00.000Z",
      isReviewOverdue: false,
    },
    hopeContext: populated
      ? {
          upcomingTimepoints: [{ timepoint: "SFV", dueAt: "2026-06-20T00:00:00.000Z" }],
          openSfvCount: 1,
        }
      : null,
    carryForwardActionItems: populated
      ? [
          {
            actionItemId: "ai-1",
            assignedToMembershipId: "mem-1",
            dueDate: "2026-06-05T00:00:00.000Z",
            carryForwardCount: 2,
          },
        ]
      : [],
  };
}

/** A stored row exactly as Postgres would hand back the two jsonb columns (JSON round-tripped). */
function storedRow(over: Parameters<typeof input>[0]) {
  const built = buildPacketSnapshot(input(over));
  return JSON.parse(
    JSON.stringify({ builtSnapshot: built.snapshot, disciplineViews: built.disciplineViews }),
  ) as { builtSnapshot: unknown; disciplineViews: unknown };
}

const allow = async () => true;
const deny = async () => false;

describe("mapPacketContent — snapshot -> view", () => {
  it("maps every populated snapshot section 1:1 (cursor-filtered, discipline-ordered)", async () => {
    const r = await mapPacketContent(storedRow({}), allow);
    expect(r.appliedSudRedaction).toBe(false);
    expect(r.redactionNotice).toBeNull();
    const c = r.content!;
    expect(c.schemaVersion).toBe("2026-01-v1");
    expect(c.signedEncounters).toEqual([
      {
        encounterId: "enc-1",
        encounterType: "rn_visit",
        discipline: "rn",
        signedAt: "2026-06-10T10:00:00.000Z",
      },
    ]); // enc-old predates the cursor
    expect(c.assessmentChanges).toEqual([
      {
        assessmentId: "asm-1",
        scaleKind: "pain",
        changeKind: "worsened",
        occurredAt: "2026-06-11T10:00:00.000Z",
      },
    ]);
    expect(c.orderChanges.map((o) => o.orderId)).toEqual(["ord-1"]);
    expect(c.medicationChanges.map((m) => m.drugLabel)).toEqual(["Morphine 5 mg"]);
    expect(c.flaggedEvents).toEqual([
      {
        kind: "fall",
        sourceId: "flag-1",
        occurredAt: "2026-06-14T00:00:00.000Z",
        severity: "urgent",
      },
    ]);
    expect(c.carryForwardActionItems).toEqual([
      {
        actionItemId: "ai-1",
        assignedToMembershipId: "mem-1",
        dueDate: "2026-06-05T00:00:00.000Z",
        carryForwardCount: 2,
      },
    ]);
    expect(c.hopeTimepoints).toEqual({
      captured: true,
      upcoming: [{ timepoint: "SFV", dueAt: "2026-06-20T00:00:00.000Z" }],
      openSfvCount: 1,
      symptomImpactTriggers: [
        {
          hopeAssessmentId: "hope-1",
          triggerKind: "symptom_impact",
          firedAt: "2026-06-12T00:00:00.000Z",
        },
      ],
    });
    expect(c.cover.counts).toEqual({
      signedEncounters: 1,
      assessmentChanges: 1,
      hopeTriggers: 1,
      orderChanges: 1,
      medicationChanges: 1,
      flaggedEvents: 1,
      carryForwardActionItems: 1,
    });
    expect(c.cover.recert).toEqual({
      nextRecertDueAt: "2026-07-01T00:00:00.000Z",
      f2fWindowState: "window_open",
    });
    expect(c.cover.nameAtBuild).toBe("Ada L.");
    expect(c.cover.hasActiveDpoa).toBe(false);
    // Discipline order follows DISCIPLINE_VIEW_POLICY; RN carries the encounter + medication highlights.
    expect(c.disciplines.map((d) => d.discipline)).toEqual([
      "rn",
      "msw",
      "chaplain",
      "aide",
      "md_np",
      "medical_director",
      "volunteer",
    ]);
    const rn = c.disciplines.find((d) => d.discipline === "rn")!;
    expect(rn.items.map((i) => i.sourceId)).toContain("enc-1");
    expect(rn.items.map((i) => i.sourceId)).toContain("med-1");
  });

  it("keeps legitimately-empty / never-captured sections empty or null — nothing is back-filled", async () => {
    const r = await mapPacketContent(storedRow({ populated: false }), allow);
    const c = r.content!;
    expect(c.signedEncounters).toEqual([]);
    expect(c.assessmentChanges).toEqual([]);
    expect(c.orderChanges).toEqual([]);
    expect(c.medicationChanges).toEqual([]);
    expect(c.flaggedEvents).toEqual([]);
    expect(c.carryForwardActionItems).toEqual([]);
    expect(c.hopeTimepoints).toEqual({
      captured: false,
      upcoming: [],
      openSfvCount: null,
      symptomImpactTriggers: [],
    });
    for (const d of c.disciplines) expect(d.items).toEqual([]);
    expect(c.cover.summary).toContain("no signed encounters, assessment changes");
    expect(Object.values(c.cover.counts).every((n) => n === 0)).toBe(true);
  });

  it("composes a deterministic cover summary from the snapshot facts (same input => same bytes; no AI text)", async () => {
    const a = (await mapPacketContent(storedRow({}), allow)).content!.cover.summary;
    const b = (await mapPacketContent(storedRow({}), allow)).content!.cover.summary;
    expect(a).toBe(b);
    expect(a).toContain("Age 81, routine home care, day 166 on service.");
    expect(a).toContain("Primary diagnosis: Malignant neoplasm of lung (C34.90).");
    expect(a).toContain(
      "Since the last IDG (2026-06-02): 1 signed encounter, 1 significant assessment change",
    );
    expect(a).toContain("Next recertification due 2026-07-01; face-to-face window window open.");
    expect(a).toContain("Care plan: 2 active problems, 3 active goals, 1 active intervention;");
    expect(a).toContain("1 carried-forward action item open.");
    expect(a).toContain("Discussion flags: recert due");
    expect(a).not.toContain("Ada"); // the name is not in the free text
  });

  it("never surfaces layer2Polished and ignores any stored polish", async () => {
    const row = storedRow({});
    const views = row.disciplineViews as Record<string, { layer2Polished: unknown }>;
    views.rn.layer2Polished = {
      enhancedSummary: "POLISHED",
      modificationId: "m",
      layer2InvolvedAt: "x",
    };
    const r = await mapPacketContent(row, allow);
    expect(JSON.stringify(r.content)).not.toContain("POLISHED");
  });

  it("returns content:null for an absent or unsupported-schema snapshot (fail-honest), tolerates legacy gaps", async () => {
    expect(
      (await mapPacketContent({ builtSnapshot: null, disciplineViews: null }, allow)).content,
    ).toBeNull();
    const row = storedRow({});
    (row.builtSnapshot as { schemaVersion: string }).schemaVersion = "2027-01-v2";
    expect((await mapPacketContent(row, allow)).content).toBeNull();
    // A legacy snapshot missing whole since-blocks maps to empty arrays, never a throw.
    const legacy = storedRow({});
    (legacy.builtSnapshot as { sinceLastIdg: unknown }).sinceLastIdg = {};
    (legacy.builtSnapshot as { carryForwardActionItems?: unknown }).carryForwardActionItems =
      undefined;
    const r = await mapPacketContent(legacy, allow);
    expect(r.content?.signedEncounters).toEqual([]);
    expect(r.content?.carryForwardActionItems).toEqual([]);
  });

  it("composeCoverSummary states the Part 2 notice when redacted", async () => {
    const built = buildPacketSnapshot(input({}));
    expect(composeCoverSummary(built.snapshot, true)).toContain(SUD_REDACTION_NOTICE);
    expect(composeCoverSummary(built.snapshot, false)).not.toContain(SUD_REDACTION_NOTICE);
  });
});

describe("mapPacketContent — W-SUD-01", () => {
  it("elides every source-derived block for a SUD-flagged patient when the caller lacks a Part 2 release", async () => {
    const r = await mapPacketContent(storedRow({ sud: true }), deny);
    expect(r.appliedSudRedaction).toBe(true);
    expect(r.redactionNotice).toBe(SUD_REDACTION_NOTICE);
    expect(r.redactedEntryCount).toBe(6); // enc + asm + hope + ord + med + flag
    const c = r.content!;
    expect(c.signedEncounters).toEqual([]);
    expect(c.assessmentChanges).toEqual([]);
    expect(c.orderChanges).toEqual([]);
    expect(c.medicationChanges).toEqual([]);
    expect(c.flaggedEvents).toEqual([]);
    expect(c.hopeTimepoints.symptomImpactTriggers).toEqual([]);
    // No discipline highlight for an elided source survives (action-item highlights are ids/dates only).
    const kinds = new Set(c.disciplines.flatMap((d) => d.items.map((i) => i.sourceKind)));
    for (const k of ["encounter", "assessment", "order", "medication", "hope", "flag"]) {
      expect(kinds.has(k as never)).toBe(false);
    }
    // The cover describes what the caller is shown — and never leaks the elided content.
    expect(c.cover.counts.signedEncounters).toBe(0);
    expect(c.cover.summary).toContain(SUD_REDACTION_NOTICE);
    expect(c.cover.summary).not.toContain("signed encounter");
    expect(c.cover.summary).toContain("activity details are withheld");
    // Flags derived from the elided blocks are dropped; cover-fact flags remain.
    expect(c.cover.discussionFlags.map((f) => f.kind).sort()).toEqual([
      "recert_due",
      "sud_pattern_review",
    ]);
    expect(JSON.stringify(c)).not.toMatch(/enc-1|asm-1|ord-1|med-1|Morphine|flag-1|hope-1/);
    // The non-PHI banner signal stays.
    expect(c.cover.activeSudFlag).toBe(true);
  });

  it("returns the full packet for a SUD-flagged patient when the caller holds a Part 2 release", async () => {
    const r = await mapPacketContent(storedRow({ sud: true }), allow);
    expect(r.appliedSudRedaction).toBe(false);
    expect(r.content?.signedEncounters).toHaveLength(1);
    expect(r.content?.orderChanges).toHaveLength(1);
  });

  it("fails CLOSED when the consent verdict throws", async () => {
    const r = await mapPacketContent(storedRow({ sud: true }), async () => {
      throw new Error("M39 down");
    });
    expect(r.appliedSudRedaction).toBe(true);
    expect(r.content?.signedEncounters).toEqual([]);
  });

  it("does NOT consult consent for a non-SUD patient", async () => {
    let calls = 0;
    const r = await mapPacketContent(storedRow({ sud: false }), async () => {
      calls++;
      return false;
    });
    expect(calls).toBe(0);
    expect(r.appliedSudRedaction).toBe(false);
    expect(r.content?.signedEncounters).toHaveLength(1);
  });
});

describe("sudDisclosureAllowedForPacket — the M7/M15 per-actor ordering", () => {
  const caller = (roles: string[]) => ({
    organizationId: ORG,
    patientId: P_SUD,
    membershipId: "m1",
    roles,
  });
  const port = (allowed: boolean, restricted: boolean): PacketDisclosurePort => ({
    part2ReleaseActive: async () => ({ allowed, restrictedToNamedWorkforce: restricted }),
  });
  it("a covering release allows; no release denies a non-CM", async () => {
    expect(
      await sudDisclosureAllowedForPacket(port(true, false), caller(["idg_coordinator"])),
    ).toBe(true);
    expect(
      await sudDisclosureAllowedForPacket(port(false, false), caller(["idg_coordinator"])),
    ).toBe(false);
  });
  it("the RN case manager carve-out applies only when the release does not name OTHER workforce members", async () => {
    expect(
      await sudDisclosureAllowedForPacket(port(false, false), caller(["rn_case_manager"])),
    ).toBe(true);
    expect(
      await sudDisclosureAllowedForPacket(port(false, true), caller(["rn_case_manager"])),
    ).toBe(false);
  });
  it("a throwing port denies", async () => {
    const boom: PacketDisclosurePort = {
      part2ReleaseActive: async () => {
        throw new Error("boom");
      },
    };
    expect(await sudDisclosureAllowedForPacket(boom, caller(["rn_case_manager"]))).toBe(false);
  });
});

// ── through the route stack ────────────────────────────────────────────────────────────────────────────────
// GAP-128 - these suites exercise other behavior; the per-patient caseload scope is covered in idg-caseload-scope.test.ts.
const COVERS_EVERY_PATIENT = async (): Promise<readonly string[]> =>
  ({ includes: () => true }) as unknown as readonly string[];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
}
const HEADERS = {
  "x-test-user": "clinician",
  "x-test-org": ORG,
  "x-test-roles": "idg_coordinator",
  "x-test-locations": LOC,
};

function makeServer(sudDisclosure?: PacketDisclosurePort) {
  const backend = createInMemoryIdgBackend({
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [P_PLAIN, P_SUD, P_EMPTY],
        packets: {
          [P_PLAIN]: storedRow({ sud: false }),
          [P_SUD]: storedRow({ sud: true }),
          // P_EMPTY: included on the meeting but no stored packet
        },
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "clinician",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["idg.read", "idg.coordinate"],
          },
        ],
      },
      {
        orgId: ORG,
        userId: "no-idg",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["patients.read"] },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildIdgAbacPredicates({ resolver: backend }))) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend, sudDisclosure, caseload: COVERS_EVERY_PATIENT });
  return app;
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

describe("GET /idg/meetings/:meetingId/packets/:patientId — content + W-SUD-01 over HTTP", () => {
  const get = (app: ReturnType<typeof makeServer>, patientId: string, headers = HEADERS) =>
    app.inject({ method: "GET", url: `/api/v1/idg/meetings/${MTG}/packets/${patientId}`, headers });

  it("returns the digest fields plus content for a non-SUD packet, without a consent round-trip", async () => {
    let consentCalls = 0;
    const app = makeServer({
      part2ReleaseActive: async () => {
        consentCalls++;
        return { allowed: false, restrictedToNamedWorkforce: false };
      },
    });
    const res = await get(app, P_PLAIN);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patientId).toBe(P_PLAIN);
    expect(body.appliedSudRedaction).toBe(false);
    expect(body.redactionNotice).toBeNull();
    expect(body.content.signedEncounters).toHaveLength(1);
    expect(body.content.cover.summary).toContain("Primary diagnosis");
    expect(consentCalls).toBe(0);
    await app.close();
  });

  it("REDACTS a SUD-flagged packet for a caller without the Part 2 release (banner, elided blocks)", async () => {
    const app = makeServer({
      part2ReleaseActive: async () => ({ allowed: false, restrictedToNamedWorkforce: false }),
    });
    const res = await get(app, P_SUD);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appliedSudRedaction).toBe(true);
    expect(body.redactionNotice).toBe("Some content filtered per 42 CFR Part 2");
    expect(body.content.signedEncounters).toEqual([]);
    expect(body.content.orderChanges).toEqual([]);
    expect(body.content.medicationChanges).toEqual([]);
    expect(body.content.assessmentChanges).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/enc-1|Morphine|asm-1|ord-1/);
    expect(JSON.stringify(body)).not.toMatch(/redactedEntryCount/); // the count is server-log only
    await app.close();
  });

  it("returns the FULL SUD-flagged packet for a caller who holds the release", async () => {
    const app = makeServer({
      part2ReleaseActive: async () => ({ allowed: true, restrictedToNamedWorkforce: false }),
    });
    const body = (await get(app, P_SUD)).json();
    expect(body.appliedSudRedaction).toBe(false);
    expect(body.content.signedEncounters).toHaveLength(1);
    expect(body.content.medicationChanges[0].drugLabel).toBe("Morphine 5 mg");
    await app.close();
  });

  it("fails CLOSED when M39 is unbound (default seam port with no ConsentEvaluator registered)", async () => {
    const app = makeServer(); // default seamPacketDisclosurePort -> getSeam throws -> deny
    const body = (await get(app, P_SUD)).json();
    expect(body.appliedSudRedaction).toBe(true);
    expect(body.content.signedEncounters).toEqual([]);
    await app.close();
  });

  it("content is null (not fabricated) when no packet snapshot is stored for an included patient", async () => {
    const app = makeServer();
    const res = await get(app, P_EMPTY);
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBeNull();
    await app.close();
  });

  it("keeps the idg.read gate: a caller without it is denied, and an unknown patient 404s", async () => {
    const app = makeServer();
    expect((await get(app, P_PLAIN, { ...HEADERS, "x-test-user": "no-idg" })).statusCode).toBe(403);
    expect((await get(app, "99999999-9999-4999-8999-999999999999")).statusCode).toBe(404);
    await app.close();
  });
});
