// apps/backend/__tests__/idg-discipline-notes.test.ts — the M14 per-discipline note routes (spec extension)
// through the FULL M1 middleware chain via Fastify `inject` over the in-memory IDG backend: RBAC/ABAC gates,
// the live-only + present-for-discipline + coordinator rules, If-Match / Idempotency-Key, patient-on-agenda
// validation, author display name, and the fail-closed 42 CFR Part 2 elision on the READ.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS } from "@wardenx/idg";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";
import type { PacketDisclosurePort } from "../src/modules/14-idg/routes/packet-disclosure";

// GAP-128 - these suites exercise other behavior; the per-patient caseload scope is covered in idg-caseload-scope.test.ts.
// The list reads iterate the resolved caseload (5c07d4ad7), so it must be a real list, not an `includes` stub.
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
}

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const OTHER_LOC = "55555555-5555-4555-8555-555555555555";
const MTG = "11111111-1111-4111-8111-111111111111";
const IDLE = "11111111-1111-4111-8111-1111111111ff"; // packets_ready — not live
const CANCELLED = "11111111-1111-4111-8111-1111111111cc";
const NEWER = "11111111-1111-4111-8111-1111111111dd"; // a later IDG that includes P_CLEAR (adjourned on demand)
const P_CLEAR = "22222222-2222-4222-8222-222222222221";
const P_SUD = "22222222-2222-4222-8222-222222222222";
const P_OFF = "22222222-2222-4222-8222-2222222222ff";
const RN = "33333333-3333-4333-8333-333333333331";
const MSW = "33333333-3333-4333-8333-333333333332";
const COORD = "33333333-3333-4333-8333-3333333333c0";
const READER = "33333333-3333-4333-8333-3333333333e0";
const COVERS_EVERY_PATIENT = async (): Promise<readonly string[]> => [P_CLEAR, P_SUD, P_OFF];
const NAMES = new Map([[RN, { displayName: "Rita RN" }]]);

const hdr = (user: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-locations": LOC,
  "idempotency-key": `k-${Math.random().toString(36).slice(2)}`,
  ...extra,
});

function perms(userId: string, permissionKeys: string[]) {
  return {
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  };
}

/** The in-memory backend of the most recent {@link makeServer} (to adjourn / read minutes directly). */
let lastBackend: ReturnType<typeof createInMemoryIdgBackend>;
/** A mutable clock the backend reads as "now" (ISO string), so the addendum window can be crossed. */
const clock = { iso: "2026-06-22T15:00:00.000Z" };
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeServer(sudAllowed: boolean) {
  clock.iso = "2026-06-22T15:00:00.000Z";
  const backend = createInMemoryIdgBackend({
    now: () => clock.iso,
    meetings: [
      {
        id: CANCELLED,
        organizationId: ORG,
        locationId: LOC,
        status: "cancelled",
        scheduledStart: "2026-06-24T14:00:00.000Z",
        scheduledEnd: "2026-06-24T16:00:00.000Z",
      },
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [P_CLEAR, P_SUD],
        packets: {
          [P_CLEAR]: {
            builtSnapshot: { patientCover: { activeSudFlag: false } },
            disciplineViews: {},
          },
          [P_SUD]: {
            builtSnapshot: { patientCover: { activeSudFlag: true } },
            disciplineViews: {},
          },
        },
      },
      {
        id: NEWER,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-29T14:00:00.000Z",
        scheduledEnd: "2026-06-29T16:00:00.000Z",
        includedPatientIds: [P_CLEAR],
      },
      {
        id: IDLE,
        organizationId: ORG,
        locationId: LOC,
        status: "packets_ready",
        scheduledStart: "2026-06-23T14:00:00.000Z",
        scheduledEnd: "2026-06-23T16:00:00.000Z",
      },
    ],
  });
  lastBackend = backend;
  await backend.recordAttendance(ORG, RN, MTG, { membershipId: RN, discipline: "rn" });
  await backend.recordAttendance(ORG, MSW, MTG, {
    membershipId: MSW,
    discipline: "msw",
    status: "absent",
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      perms(RN, ["idg.read", "idg.attend"]),
      perms(MSW, ["idg.read", "idg.attend"]),
      perms(COORD, ["idg.read", "idg.attend", "idg.coordinate"]),
      perms(READER, ["idg.read"]),
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildIdgAbacPredicates({ resolver: backend })))
    registry.register(name, fn);
  registerAbacRegistry(registry);
  const sudDisclosure: PacketDisclosurePort = {
    part2ReleaseActive: async () => ({ allowed: sudAllowed, restrictedToNamedWorkforce: true }),
  };
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, {
    service: backend,
    sudDisclosure,
    enrichment: { membershipDisplay: { displayForMemberships: async () => NAMES } },
    caseload: COVERS_EVERY_PATIENT,
  });
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

const post = (
  app: Awaited<ReturnType<typeof makeServer>>,
  user: string,
  payload: unknown,
  url = MTG,
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/idg/meetings/${url}/discipline-notes`,
    headers: hdr(user),
    payload: payload as object,
  });

describe("M14 discipline notes — writes", () => {
  it("an attendee present for the discipline writes; author name is attached; version starts at 0", async () => {
    const app = await makeServer(false);
    const res = await post(app, RN, {
      patientId: P_CLEAR,
      discipline: "rn",
      bodyText: "pain 3/10",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      discipline: "rn",
      patientId: P_CLEAR,
      bodyText: "pain 3/10",
      bodyWithheld: false,
      authorMembershipId: RN,
      authorName: "Rita RN",
      version: 0,
    });
    await app.close();
  });

  it("refuses another discipline (403) and an ABSENT attendee (403); a coordinator may write any", async () => {
    const app = await makeServer(false);
    expect((await post(app, RN, { discipline: "msw", bodyText: "x" })).statusCode).toBe(403);
    expect((await post(app, MSW, { discipline: "msw", bodyText: "x" })).statusCode).toBe(403);
    expect((await post(app, COORD, { discipline: "msw", bodyText: "x" })).statusCode).toBe(201);
    await app.close();
  });

  it("a read-only caller (idg.read, no attend/coordinate) is refused at the RBAC gate (403)", async () => {
    const app = await makeServer(false);
    expect((await post(app, READER, { discipline: "rn", bodyText: "x" })).statusCode).toBe(403);
    await app.close();
  });

  it("the location ABAC is NOT weakened: a caller outside the meeting's location is denied", async () => {
    const app = await makeServer(false);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
      headers: hdr(COORD, { "x-test-locations": OTHER_LOC }),
      payload: { discipline: "rn", bodyText: "x" },
    });
    expect([403, 404]).toContain(res.statusCode);
    await app.close();
  });

  it("only a live meeting takes notes (422 MEETING_NOT_LIVE) and the patient must be on the agenda (422)", async () => {
    const app = await makeServer(false);
    const idle = await post(app, COORD, { discipline: "rn", bodyText: "x" }, IDLE);
    expect(idle.statusCode).toBe(422);
    expect(idle.json().error?.code ?? idle.json().code).toBe("MEETING_NOT_LIVE");
    const off = await post(app, COORD, { patientId: P_OFF, discipline: "rn", bodyText: "x" });
    expect(off.statusCode).toBe(422);
    await app.close();
  });

  it("validates the body (empty / whitespace-only / oversized => 422) and requires Idempotency-Key (400)", async () => {
    const app = await makeServer(false);
    expect((await post(app, COORD, { discipline: "rn", bodyText: "" })).statusCode).toBe(422);
    expect((await post(app, COORD, { discipline: "rn", bodyText: "   " })).statusCode).toBe(422);
    expect(
      (await post(app, COORD, { discipline: "rn", bodyText: "a".repeat(4001) })).statusCode,
    ).toBe(422);
    const noKey = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
      headers: { ...hdr(COORD), "idempotency-key": "" },
      payload: { discipline: "rn", bodyText: "x" },
    });
    expect(noKey.statusCode).toBe(400);
    await app.close();
  });
});

describe("M14 discipline notes — PATCH (If-Match, author rule)", () => {
  it("428 without If-Match, 412 on a stale version, 200 + version bump on the right one", async () => {
    const app = await makeServer(false);
    const created = (await post(app, RN, { discipline: "rn", bodyText: "v0" })).json();
    const patch = (ifMatch: string | undefined, user = RN) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/idg/discipline-notes/${created.id}`,
        headers: { ...hdr(user), ...(ifMatch === undefined ? {} : { "if-match": ifMatch }) },
        payload: { bodyText: "v1" },
      });
    expect((await patch(undefined)).statusCode).toBe(428);
    expect((await patch("7")).statusCode).toBe(412);
    const ok = await patch('"0"');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ bodyText: "v1", version: 1, authorName: "Rita RN" });
    // another discipline's non-coordinator is refused; a coordinator may edit any note
    expect((await patch("1", MSW)).statusCode).toBe(403);
    expect((await patch("1", COORD)).statusCode).toBe(200);
    await app.close();
  });

  it("an unknown note id is a 404", async () => {
    const app = await makeServer(false);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/idg/discipline-notes/99999999-9999-4999-8999-999999999999",
      headers: { ...hdr(COORD), "if-match": "0" },
      payload: { bodyText: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("M14 discipline notes — GET and 42 CFR Part 2", () => {
  async function seed(app: Awaited<ReturnType<typeof makeServer>>) {
    await post(app, COORD, { patientId: P_CLEAR, discipline: "rn", bodyText: "clear note" });
    await post(app, COORD, { patientId: P_SUD, discipline: "msw", bodyText: "SUD detail" });
    await post(app, COORD, { discipline: "rn", bodyText: "meeting level" });
  }
  const get = (app: Awaited<ReturnType<typeof makeServer>>, q = "") =>
    app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes${q}`,
      headers: hdr(READER),
    });

  it("WITHOUT a Part 2 release the SUD patient's text is withheld (metadata stays); others show", async () => {
    const app = await makeServer(false);
    await seed(app);
    const notes = (await get(app)).json() as Array<{
      patientId: string | null;
      bodyText: string | null;
      bodyWithheld: boolean;
    }>;
    expect(notes).toHaveLength(3);
    const sud = notes.find((n) => n.patientId === P_SUD);
    expect(sud).toMatchObject({ bodyText: null, bodyWithheld: true });
    expect(JSON.stringify(notes)).not.toContain("SUD detail");
    expect(notes.find((n) => n.patientId === P_CLEAR)?.bodyText).toBe("clear note");
    expect(notes.find((n) => n.patientId === null)?.bodyText).toBe("meeting level");
    await app.close();
  });

  it("WITH a release the text is returned; ?patientId filters", async () => {
    const app = await makeServer(true);
    await seed(app);
    const notes = (await get(app, `?patientId=${P_SUD}`)).json();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ bodyText: "SUD detail", bodyWithheld: false });
    await app.close();
  });
});

describe("M14 discipline notes — late addenda (post-adjournment)", () => {
  const adjournedServer = async (sud = false) => {
    const app = await makeServer(sud);
    // a live note first (frozen into the snapshot), then adjourn at the clock's current time
    await post(app, RN, { patientId: P_CLEAR, discipline: "rn", bodyText: "original" });
    await lastBackend.adjournMeeting(ORG, COORD, MTG, true);
    return app;
  };
  const late = (
    app: Awaited<ReturnType<typeof makeServer>>,
    user: string,
    payload: Record<string, unknown>,
    meeting = MTG,
  ) => post(app, user, payload, meeting);
  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;

  it("the window constant is a typed 14-day default", () => {
    expect(DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS).toBe(14);
  });

  it("adjourned + in window + reason => 201 addendum (isAddendum, addendumRecordedAt = server now, reason)", async () => {
    const app = await adjournedServer();
    clock.iso = new Date(Date.parse("2026-06-22T15:00:00.000Z") + 3 * DAY_MS).toISOString();
    const res = await late(app, RN, {
      patientId: P_CLEAR,
      discipline: "rn",
      bodyText: "forgot vitals",
      reason: "  missed at the meeting  ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      isAddendum: true,
      addendumRecordedAt: clock.iso,
      createdAt: clock.iso,
      reason: "missed at the meeting",
      bodyText: "forgot vitals",
      version: 0,
    });
    await app.close();
  });

  it("the reason is REQUIRED for an addendum (missing / blank / null => 422) and >500 chars is refused", async () => {
    const app = await adjournedServer();
    for (const body of [
      { discipline: "rn", bodyText: "x" },
      { discipline: "rn", bodyText: "x", reason: "   " },
      { discipline: "rn", bodyText: "x", reason: null },
    ]) {
      const res = await late(app, COORD, body);
      expect(res.statusCode).toBe(422);
      expect(code(res)).toBe("ADDENDUM_REASON_REQUIRED");
    }
    const long = await late(app, COORD, {
      discipline: "rn",
      bodyText: "x",
      reason: "r".repeat(501),
    });
    expect(long.statusCode).toBe(422);
    await app.close();
  });

  it("a reason on a LIVE meeting is OPTIONAL context: kept when given, blank/whitespace/null => absent", async () => {
    const app = await makeServer(false);
    const withReason = await post(app, COORD, {
      discipline: "rn",
      bodyText: "x",
      reason: "  why  ",
    });
    expect(withReason.statusCode).toBe(201);
    expect(withReason.json()).toMatchObject({
      isAddendum: false,
      addendumRecordedAt: null,
      reason: "why",
    });
    for (const reason of ["", "   ", null, undefined]) {
      const ok = await post(app, COORD, { discipline: "rn", bodyText: "x", reason });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({
        isAddendum: false,
        addendumRecordedAt: null,
        reason: null,
      });
    }
    const tooLong = await post(app, COORD, {
      discipline: "rn",
      bodyText: "x",
      reason: "r".repeat(501),
    });
    expect(tooLong.statusCode).toBe(422);
    await app.close();
  });

  it("PATCH may edit the reason (and/or text) of a live original; null/blank clears it; empty body refused", async () => {
    const app = await makeServer(false);
    const created = (
      await post(app, RN, { discipline: "rn", bodyText: "v0", reason: "first" })
    ).json();
    const patch = (ifMatch: string, payload: unknown) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/idg/discipline-notes/${created.id}`,
        headers: { ...hdr(RN), "if-match": ifMatch },
        payload: payload as object,
      });
    const r1 = await patch("0", { reason: "second" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ bodyText: "v0", reason: "second", version: 1 });
    const r2 = await patch("1", { bodyText: "v2", reason: "third" });
    expect(r2.json()).toMatchObject({ bodyText: "v2", reason: "third", version: 2 });
    const r3 = await patch("2", { reason: "   " });
    expect(r3.json()).toMatchObject({ bodyText: "v2", reason: null, version: 3 });
    expect((await patch("3", {})).statusCode).toBe(422);
    expect((await patch("3", { reason: "r".repeat(501) })).statusCode).toBe(422);
    await app.close();
  });

  it("an original note's reason is withheld with its body under Part 2 (list)", async () => {
    const app = await makeServer(false);
    await post(app, COORD, {
      patientId: P_SUD,
      discipline: "msw",
      bodyText: "B",
      reason: "SUD-ORIG-REASON",
    });
    await post(app, COORD, {
      patientId: P_CLEAR,
      discipline: "rn",
      bodyText: "C",
      reason: "clear reason",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
      headers: hdr(READER),
    });
    expect(res.body).not.toContain("SUD-ORIG-REASON");
    const notes = res.json() as Array<{ patientId: string; reason: string | null }>;
    expect(notes.find((n) => n.patientId === P_SUD)?.reason).toBeNull();
    expect(notes.find((n) => n.patientId === P_CLEAR)?.reason).toBe("clear reason");
    await app.close();
  });

  it("WINDOW B: a patient-scoped addendum is refused once a NEWER adjourned IDG included the patient; meeting-level and other patients still work", async () => {
    const app = await adjournedServer();
    // the newer IDG (includes P_CLEAR only) is adjourned LATER
    clock.iso = new Date(Date.parse("2026-06-22T15:00:00.000Z") + 2 * DAY_MS).toISOString();
    const minutesBefore = (
      await app.inject({
        method: "GET",
        url: `/api/v1/idg/meetings/${MTG}/minutes`,
        headers: hdr(READER),
      })
    ).json();
    expect(minutesBefore.addendumState).toMatchObject({
      open: true,
      closedReason: null,
      supersededPatientIds: [],
    });
    await lastBackend.adjournMeeting(ORG, COORD, NEWER, true);
    const superseded = await late(app, COORD, {
      patientId: P_CLEAR,
      discipline: "rn",
      bodyText: "x",
      reason: "r",
    });
    expect(superseded.statusCode).toBe(422);
    expect(code(superseded)).toBe("ADDENDUM_SUPERSEDED_BY_NEWER_IDG");
    // P_SUD was not in the newer meeting => still open; meeting-level keeps the 14-day rule only
    expect(
      (await late(app, COORD, { patientId: P_SUD, discipline: "msw", bodyText: "x", reason: "r" }))
        .statusCode,
    ).toBe(201);
    expect(
      (await late(app, COORD, { discipline: "rn", bodyText: "x", reason: "r" })).statusCode,
    ).toBe(201);
    const minutes = (
      await app.inject({
        method: "GET",
        url: `/api/v1/idg/meetings/${MTG}/minutes`,
        headers: hdr(READER),
      })
    ).json();
    expect(minutes.addendumState).toMatchObject({
      open: true,
      closedReason: null,
      supersededPatientIds: [P_CLEAR],
    });
    expect(minutes.addendumState.closesAt).toBe(
      new Date(Date.parse("2026-06-22T15:00:00.000Z") + 14 * DAY_MS).toISOString(),
    );
    // past the window the whole thing is closed for time
    clock.iso = new Date(Date.parse("2026-06-22T15:00:00.000Z") + 15 * DAY_MS).toISOString();
    const closed = (
      await app.inject({
        method: "GET",
        url: `/api/v1/idg/meetings/${MTG}/minutes`,
        headers: hdr(READER),
      })
    ).json();
    expect(closed.addendumState).toMatchObject({
      open: false,
      closedReason: "window_elapsed",
      supersededPatientIds: [],
    });
    await app.close();
  });

  it("an EARLIER adjourned IDG (or a live one) does not supersede", async () => {
    const app = await adjournedServer();
    // NEWER stays live: not adjourned => no supersession
    expect(
      (await late(app, COORD, { patientId: P_CLEAR, discipline: "rn", bodyText: "x", reason: "r" }))
        .statusCode,
    ).toBe(201);
    await app.close();
  });

  it("addendum without a reason is still ADDENDUM_REASON_REQUIRED (window/superseded checked first)", async () => {
    const app = await adjournedServer();
    const res = await late(app, COORD, { discipline: "rn", bodyText: "x" });
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("ADDENDUM_REASON_REQUIRED");
    await app.close();
  });

  it("window boundary: exactly 14 days is accepted, 14 days + 1ms is ADDENDUM_WINDOW_CLOSED", async () => {
    const app = await adjournedServer();
    const at = Date.parse("2026-06-22T15:00:00.000Z");
    clock.iso = new Date(at + 14 * DAY_MS).toISOString();
    expect(
      (await late(app, COORD, { discipline: "rn", bodyText: "x", reason: "r" })).statusCode,
    ).toBe(201);
    clock.iso = new Date(at + 14 * DAY_MS + 1).toISOString();
    const closed = await late(app, COORD, { discipline: "rn", bodyText: "x", reason: "r" });
    expect(closed.statusCode).toBe(422);
    expect(code(closed)).toBe("ADDENDUM_WINDOW_CLOSED");
    await app.close();
  });

  it("scheduled/idle and cancelled meetings still refuse with MEETING_NOT_LIVE (no addendum path)", async () => {
    const app = await makeServer(false);
    for (const id of [IDLE, CANCELLED]) {
      const res = await late(app, COORD, { discipline: "rn", bodyText: "x", reason: "r" }, id);
      expect(res.statusCode).toBe(422);
      expect(code(res)).toBe("MEETING_NOT_LIVE");
    }
    await app.close();
  });

  it("authorization is unchanged: absent/other-discipline attendee 403, coordinator any, reader 403, patient must be on the agenda", async () => {
    const app = await adjournedServer();
    const b = { discipline: "msw", bodyText: "x", reason: "r" };
    expect((await late(app, MSW, b)).statusCode).toBe(403); // absent msw
    expect((await late(app, RN, b)).statusCode).toBe(403); // rn for msw
    expect((await late(app, READER, { ...b, discipline: "rn" })).statusCode).toBe(403);
    expect((await late(app, COORD, b)).statusCode).toBe(201);
    const off = await late(app, COORD, { ...b, patientId: P_OFF });
    expect(off.statusCode).toBe(422);
    const wrongLoc = await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
      headers: hdr(COORD, { "x-test-locations": OTHER_LOC }),
      payload: b,
    });
    expect([403, 404]).toContain(wrongLoc.statusCode);
    await app.close();
  });

  it("PATCH: an addendum is append-only (ADDENDUM_IMMUTABLE); an original of an adjourned meeting stays frozen (MEETING_NOT_LIVE)", async () => {
    const app = await adjournedServer();
    const orig = (
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
          headers: hdr(READER),
        })
      ).json() as Array<{ id: string }>
    )[0]!;
    const add = (await late(app, COORD, { discipline: "rn", bodyText: "x", reason: "r" })).json();
    const patch = (id: string, v: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/idg/discipline-notes/${id}`,
        headers: { ...hdr(COORD), "if-match": v },
        payload: { bodyText: "changed" },
      });
    const a = await patch(add.id, "0");
    expect(a.statusCode).toBe(422);
    expect(code(a)).toBe("ADDENDUM_IMMUTABLE");
    const o = await patch(orig.id, "0");
    expect(o.statusCode).toBe(422);
    expect(code(o)).toBe("MEETING_NOT_LIVE");
    await app.close();
  });

  it("the frozen minutes are untouched: disciplineNoteCount stays, disciplineAddendumCount is LIVE, GET shows both", async () => {
    const app = await adjournedServer();
    const minutes = () => lastBackend.getMinutes(ORG, MTG);
    const before = await minutes();
    expect(before).toMatchObject({ disciplineNoteCount: 1, disciplineAddendumCount: 0 });
    await late(app, COORD, { discipline: "rn", bodyText: "a1", reason: "r" });
    await late(app, COORD, { discipline: "msw", bodyText: "a2", reason: "r" });
    const after = await minutes();
    expect(after).toMatchObject({ disciplineNoteCount: 1, disciplineAddendumCount: 2 });
    expect(after.status).toBe("final");
    expect(after.finalizedAt).toBe(before.finalizedAt);
    const list = (
      await app.inject({
        method: "GET",
        url: `/api/v1/idg/meetings/${MTG}/discipline-notes`,
        headers: hdr(READER),
      })
    ).json() as Array<{ isAddendum: boolean }>;
    expect(list.map((n) => n.isAddendum)).toEqual([false, true, true]);
    // each addendum recorded `m14.discipline_note.addendum_recorded` (M22 appends a minutes version); the
    // live original note and the adjournment itself never do.
    const addendumEvents = lastBackend
      .drainEvents()
      .filter((e) => e.eventName === "m14.discipline_note.addendum_recorded");
    expect(addendumEvents.map((e) => e.payload.addendumCount)).toEqual([1, 2]);
    expect(addendumEvents[0]?.payload).toMatchObject({ minutesId: after.id, meetingId: MTG });
    await app.close();
  });

  it("42 CFR Part 2: an addendum on a SUD patient withholds BOTH bodyText and reason without a release", async () => {
    const app = await adjournedServer(false);
    await late(app, COORD, {
      patientId: P_SUD,
      discipline: "msw",
      bodyText: "SUD-BODY",
      reason: "SUD-REASON",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/discipline-notes?patientId=${P_SUD}`,
      headers: hdr(READER),
    });
    const [n] = res.json() as Array<Record<string, unknown>>;
    expect(n).toMatchObject({ isAddendum: true, bodyText: null, reason: null, bodyWithheld: true });
    expect(res.body).not.toContain("SUD-BODY");
    expect(res.body).not.toContain("SUD-REASON");
    await app.close();
  });
});
