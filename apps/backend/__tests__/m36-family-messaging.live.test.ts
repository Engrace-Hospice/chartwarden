/**
 * M36 ADR-0099 (PROPOSED), WP 6.7 - family / caregiver messaging without an app (migrations 1230 and 1231), LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the real routes (fastify inject), the real services and the real catalog-validating outbox publisher.
 *
 *   1. FLAG        off => create and EVERY contact route are the neutral 404; list, revoke and block still work. A deployment without the code pepper /
 *                  trusted proxies mounts no contact route and creating answers 503.
 *   2. ACCESS      a role without the key is 403; no step-up is 403; a permission holder who is not on the care team gets the 404 of an unknown patient;
 *                  no 24-hour number is a 409; no consent, no link (one reason code per cause).
 *   3. SECRETS     hashes only, the code under the pepper, single-use link, five wrong codes lock for good, a reissue is a NEW link that kills the old one.
 *   4. FLOW        redeem -> verify (bearer rotates) -> send -> read; staff lane, thread, reply, "received by the care team" only after a staff read.
 *   5. SCOPE       the contact reads ONLY its own thread (care_team content, another contact's thread and another tenant's are unreachable); system, urgent,
 *                  deleted and redacted lines are never shown; enumeration answers byte-identical 404s.
 *   6. ELIGIBILITY consent withdrawal, ended involvement, Part 2, discharge, block, death with and without the bereavement plan - each the contact's NEXT request.
 *   7. DOORS       the family conversation is written only through its two doors; the generic routes and the sidebar never expose it to a non-team member.
 *   8. TENANCY     another organisation's staff sees nothing; a bearer under another organisation matches nothing; RLS on all five tables.
 *   9. TRAIL       every read and send leaves a row the database refuses for a dead invitation; audit rows omit hashes, ids of the person and any text.
 *  10. BUDGETS     10/h, 40/d, the unanswered cap; two concurrent first sends make ONE conversation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:family-messaging:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (max_locks_per_transaction=4096): the suite resets the public schema and the chartwarden_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createPredicateRegistry, registerAbacRegistry } from "@chartwarden/auth";
import {
  FAMILY_MESSAGING_FLAG_KEY,
  FAMILY_NOTIFICATION_TEXT,
  FAMILY_SEND_PER_DAY,
  FAMILY_SEND_PER_HOUR,
  FAMILY_THREAD_UNANSWERED_CAP,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { buildFamilyServices } from "../src/modules/36-messaging/family/family-binding";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerFamilyRoutes } from "../src/modules/36-messaging/routes/family-routes";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  CHANNEL_VISIBILITY_READ_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import {
  type LiveKit,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a990001";
const ORG_B = "22222222-2222-4222-8222-22220a990002";
const STAFF = "/api/v1/messaging/family";
const CONTACT = "/api/v1/messaging/family-contact";
const MANAGE_KEYS = ["messaging.read", "messaging.family.manage", "messaging.family.respond"];
const RESPOND_KEYS = ["messaging.read", "messaging.family.respond", "messaging.send"];
const PEPPER = "pepper-for-the-live-suite-0123456789abcdef";
const MARKER = `FAMILY-MARKER-${randomUUID().replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)] ?? "x")}`;

type Row = Record<string, unknown>;
const shape = (body: string): string =>
  body.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID");

interface Fixture {
  readonly org: string;
  readonly patient: string;
  readonly caregiver: string;
  readonly pc: string;
}
interface Invited {
  readonly fixture: Fixture;
  readonly contactId: string;
  readonly token: string;
  readonly code: string;
  readonly org: string;
}

describe.skipIf(!DB_URL)("M36 ADR-0099 family messaging - LIVE Postgres", () => {
  let kit: LiveKit;
  let on: FastifyInstance;
  let off: FastifyInstance;
  let unavailable: FastifyInstance;
  let stepUpFresh = true;
  let flagOn = true;
  let bucket = 1_000_000;
  const roster = new Map<string, string[]>();
  const part2Denied = new Set<string>();
  const KEK = randomBytes(32);
  const bodyCipher = createMessageBodyCipher({ kek: KEK, sealScheme: "legacy" });
  let route: ReturnType<typeof createDbMessagingRouteService>;
  let nurse: string;
  let plain: string;
  let outsiderMgr: string;
  let mgrSeq = 0;

  const q = (sql: string, p: unknown[] = []) => kit.one<Row>(sql, p);
  const limiter = { consume: async () => ({ allowed: --bucket >= 0 }) };

  const mkServer = (flag: boolean, access = true): FastifyInstance => {
    const services = buildFamilyServices(kit.handle.db, {
      flags: { forOrg: async () => ({ [FAMILY_MESSAGING_FLAG_KEY]: flag && flagOn }) },
      outbox: catalogOutbox() as never,
      accessAvailable: access,
      pepper: PEPPER,
      cipher: bodyCipher,
      careTeamMembers: async (_org, patientId) => roster.get(patientId) ?? [],
      part2Gate: {
        allowedUserIds: async ({ patientId, userIds }) =>
          new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
      },
      redeemIpLimiter: limiter,
      verifyIpLimiter: limiter,
      bearerIpLimiter: limiter,
      readLimiter: limiter,
    });
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerFamilyRoutes(server, { ...services, contactRoutes: access });
    registerMessagingRoutes(server, {
      service: route,
      announcements: createDbAnnouncementService(kit.handle.db),
    });
    return server;
  };

  const staff = (
    server: FastifyInstance,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    user: string,
    payload?: unknown,
    org = ORG_A,
  ) =>
    server.inject({
      method,
      url,
      headers: as(user, org),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const contact = (
    server: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    bearer?: string,
    payload?: unknown,
  ) =>
    server.inject({
      method,
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  // ── M5 / M39 fixtures (setup only: the superuser seeds what other modules own) ──────────────────────────────────────────────────────
  const newManager = (org = ORG_A) => kit.seedUser(`mgr${++mgrSeq}`, org, MANAGE_KEYS);
  const mkFixture = async (
    over: {
      org?: string;
      status?: string;
      consent?: boolean | "survives_death";
      involvementTo?: string | null;
      sud?: boolean;
      lr?: boolean;
      language?: string | null;
    } = {},
  ): Promise<Fixture> => {
    const org = over.org ?? ORG_A;
    const patient = (
      await q(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status, deceased_date)
         VALUES ($1,$2,'Pat','Ient','1940-01-01','F',$3::patient_status, CASE WHEN $3 = 'deceased' THEN current_date END) RETURNING id`,
        [org, `M${randomUUID().slice(0, 8)}`, over.status ?? "active"],
      )
    )[0]!.id as string;

    const caregiver = (
      await q(
        `INSERT INTO caregiver (organization_id, first_name, last_name, preferred_language_code) VALUES ($1,'Dana','Daughter',$2) RETURNING id`,
        [org, over.language === undefined ? "es" : over.language],
      )
    )[0]!.id as string;
    const pc = (
      await q(
        `INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, involvement_from, involvement_to,
                                        is_legal_representative, lr_authority)
         VALUES ($1,$2,$3,'child', current_date - 30, $4, false, 'none') RETURNING id`,
        [patient, caregiver, org, over.involvementTo ?? null],
      )
    )[0]!.id as string;
    if (over.consent !== false) {
      await grantConsent(org, patient, caregiver, over.consent === "survives_death");
    }
    if (over.sud) {
      await q(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,ARRAY['sud'])`,
        [patient, org],
      );
    }
    return { org, patient, caregiver, pc };
  };
  const grantConsent = async (
    org: string,
    patient: string,
    caregiver: string,
    survivesDeath = false,
  ) => {
    const by = await kit.seedUser("consenter", org, []);
    const record = (
      await q(
        `INSERT INTO consent_record (organization_id, patient_id, type_key, scope_descriptor, grantor_kind, effective_at, status, signed_at, signed_by_id,
                                     capture_method, capture_evidence_jsonb, created_by_id, survives_death)
         VALUES ($1,$2,'family_caregiver_access','{}'::jsonb,'patient_self', now() - interval '1 day','active', now(), $3,
                 'electronic_portal_signature','{}'::jsonb,$3,$4) RETURNING id`,
        [org, patient, by, survivesDeath],
      )
    )[0]!.id as string;
    const recipient = (
      await q(
        `INSERT INTO consent_record_recipient (organization_id, consent_record_id, recipient_kind, recipient_entity_id, recipient_resolved_display_name, added_by_id)
         VALUES ($1,$2,'family_member',$3,'Dana Daughter',$4) RETURNING id`,
        [org, record, caregiver, by],
      )
    )[0]!.id as string;
    await q(
      `INSERT INTO delegated_access (organization_id, patient_id, consent_record_id, consent_record_recipient_id, delegate_caregiver_id, scope_kind,
                                     effective_from, portal_session_class)
       VALUES ($1,$2,$3,$4,$5,'view_and_message', now() - interval '1 day','caregiver_portal')`,
      [org, patient, record, recipient, caregiver],
    );
  };
  const setAgency = async (user: string, org = ORG_A) => {
    const res = await staff(
      on,
      "PUT",
      `${STAFF}/settings`,
      user,
      { agencyName: "Riverside Care", agencyPhone: "555-0100", bereavementPhone: "555-0199" },
      org,
    );
    expect(res.statusCode, res.body).toBe(200);
  };
  /** Frees the per-day caps between groups (setup only: the guard forbids the app role to move created_at). */
  const freeCaps = async () => {
    await kit.admin.query(
      "ALTER TABLE message_family_invitation DISABLE TRIGGER trg_message_family_invitation_guard",
    );
    try {
      await kit.admin.query(
        "UPDATE message_family_invitation SET created_at = created_at - interval '3 days', expires_at = expires_at - interval '3 days' WHERE created_at > now() - interval '2 days'",
      );
    } finally {
      await kit.admin.query(
        "ALTER TABLE message_family_invitation ENABLE TRIGGER trg_message_family_invitation_guard",
      );
    }
  };

  /** Invite through the real route as a fresh manager who is on the patient's care team. */
  const invite = async (
    fixture: Fixture,
    server = on,
    over: Record<string, unknown> = {},
  ): Promise<Invited> => {
    stepUpFresh = true;
    const mgr = await newManager(fixture.org);
    roster.set(fixture.patient, [...(roster.get(fixture.patient) ?? []), mgr, nurse]);
    const res = await staff(
      server,
      "POST",
      `${STAFF}/invitations`,
      mgr,
      {
        patientId: fixture.patient,
        patientCaregiverId: fixture.pc,
        codeByVoiceConfirmed: true,
        ...over,
      },
      fixture.org,
    );
    expect(res.statusCode, res.body).toBe(201);
    const j = res.json();
    return {
      fixture,
      contactId: j.contactId,
      token: j.inviteToken,
      code: j.verificationCode,
      org: j.organizationId,
    };
  };
  const redeem = (inv: Invited, server = on, org = inv.org, token = inv.token) =>
    contact(server, "POST", `${CONTACT}/redeem`, undefined, { organizationId: org, token });
  /** redeem + verify => an ACTIVE bearer. */
  const activate = async (inv: Invited, server = on): Promise<string> => {
    const r = await redeem(inv, server);
    expect(r.statusCode, r.body).toBe(200);
    const enrolment = r.json().sessionToken as string;
    const v = await contact(server, "POST", `${CONTACT}/verify`, enrolment, { code: inv.code });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().stage).toBe("active");
    expect(v.json().sessionToken).not.toBe(enrolment);
    return v.json().sessionToken as string;
  };
  const send = (bearer: string, body: unknown, server = on) =>
    contact(server, "POST", `${CONTACT}/messages`, bearer, { body });
  const read = (bearer: string, query = "", server = on) =>
    contact(server, "GET", `${CONTACT}/messages${query}`, bearer);
  const texts = (res: { json(): { messages: Array<{ body: string }> } }) =>
    res.json().messages.map((m) => m.body);
  const reasonOf = (res: {
    json(): { details?: Array<{ code: string }>; error?: { details?: Array<{ code: string }> } };
  }) => (res.json().details ?? res.json().error?.details)?.[0]?.code;

  beforeEach(async () => {
    await freeCaps();
  });

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr99");
    route = createDbMessagingRouteService(kit.handle.db, {
      kek: KEK,
      outbox: catalogOutbox() as never,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
    });
    // The roster the generic visibility rule reads for a `family` channel (the same seam the care-team channel uses).
    registerSeam("CareTeamProvider", {
      careTeamMembers: async ({ patientId }: { patientId: string }) => roster.get(patientId) ?? [],
    } as never);
    const registry = createPredicateRegistry();
    registry.register("step_up_recent", async () => stepUpFresh);
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return route.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return route.canReadChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    // M39 reference data (platform-shared): the consent type the contact's eligibility names.
    await kit.admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator, capture_method_floor, reminder_cadence_floor, revocation_cascade_kind,
                                         is_per_recipient, is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
                                         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES ('family_caregiver_access','Family caregiver access','categorical',ARRAY[]::text[],ARRAY[]::text[],'none',true,false,true,false,false,false,'x','v1'),
              ('dpoa_healthcare','DPOA','categorical',ARRAY[]::text[],ARRAY[]::text[],'none',false,true,true,false,false,false,'x','v1')
       ON CONFLICT DO NOTHING`,
    );
    nurse = await kit.seedUser("nurse", ORG_A, RESPOND_KEYS);
    plain = await kit.seedUser("plain", ORG_A, ["messaging.read"]);
    outsiderMgr = await kit.seedUser("outsider", ORG_B, MANAGE_KEYS);
    on = mkServer(true);
    off = mkServer(false);
    unavailable = mkServer(true, false);
    await Promise.all([on.ready(), off.ready(), unavailable.ready()]);
    await setAgency(await newManager());
  }, 180_000);

  afterAll(async () => {
    await Promise.all([on?.close(), off?.close(), unavailable?.close()]);
    await kit?.close();
  });

  // ── 1 + 2: flag, availability and access ───────────────────────────────────────────────────────────────────────────────────────────
  describe("flag, availability and access", () => {
    it("flag off => create is the neutral 404 before any step-up, nothing is written; list still works", async () => {
      const fx = await mkFixture();
      const mgr = await newManager();
      roster.set(fx.patient, [mgr]);
      stepUpFresh = false;
      const res = await staff(off, "POST", `${STAFF}/invitations`, mgr, {
        patientId: fx.patient,
        patientCaregiverId: fx.pc,
        codeByVoiceConfirmed: true,
      });
      expect(res.statusCode).toBe(404);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_family_contact WHERE patient_id=$1",
          [fx.patient],
        ),
      ).toBe(0);
      stepUpFresh = true;
      expect((await staff(off, "GET", `${STAFF}/contacts`, plain)).statusCode).toBe(403);
      expect((await staff(off, "GET", `${STAFF}/contacts`, nurse)).statusCode).toBe(200);
    });

    it("flag off => every contact route is the neutral 404, even for a once-valid link", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      flagOn = false;
      try {
        const bodies = new Set<string>();
        for (const res of await Promise.all([
          redeem(inv),
          contact(on, "GET", `${CONTACT}/state`, bearer),
          contact(on, "POST", `${CONTACT}/verify`, bearer, { code: inv.code }),
          read(bearer),
          send(bearer, "hello"),
        ])) {
          expect(res.statusCode).toBe(404);
          bodies.add(shape(res.body));
        }
        expect(bodies.size).toBe(1);
      } finally {
        flagOn = true;
      }
      expect((await read(bearer)).statusCode).toBe(200);
    });

    it("a deployment without trusted proxies / the pepper mounts no contact route and creating answers 503", async () => {
      const fx = await mkFixture();
      const mgr = await newManager();
      roster.set(fx.patient, [mgr]);
      const create = await staff(unavailable, "POST", `${STAFF}/invitations`, mgr, {
        patientId: fx.patient,
        patientCaregiverId: fx.pc,
        codeByVoiceConfirmed: true,
      });
      expect(create.statusCode).toBe(503);
      expect(errorCode(create)).toBe("FAMILY_ACCESS_UNAVAILABLE");
      expect(
        (await redeem({ org: ORG_A, token: "A".repeat(43) } as Invited, unavailable)).statusCode,
      ).toBe(404);
      // Staff list, revoke and block remain mounted.
      expect((await staff(unavailable, "GET", `${STAFF}/contacts`, nurse)).statusCode).toBe(200);
    });

    it("a role without the key is 403; no fresh step-up is 403; the write is not made", async () => {
      const fx = await mkFixture();
      const body = { patientId: fx.patient, patientCaregiverId: fx.pc, codeByVoiceConfirmed: true };
      expect((await staff(on, "POST", `${STAFF}/invitations`, plain, body)).statusCode).toBe(403);
      expect((await staff(on, "POST", `${STAFF}/invitations`, nurse, body)).statusCode).toBe(403);
      const mgr = await newManager();
      roster.set(fx.patient, [mgr]);
      stepUpFresh = false;
      expect((await staff(on, "POST", `${STAFF}/invitations`, mgr, body)).statusCode).toBe(403);
      stepUpFresh = true;
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_family_contact WHERE patient_id=$1",
          [fx.patient],
        ),
      ).toBe(0);
    });

    it("a manager who is not on the patient's care team gets the 404 of an unknown patient, byte-identical to a random patient", async () => {
      const fx = await mkFixture();
      const mgr = await newManager();
      const real = await staff(on, "POST", `${STAFF}/invitations`, mgr, {
        patientId: fx.patient,
        patientCaregiverId: fx.pc,
        codeByVoiceConfirmed: true,
      });
      const random = await staff(on, "POST", `${STAFF}/invitations`, mgr, {
        patientId: randomUUID(),
        patientCaregiverId: randomUUID(),
        codeByVoiceConfirmed: true,
      });
      expect(real.statusCode).toBe(404);
      expect(shape(real.body)).toBe(shape(random.body));
      expect(
        (await staff(on, "GET", `${STAFF}/patients/${fx.patient}/caregivers`, mgr)).statusCode,
      ).toBe(404);
    });

    it("Part 2: a manager the Part 2 gate refuses is the same 404 (the care-team predicate includes it)", async () => {
      const fx = await mkFixture();
      const mgr = await newManager();
      roster.set(fx.patient, [mgr]);
      part2Denied.add(`${mgr}:${fx.patient}`);
      const res = await staff(on, "POST", `${STAFF}/invitations`, mgr, {
        patientId: fx.patient,
        patientCaregiverId: fx.pc,
        codeByVoiceConfirmed: true,
      });
      expect(res.statusCode).toBe(404);
    });

    it("the 24-hour number is required before an invitation can exist", async () => {
      const fresh = "33333333-3333-4333-8333-333333330099";
      await kit.admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'adr99-nophone','N','N') ON CONFLICT DO NOTHING`,
        [fresh],
      );
      const fx = await mkFixture({ org: fresh });
      const mgr = await newManager(fresh);
      roster.set(fx.patient, [mgr]);
      const res = await staff(
        on,
        "POST",
        `${STAFF}/invitations`,
        mgr,
        { patientId: fx.patient, patientCaregiverId: fx.pc, codeByVoiceConfirmed: true },
        fresh,
      );
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("FAMILY_SETTINGS_MISSING");
    });

    it("no consent, no link: each cause is a 409 with its reason code and writes no invitation", async () => {
      await freeCaps();
      const cases: Array<[string, Parameters<typeof mkFixture>[0]]> = [
        ["no_consent", { consent: false }],
        ["involvement_ended", { involvementTo: "2020-01-01" }],
        ["part2_restricted", { sud: true }],
        ["patient_status", { status: "discharged" }],
        ["not_in_bereavement_plan", { status: "deceased" }],
      ];
      for (const [reason, over] of cases) {
        const fx = await mkFixture(over);
        const mgr = await newManager();
        roster.set(fx.patient, [mgr]);
        const res = await staff(on, "POST", `${STAFF}/invitations`, mgr, {
          patientId: fx.patient,
          patientCaregiverId: fx.pc,
          codeByVoiceConfirmed: true,
        });
        expect(res.statusCode, reason).toBe(409);
        expect(errorCode(res)).toBe("FAMILY_CONTACT_NOT_ELIGIBLE");
        expect(reasonOf(res as never), reason).toBe(reason);
        expect(
          await kit.count(
            "SELECT count(*)::int AS n FROM message_family_invitation i JOIN message_family_contact c ON c.id=i.contact_id WHERE c.patient_id=$1",
            [fx.patient],
          ),
        ).toBe(0);
        // The picker shows the same reason (one expression feeds both).
        const picker = await staff(on, "GET", `${STAFF}/patients/${fx.patient}/caregivers`, mgr);
        expect(picker.json().caregivers[0]).toMatchObject({ eligible: false, reason });
      }
    });

    it("an invitation needs the by-voice confirmation (422) and a sane lifetime", async () => {
      const fx = await mkFixture();
      const mgr = await newManager();
      roster.set(fx.patient, [mgr]);
      const base = { patientId: fx.patient, patientCaregiverId: fx.pc };
      expect(
        (
          await staff(on, "POST", `${STAFF}/invitations`, mgr, {
            ...base,
            codeByVoiceConfirmed: false,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await staff(on, "POST", `${STAFF}/invitations`, mgr, {
            ...base,
            codeByVoiceConfirmed: true,
            expiresInDays: 31,
          })
        ).statusCode,
      ).toBe(422);
    });
  });

  // ── 3: secrets ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("secrets", () => {
    it("only hashes are stored; the code is hashed under the pepper; the audit rows omit the hashes", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const row = (
        await q("SELECT * FROM message_family_invitation WHERE contact_id=$1", [inv.contactId])
      )[0]!;
      expect(JSON.stringify(row)).not.toContain(inv.token);
      expect(JSON.stringify(row)).not.toContain(inv.code);
      expect(String(row.code_hash)).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
      const { verifyVerificationCode } = await import(
        "../src/modules/36-messaging/external-share/external-share-secrets"
      );
      expect(verifyVerificationCode(inv.code, String(row.code_hash), PEPPER)).toBe(true);
      expect(verifyVerificationCode(inv.code, String(row.code_hash))).toBe(false);
      const audit = JSON.stringify(
        await q(
          "SELECT before, after FROM audit_event WHERE resource_kind LIKE 'message_family_%' AND organization_id=$1",
          [ORG_A],
        ),
      );
      expect(audit).not.toContain(inv.token);
      expect(audit).not.toContain(String(row.code_hash));
      expect(audit).not.toContain(String(row.invite_token_hash));
    });

    it("the link is single use", async () => {
      const inv = await invite(await mkFixture());
      expect((await redeem(inv)).statusCode).toBe(200);
      const again = await redeem(inv);
      expect(again.statusCode).toBe(404);
    });

    it("an enrolment-stage bearer reaches state and verify only: it cannot read or send", async () => {
      const inv = await invite(await mkFixture());
      const enrolment = (await redeem(inv)).json().sessionToken as string;
      expect((await contact(on, "GET", `${CONTACT}/state`, enrolment)).json().stage).toBe(
        "enrolment",
      );
      expect((await read(enrolment)).statusCode).toBe(404);
      expect((await send(enrolment, "hi")).statusCode).toBe(404);
    });

    it("five wrong codes lock the invitation for good, and the right code no longer helps", async () => {
      const inv = await invite(await mkFixture());
      const enrolment = (await redeem(inv)).json().sessionToken as string;
      const wrong = inv.code === "00000000" ? "11111111" : "00000000";
      for (let i = 0; i < 5; i += 1) {
        const res = await contact(on, "POST", `${CONTACT}/verify`, enrolment, { code: wrong });
        expect(res.statusCode, `attempt ${i + 1}`).toBe(422);
      }
      const locked = await contact(on, "POST", `${CONTACT}/verify`, enrolment, { code: inv.code });
      expect(locked.statusCode).toBe(404);
      expect(
        (
          await q("SELECT code_attempts FROM message_family_invitation WHERE contact_id=$1", [
            inv.contactId,
          ])
        )[0]!.code_attempts,
      ).toBe(5);
    });

    it("the enrolment bearer is dead once the code is proven (the bearer rotates)", async () => {
      const inv = await invite(await mkFixture());
      const enrolment = (await redeem(inv)).json().sessionToken as string;
      const active = (
        await contact(on, "POST", `${CONTACT}/verify`, enrolment, { code: inv.code })
      ).json().sessionToken as string;
      expect((await contact(on, "GET", `${CONTACT}/state`, enrolment)).statusCode).toBe(404);
      expect((await contact(on, "GET", `${CONTACT}/state`, active)).statusCode).toBe(200);
    });

    it("a reissue is a NEW link and code: the old link, its sessions and its counter are dead, and only one invitation is live", async () => {
      const fx = await mkFixture();
      const first = await invite(fx);
      const oldBearer = await activate(first);
      const second = await invite(fx);
      expect(second.contactId).toBe(first.contactId);
      expect((await contact(on, "GET", `${CONTACT}/state`, oldBearer)).statusCode).toBe(404);
      expect((await redeem(first)).statusCode).toBe(404);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_family_invitation WHERE contact_id=$1 AND revoked_at IS NULL",
          [first.contactId],
        ),
      ).toBe(1);
      expect(
        (
          await q(
            "SELECT revoke_reason FROM message_family_invitation WHERE invite_token_hash IS NOT NULL AND contact_id=$1 AND revoked_at IS NOT NULL",
            [first.contactId],
          )
        )[0]!.revoke_reason,
      ).toBe("superseded");
      expect((await activate(second).then(() => 200)) === 200).toBe(true);
    });

    it("an expired link and an idle session are the neutral 404 on the database clock", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      await kit.admin.query(
        "ALTER TABLE message_family_session DISABLE TRIGGER trg_message_family_session_guard",
      );
      await kit.admin.query(
        "UPDATE message_family_session SET last_seen_at = now() - interval '31 minutes' WHERE invitation_id IN (SELECT id FROM message_family_invitation WHERE contact_id=$1)",
        [inv.contactId],
      );
      await kit.admin.query(
        "ALTER TABLE message_family_session ENABLE TRIGGER trg_message_family_session_guard",
      );
      expect((await contact(on, "GET", `${CONTACT}/state`, bearer)).statusCode).toBe(404);
      const fresh = await invite(await mkFixture());
      await kit.admin.query(
        "ALTER TABLE message_family_invitation DISABLE TRIGGER trg_message_family_invitation_guard",
      );
      await kit.admin.query(
        "UPDATE message_family_invitation SET created_at = now() - interval '9 days', expires_at = now() - interval '1 second' WHERE contact_id=$1",
        [fresh.contactId],
      );
      await kit.admin.query(
        "ALTER TABLE message_family_invitation ENABLE TRIGGER trg_message_family_invitation_guard",
      );
      expect((await redeem(fresh)).statusCode).toBe(404);
    });
  });

  // ── 4: the flow ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("flow", () => {
    it("send -> lane -> thread -> reply -> read, with 'received' only after a staff read, and no staff identity or patient to the contact", async () => {
      await freeCaps();
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      const state = (await contact(on, "GET", `${CONTACT}/state`, bearer)).json();
      expect(state).toMatchObject({
        stage: "active",
        mode: "standard",
        agencyName: "Riverside Care",
        agencyPhone: "555-0100",
        language: "es",
        closed: false,
      });
      expect(JSON.stringify(state)).not.toMatch(/patient|Pat|Ient/);

      // The conversation does not exist until the first send (lazily created).
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM channel WHERE channel_kind='family' AND subject_id=$1",
          [fx.patient],
        ),
      ).toBe(0);
      const sent = await send(bearer, `${MARKER} is mom eating?`);
      expect(sent.statusCode, sent.body).toBe(201);
      const channel = (
        await q(
          "SELECT id, retention_class FROM channel WHERE channel_kind='family' AND subject_id=$1",
          [fx.patient],
        )
      )[0]!;
      expect(channel.retention_class).toBe("care_related");
      const stored = (
        await q("SELECT author_kind, author_user_id, body_cipher FROM message WHERE id=$1", [
          sent.json().messageId,
        ])
      )[0]!;
      expect(stored).toMatchObject({ author_kind: "family_contact", author_user_id: null });
      expect(Buffer.from(stored.body_cipher as Buffer).toString("utf8")).not.toContain(MARKER);

      // Staff: the lane shows the unanswered message to the care team and to nobody else.
      const lane = await staff(on, "GET", `${STAFF}/contacts`, nurse);
      const mine = lane.json().contacts.find((c: Row) => c.patientId === fx.patient);
      expect(mine).toMatchObject({
        displayName: "Dana Daughter",
        relationship: "child",
        consentState: "ok",
        linkState: "active",
        closed: false,
      });
      expect(mine.unansweredSince).toBeTruthy();
      expect(
        lane.json().contacts.every((c: Row) => roster.get(String(c.patientId))?.includes(nurse)),
      ).toBe(true);
      const outsider = await kit.seedUser("lane-outsider", ORG_A, RESPOND_KEYS);
      expect(
        (await staff(on, "GET", `${STAFF}/contacts`, outsider))
          .json()
          .contacts.some((c: Row) => c.patientId === fx.patient),
      ).toBe(false);
      expect(
        (await staff(on, "GET", `${STAFF}/contacts/${inv.contactId}/thread`, outsider)).statusCode,
      ).toBe(404);

      // Not yet "received".
      expect((await read(bearer)).json().messages[0]).toMatchObject({
        from: "you",
        receivedByCareTeam: false,
      });
      const thread = await staff(on, "GET", `${STAFF}/contacts/${inv.contactId}/thread`, nurse);
      expect(thread.statusCode, thread.body).toBe(200);
      expect(thread.json().messages[0]).toMatchObject({ from: "contact", authorName: null });
      expect(thread.json().messages[0].body).toContain(MARKER);
      expect((await read(bearer)).json().messages[0].receivedByCareTeam).toBe(true);

      const reply = await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reply`, nurse, {
        body: "She ate lunch today. Please call if you want more detail.",
      });
      expect(reply.statusCode, reply.body).toBe(201);
      const after = await read(bearer);
      expect(after.json().messages.map((m: Row) => m.from)).toEqual(["you", "care_team"]);
      expect(JSON.stringify(after.json())).not.toMatch(/authorName|userId|channelId|patientId/);
      // Answered: the lane no longer shows an unanswered age.
      const answered = (await staff(on, "GET", `${STAFF}/contacts`, nurse))
        .json()
        .contacts.find((c: Row) => c.patientId === fx.patient);
      expect(answered.unansweredSince).toBeNull();
      // The plain sidebar never lists it, and a family channel has no member rows.
      expect(
        await kit.count("SELECT count(*)::int AS n FROM channel_member WHERE channel_id=$1", [
          channel.id,
        ]),
      ).toBe(0);
    });

    it("a staff reply to a contact with no message yet, or to a closed thread, is a 409; close blocks the contact's send with a plain message", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      const none = await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reply`, nurse, {
        body: "hello",
      });
      expect(none.statusCode).toBe(409);
      expect((await send(bearer, "first")).statusCode).toBe(201);
      const mgr = await newManager();
      roster.set(fx.patient, [...(roster.get(fx.patient) ?? []), mgr]);
      expect(
        (await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/close`, mgr)).json().closed,
      ).toBe(true);
      const closed = await send(bearer, "second");
      expect(closed.statusCode).toBe(409);
      expect(errorCode(closed)).toBe("FAMILY_THREAD_CLOSED");
      expect(
        (await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reply`, nurse, { body: "x" }))
          .statusCode,
      ).toBe(409);
      expect((await read(bearer)).statusCode).toBe(200);
      expect(
        (await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reopen`, mgr)).json().closed,
      ).toBe(false);
      expect((await send(bearer, "third")).statusCode).toBe(201);
    });

    it("text only, 1 to 2,000 characters: bad text is a 422 and nothing is stored", async () => {
      const fx = await mkFixture();
      const bearer = await activate(await invite(fx));
      const before = await kit.count(
        "SELECT count(*)::int AS n FROM message WHERE author_kind='family_contact'",
      );
      for (const bad of ["", "   ", "x".repeat(2001), "a\u0000b", 7, null]) {
        expect((await send(bearer, bad)).statusCode, JSON.stringify(bad)).toBe(422);
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message WHERE author_kind='family_contact'",
        ),
      ).toBe(before);
      expect((await send(bearer, "y".repeat(2000))).statusCode).toBe(201);
    });

    it("a notification string is a constant with no argument", () => {
      expect(FAMILY_NOTIFICATION_TEXT).not.toMatch(/\$\{|%s|\{\{/);
      expect(FAMILY_NOTIFICATION_TEXT.length).toBeLessThan(100);
    });
  });

  // ── 5: scope and enumeration ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("scope", () => {
    it("the contact reads ONLY its own thread: care_team content, another contact's thread and system / urgent / deleted / redacted lines are unreachable", async () => {
      const fxA = await mkFixture();
      const fxB = await mkFixture();
      const invA = await invite(fxA);
      const invB = await invite(fxB);
      const bearerA = await activate(invA);
      const bearerB = await activate(invB);
      expect((await send(bearerA, `${MARKER} from A`)).statusCode).toBe(201);
      expect((await send(bearerB, `${MARKER} from B`)).statusCode).toBe(201);
      // A staff-only care_team conversation for the SAME patient, with a secret.
      const careTeam = await mkChannel(kit, "care_team", fxA.patient, [nurse]);
      const sealed = await bodyCipher.seal(ORG_A, `${MARKER} STAFF ONLY`);
      await q(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256) VALUES ($1,$2,$3,'user',$4,$5)`,
        [ORG_A, careTeam, nurse, sealed.cipher, sealed.sha256],
      );
      const familyChannel = (
        await q("SELECT id FROM channel WHERE channel_kind='family' AND subject_id=$1", [
          fxA.patient,
        ])
      )[0]!.id as string;
      const seed = async (
        text: string,
        opts: { kind?: string; status?: string; urgent?: boolean; bodyKind?: string } = {},
      ) => {
        const s = await bodyCipher.seal(ORG_A, text);
        return (
          await q(
            `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, status, deleted_at, body_kind, urgency, urgent_recipient_user_id)
             VALUES ($1,$2,$3::uuid,$4::message_author_kind,$5,$6,$7::message_status, CASE WHEN $10::boolean THEN now() END, $8::message_body_kind,
                     CASE WHEN $9::boolean THEN 'urgent'::message_urgency ELSE 'routine'::message_urgency END, CASE WHEN $9::boolean THEN $3::uuid END) RETURNING id`,
            [
              ORG_A,
              familyChannel,
              opts.kind === "system" ? null : nurse,
              opts.kind ?? "user",
              s.cipher,
              s.sha256,
              opts.status ?? "sent",
              opts.bodyKind ?? "plain",
              opts.urgent ?? false,
              opts.status === "deleted",
            ],
          )
        )[0]!.id as string;
      };
      await seed(`${MARKER} system line`, { kind: "system", bodyKind: "system" });
      await seed(`${MARKER} urgent line`, { urgent: true });
      await seed(`${MARKER} deleted line`, { status: "deleted" });
      const redacted = await seed(`${MARKER} redacted line`);
      await seed("a visible staff line");
      await kit.admin.query(
        "ALTER TABLE message_redaction DISABLE TRIGGER trg_message_redaction_guard",
      );
      await q(
        `INSERT INTO message_redaction (organization_id, message_id, requested_by, reason, approved_by, approved_at) VALUES ($1,$2,$3,'removing a clinical detail from a family line',$4,now())`,
        [ORG_A, redacted, nurse, plain],
      );
      await kit.admin.query(
        "ALTER TABLE message_redaction ENABLE TRIGGER trg_message_redaction_guard",
      );
      const seen = texts(await read(bearerA));
      expect(seen).toContain(`${MARKER} from A`);
      expect(seen).toContain("a visible staff line");
      for (const hidden of [
        "from B",
        "STAFF ONLY",
        "system line",
        "urgent line",
        "deleted line",
        "redacted line",
      ]) {
        expect(
          seen.some((t) => t.includes(hidden)),
          hidden,
        ).toBe(false);
      }
      expect(texts(await read(bearerB))).toEqual([`${MARKER} from B`]);
      // The staff thread masks the redacted body too.
      const thread = await staff(on, "GET", `${STAFF}/contacts/${invA.contactId}/thread`, nurse);
      expect(
        thread.json().messages.find((m: Row) => String(m.body).includes("redacted line")),
      ).toBeUndefined();
    });

    it("enumeration: unknown, malformed, expired, other-tenant and revoked bearers answer byte-identical 404s", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      const mgr = await newManager();
      roster.set(inv.fixture.patient, [...(roster.get(inv.fixture.patient) ?? []), mgr]);
      stepUpFresh = true;
      expect(
        (await staff(on, "DELETE", `${STAFF}/contacts/${inv.contactId}/invitation`, mgr))
          .statusCode,
      ).toBe(200);
      const attempts = [
        bearer,
        `${ORG_A}.${"A".repeat(43)}`,
        `${ORG_B}.${bearer.split(".")[1]}`,
        "not-a-bearer",
        `${randomUUID()}.${"B".repeat(43)}`,
      ];
      const shapes = new Set<string>();
      for (const b of attempts) {
        for (const res of [
          await contact(on, "GET", `${CONTACT}/state`, b),
          await read(b),
          await send(b, "x"),
          await contact(on, "POST", `${CONTACT}/verify`, b, { code: "12345678" }),
        ]) {
          expect(res.statusCode).toBe(404);
          shapes.add(shape(res.body));
        }
      }
      expect((await contact(on, "GET", `${CONTACT}/state`)).statusCode).toBe(404);
      expect((await redeem(inv)).statusCode).toBe(404);
      expect(shapes.size).toBe(1);
    });

    it("the contact never chooses a conversation: extra ids in the body or the URL change nothing", async () => {
      const a = await invite(await mkFixture());
      const b = await invite(await mkFixture());
      const bearerA = await activate(a);
      const bearerB = await activate(b);
      await send(bearerB, `${MARKER} b-only`);
      const channelB = (
        await q("SELECT channel_id FROM message_family_contact WHERE id=$1", [b.contactId])
      )[0]?.channel_id as string;
      const sent = await contact(on, "POST", `${CONTACT}/messages`, bearerA, {
        body: "mine",
        channelId: channelB,
        contactId: b.contactId,
      });
      expect(sent.statusCode).toBe(201);
      expect(texts(await read(bearerA))).toEqual(["mine"]);
      // A channel id in the query is simply ignored: A still reads only A's own thread.
      expect(
        texts(await contact(on, "GET", `${CONTACT}/messages?channelId=${channelB}`, bearerA)),
      ).toEqual(["mine"]);
      expect(
        (await contact(on, "GET", `${STAFF}/contacts/${b.contactId}/thread`, bearerA)).statusCode,
      ).toBe(401);
    });
  });

  // ── 6: eligibility is live ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("eligibility is live: the contact's NEXT request", () => {
    const gone = async (fx: Fixture, bearer: string) => {
      for (const res of [
        await contact(on, "GET", `${CONTACT}/state`, bearer),
        await read(bearer),
        await send(bearer, "x"),
      ]) {
        expect(res.statusCode).toBe(404);
      }
    };

    it("staff revoke", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      const mgr = await newManager();
      roster.set(inv.fixture.patient, [mgr]);
      expect(
        (await staff(on, "DELETE", `${STAFF}/contacts/${inv.contactId}/invitation`, mgr))
          .statusCode,
      ).toBe(200);
      await gone(inv.fixture, bearer);
      expect(
        (await staff(on, "DELETE", `${STAFF}/contacts/${inv.contactId}/invitation`, mgr))
          .statusCode,
      ).toBe(409);
      // Revoke does not depend on the flag.
      const other = await invite(await mkFixture());
      const m2 = await newManager();
      roster.set(other.fixture.patient, [m2]);
      expect(
        (await staff(off, "DELETE", `${STAFF}/contacts/${other.contactId}/invitation`, m2))
          .statusCode,
      ).toBe(200);
    });

    it("consent withdrawn (the delegated-access projection revoked, and the consent record revoked)", async () => {
      const a = await invite(await mkFixture());
      const bearerA = await activate(a);
      await q("UPDATE delegated_access SET revoked_at = now() WHERE patient_id=$1", [
        a.fixture.patient,
      ]);
      await gone(a.fixture, bearerA);
      const b = await invite(await mkFixture());
      const bearerB = await activate(b);
      await kit.admin.query("SET session_replication_role = replica");
      await kit.admin.query(
        "UPDATE consent_record SET status='revoked', revoked_at=now(), revoked_via_id=created_by_id WHERE patient_id=$1",
        [b.fixture.patient],
      );
      await kit.admin.query("SET session_replication_role = DEFAULT");
      await gone(b.fixture, bearerB);
    });

    it("involvement ended", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      await q("UPDATE patient_caregiver SET involvement_to = current_date - 1 WHERE id=$1", [
        inv.fixture.pc,
      ]);
      await gone(inv.fixture, bearer);
    });

    it("a Part 2 flag added later, or a snapshot being recomputed (fail closed)", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      await q(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,ARRAY['sud'])`,
        [inv.fixture.patient, ORG_A],
      );
      await gone(inv.fixture, bearer);
      const other = await invite(await mkFixture());
      const bearer2 = await activate(other);
      await q(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, invalidated_at) VALUES ($1,$2,ARRAY[]::text[], now())`,
        [other.fixture.patient, ORG_A],
      );
      await gone(other.fixture, bearer2);
      // The flag is lifted and the snapshot rebuilt => access returns (nothing was destroyed).
      await q(
        "UPDATE patient_privacy_flag_snapshot SET invalidated_at = NULL WHERE patient_id=$1",
        [other.fixture.patient],
      );
      expect((await contact(on, "GET", `${CONTACT}/state`, bearer2)).statusCode).toBe(200);
    });

    it("attackers on the consent join: a not-yet-started involvement, a consent record of ANOTHER patient, and a legal-representative flag alone all fail closed", async () => {
      const future = await mkFixture({ consent: true });
      await q("UPDATE patient_caregiver SET involvement_from = current_date + 5 WHERE id=$1", [
        future.pc,
      ]);
      const picker = async (fx: Fixture) => {
        const mgr = await newManager();
        roster.set(fx.patient, [mgr]);
        return (await staff(on, "GET", `${STAFF}/patients/${fx.patient}/caregivers`, mgr)).json()
          .caregivers[0];
      };
      expect(await picker(future)).toMatchObject({ eligible: false, reason: "involvement_ended" });

      const other = await mkFixture({ consent: true });
      const stranger = await mkFixture({ consent: false });
      // The projection row points at a consent record that belongs to a different patient.
      await q(
        `INSERT INTO delegated_access (organization_id, patient_id, consent_record_id, consent_record_recipient_id, delegate_caregiver_id, scope_kind, effective_from, portal_session_class)
         SELECT $1, $2, consent_record_id, consent_record_recipient_id, $3, 'view_and_message', now() - interval '1 day', 'caregiver_portal'
           FROM delegated_access WHERE patient_id = $4 LIMIT 1`,
        [ORG_A, stranger.patient, stranger.caregiver, other.patient],
      );
      expect(await picker(stranger)).toMatchObject({ eligible: false, reason: "no_consent" });

      const lr = await mkFixture({ consent: false });
      await q(
        "UPDATE patient_caregiver SET is_legal_representative = true, lr_authority = 'dpoa_healthcare', lr_proof_doc_ref = gen_random_uuid() WHERE id=$1",
        [lr.pc],
      );
      expect(await picker(lr)).toMatchObject({ eligible: false, reason: "no_consent" });
    });

    it("discharge (not a death) ends access; the patient record is untouched", async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      await q("UPDATE patient SET status='discharged' WHERE id=$1", [inv.fixture.patient]);
      await gone(inv.fixture, bearer);
    });

    it("block revokes the link, refuses a reissue, and is lifted only by a SECOND person", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      const blocker = await newManager();
      const second = await newManager();
      roster.set(fx.patient, [...(roster.get(fx.patient) ?? []), blocker, second]);
      const blocked = await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/block`, blocker);
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(blocked.json()).toMatchObject({ blocked: true, linkState: "revoked" });
      await gone(fx, bearer);
      const reissue = await staff(on, "POST", `${STAFF}/invitations`, second, {
        patientId: fx.patient,
        patientCaregiverId: fx.pc,
        codeByVoiceConfirmed: true,
      });
      expect(reissue.statusCode).toBe(409);
      expect(reasonOf(reissue as never)).toBe("blocked");
      expect(
        (await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/unblock`, blocker)).statusCode,
      ).toBe(409);
      expect(
        (await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/unblock`, second)).statusCode,
      ).toBe(200);
      const fresh = await invite(fx);
      expect((await activate(fresh)).length).toBeGreaterThan(40);
    });

    it("death WITH the person in the open bereavement plan and a surviving consent => bereavement mode, recorded once, same thread", async () => {
      const fx = await mkFixture({ consent: "survives_death" });
      const inv = await invite(fx);
      const bearer = await activate(inv);
      expect((await send(bearer, "before")).statusCode).toBe(201);
      const provider = (
        await q(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end) VALUES ($1,$2,'PE','1234567893','x','12-31') RETURNING id`,
          [ORG_A, `CCN${randomUUID().slice(0, 6)}`],
        )
      )[0]!.id as string;
      await q("UPDATE patient SET status='deceased', deceased_date=current_date WHERE id=$1", [
        fx.patient,
      ]);
      const counsellor = await kit.seedUser("counsellor", ORG_A, RESPOND_KEYS);
      const counsellorMembership = (
        await q("SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2", [
          counsellor,
          ORG_A,
        ])
      )[0]!.id as string;
      const plan = (
        await q(
          `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id, death_date, status, assigned_counselor_user_id, opened_at)
           VALUES ($1,$2,$3,$4,current_date,'active',$5, now()) RETURNING id`,
          [ORG_A, fx.patient, randomUUID(), provider, counsellorMembership],
        )
      )[0]!.id as string;
      await q(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, patient_caregiver_id_from_m5, status)
         VALUES ($1,$2,$3,'Dana Daughter','child',$4,'active')`,
        [ORG_A, provider, plan, fx.pc],
      );
      const state = (await contact(on, "GET", `${CONTACT}/state`, bearer)).json();
      expect(state).toMatchObject({ mode: "bereavement", bereavementPhone: "555-0199" });
      expect(
        (await q("SELECT mode FROM message_family_contact WHERE id=$1", [inv.contactId]))[0]!.mode,
      ).toBe("bereavement");
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.family_contact.bereavement_mode'",
        ),
      ).toBeGreaterThan(0);
      await contact(on, "GET", `${CONTACT}/state`, bearer);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='message_family_contact' AND event_type='message_family_contact.update' AND (after->>'mode')='bereavement' AND resource_id=$1",
          [inv.contactId],
        ),
      ).toBe(1);
      expect((await send(bearer, "after")).statusCode).toBe(201);
      // After a death the care-team roster is gone; the staff side of the thread is the plan's assigned counsellor (D15), and only that person.
      roster.set(fx.patient, []);
      expect(
        (await staff(on, "GET", `${STAFF}/contacts/${inv.contactId}/thread`, counsellor))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reply`, counsellor, {
            body: "We are thinking of you.",
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await staff(on, "GET", `${STAFF}/contacts/${inv.contactId}/thread`, nurse)).statusCode,
      ).toBe(404);
      expect(texts(await read(bearer))).toEqual(["before", "after", "We are thinking of you."]);
      // Plan closed => access ends; the thread is kept.
      await q(
        "UPDATE bereavement_plan SET status='closed_completed', closed_at=now() WHERE id=$1",
        [plan],
      );
      await gone(fx, bearer);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message WHERE channel_id=(SELECT channel_id FROM message_family_contact WHERE id=$1)",
          [inv.contactId],
        ),
      ).toBe(3);
    });

    it("death WITHOUT a bereavement plan, or without a surviving consent, ends access at the death", async () => {
      const a = await mkFixture({ consent: "survives_death" });
      const invA = await invite(a);
      const bearerA = await activate(invA);
      await q("UPDATE patient SET status='deceased', deceased_date=current_date WHERE id=$1", [
        a.patient,
      ]);
      await gone(a, bearerA);
      const b = await mkFixture({ consent: true });
      const invB = await invite(b);
      const bearerB = await activate(invB);
      await q("UPDATE patient SET status='deceased', deceased_date=current_date WHERE id=$1", [
        b.patient,
      ]);
      await gone(b, bearerB);
    });
  });

  // ── 7: the two doors ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("doors", () => {
    it("the generic send route cannot post into a family conversation, and the generic visibility is the care-team predicate", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      expect((await send(bearer, "hello")).statusCode).toBe(201);
      const channel = (
        await q("SELECT channel_id FROM message_family_contact WHERE id=$1", [inv.contactId])
      )[0]!.channel_id as string;
      const generic = await on.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${channel}/messages`,
        headers: as(nurse, ORG_A, randomUUID()),
        payload: { body: "sneaky" },
      });
      expect(generic.statusCode).toBe(409);
      expect(errorCode(generic)).toBe("FAMILY_THREAD_WRITE");
      // A care-team member reads it through the generic route (so promotion and redaction work unchanged); a non-member does not.
      expect(await route.canViewChannel(ORG_A, nurse, channel)).toBe(true);
      const asTeam = await staff(
        on,
        "GET",
        `/api/v1/messaging/channels/${channel}/messages`,
        nurse,
      );
      expect(asTeam.statusCode, asTeam.body).toBe(200);
      expect(asTeam.json().messages[0].authorDisplayName).toBe("Family contact");
      const outsider = await kit.seedUser("generic-outsider", ORG_A, RESPOND_KEYS);
      expect(
        (await staff(on, "GET", `/api/v1/messaging/channels/${channel}/messages`, outsider))
          .statusCode,
      ).toBe(403);
      // The sidebar (membership) never lists a family conversation.
      const list = await staff(on, "GET", "/api/v1/messaging/channels", nurse);
      expect(JSON.stringify(list.json())).not.toContain(channel);
      // The ADD-MEMBER door does not make a stranger a viewer either (visibility ignores member rows for this kind).
      await kit.admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
        [ORG_A, channel, outsider],
      );
      expect(
        (await staff(on, "GET", `/api/v1/messaging/channels/${channel}/messages`, outsider))
          .statusCode,
      ).toBe(403);
    });

    it("the database refuses a family author on another kind of channel and the writer refuses a family channel without a door", async () => {
      const careTeam = await mkChannel(kit, "care_team", randomUUID(), [nurse]);
      const sealed = await bodyCipher.seal(ORG_A, "x");
      // The check constraint stays: a user author needs a user id, a contact author must not have one.
      await expect(
        kit.appConn.query(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256) VALUES ($1,$2,$3,'family_contact',$4,$5)`,
          [ORG_A, careTeam, nurse, sealed.cipher, sealed.sha256],
        ),
      ).rejects.toThrow();
    });
  });

  // ── 8: tenancy ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("tenancy", () => {
    it("another organisation's staff sees nothing and gets the unknown-id 404; a bearer under another organisation matches nothing", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      expect((await send(bearer, `${MARKER} tenancy`)).statusCode).toBe(201);
      const lane = await staff(on, "GET", `${STAFF}/contacts`, outsiderMgr, undefined, ORG_B);
      expect(lane.json().contacts).toEqual([]);
      const outsiderNurse = await kit.seedUser("b-nurse", ORG_B, RESPOND_KEYS);
      expect(
        (await staff(on, "GET", `${STAFF}/contacts`, outsiderNurse, undefined, ORG_B)).json()
          .contacts,
      ).toEqual([]);
      for (const url of [`${STAFF}/contacts/${inv.contactId}/thread`]) {
        const real = await staff(on, "GET", url, outsiderNurse, undefined, ORG_B);
        const random = await staff(
          on,
          "GET",
          url.replace(inv.contactId, randomUUID()),
          outsiderNurse,
          undefined,
          ORG_B,
        );
        expect(real.statusCode).toBe(404);
        expect(shape(real.body)).toBe(shape(random.body));
      }
      for (const method of ["DELETE", "POST"] as const) {
        const url =
          method === "DELETE"
            ? `${STAFF}/contacts/${inv.contactId}/invitation`
            : `${STAFF}/contacts/${inv.contactId}/block`;
        stepUpFresh = true;
        expect((await staff(on, method, url, outsiderMgr, undefined, ORG_B)).statusCode).toBe(404);
      }
      expect(
        (
          await staff(
            on,
            "GET",
            `${STAFF}/patients/${fx.patient}/caregivers`,
            outsiderMgr,
            undefined,
            ORG_B,
          )
        ).statusCode,
      ).toBe(404);
      // Presenting org A's bearer or link under org B's id.
      expect(
        (await contact(on, "GET", `${CONTACT}/state`, `${ORG_B}.${bearer.split(".")[1]}`))
          .statusCode,
      ).toBe(404);
      expect((await redeem(inv, on, ORG_B)).statusCode).toBe(404);
      // Still alive for its own organisation.
      expect((await contact(on, "GET", `${CONTACT}/state`, bearer)).statusCode).toBe(200);
    });

    it("FORCEd RLS: as chartwarden_app under another organisation all five tables are empty, and a cross-org insert is refused", async () => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
        for (const t of [
          "message_family_setting",
          "message_family_contact",
          "message_family_invitation",
          "message_family_session",
          "message_family_access",
        ]) {
          const n = (await kit.appConn.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
          expect(n, t).toBe(0);
        }
        await expect(
          kit.appConn.query(
            `INSERT INTO message_family_setting (organization_id, agency_name) VALUES ($1,'x')`,
            [ORG_A],
          ),
        ).rejects.toThrow();
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });
  });

  // ── 9: trail and audit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("trail and audit", () => {
    it("every read and send leaves a trail row; the database refuses one for a revoked invitation or a blocked contact", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      await send(bearer, "one");
      await read(bearer);
      await read(bearer);
      const rows = await q(
        "SELECT action, message_count, message_id FROM message_family_access WHERE contact_id=$1 ORDER BY accessed_at",
        [inv.contactId],
      );
      expect(rows.map((r) => r.action)).toEqual(["send", "read", "read"]);
      expect(rows[1]!.message_count).toBe(1);
      const session = (
        await q(
          "SELECT id FROM message_family_session WHERE invitation_id IN (SELECT id FROM message_family_invitation WHERE contact_id=$1)",
          [inv.contactId],
        )
      )[0]!.id as string;
      await kit.admin.query(
        "ALTER TABLE message_family_invitation DISABLE TRIGGER trg_message_family_invitation_guard",
      );
      await kit.admin.query(
        "UPDATE message_family_invitation SET revoked_at = now(), revoke_reason = 'staff' WHERE contact_id=$1",
        [inv.contactId],
      );
      await kit.admin.query(
        "ALTER TABLE message_family_invitation ENABLE TRIGGER trg_message_family_invitation_guard",
      );
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        await expect(
          kit.appConn.query(
            `INSERT INTO message_family_access (organization_id, contact_id, session_id, action) VALUES ($1,$2,$3,'read')`,
            [ORG_A, inv.contactId, session],
          ),
        ).rejects.toThrow(/message_family_access_live/);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });

    it("no message text, token, code, patient or caregiver id appears in any audit row, outbox event or notification row of this feature", async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      await send(bearer, `${MARKER} audit-check`);
      const haystack = JSON.stringify([
        await q(
          "SELECT before, after, context FROM audit_event WHERE resource_kind LIKE 'message_family_%'",
        ),
        await q("SELECT payload FROM outbox_event WHERE event_type LIKE 'm36.family_contact.%'"),
      ]);
      for (const needle of [MARKER, inv.token, inv.code, fx.patient, fx.pc, fx.caregiver]) {
        expect(haystack, needle).not.toContain(needle);
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind LIKE 'message_family_%'",
        ),
      ).toBeGreaterThan(5);
    });

    it("the app role cannot DELETE any family table, rewrite a hash, or move a trail row", async () => {
      const inv = await invite(await mkFixture());
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        for (const t of [
          "message_family_contact",
          "message_family_invitation",
          "message_family_session",
          "message_family_access",
          "message_family_setting",
        ]) {
          await kit.appConn.query("SAVEPOINT s");
          await expect(kit.appConn.query(`DELETE FROM ${t}`), t).rejects.toThrow();
          await kit.appConn.query("ROLLBACK TO SAVEPOINT s");
        }
        await expect(
          kit.appConn.query(
            `UPDATE message_family_invitation SET code_hash = 'x' WHERE contact_id=$1`,
            [inv.contactId],
          ),
        ).rejects.toThrow();
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    });
  });

  // ── 10: budgets and concurrency ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("budgets", () => {
    const backdate = async (contactId: string, count: number, minutesAgo: number) => {
      const channel = (
        await q("SELECT channel_id FROM message_family_contact WHERE id=$1", [contactId])
      )[0]!.channel_id as string;
      const sealed = await bodyCipher.seal(ORG_A, "bulk");
      for (let i = 0; i < count; i += 1) {
        await q(
          `INSERT INTO message (organization_id, channel_id, author_kind, body_cipher, body_sha256, created_at) VALUES ($1,$2,'family_contact',$3,$4, now() - make_interval(mins => $5))`,
          [ORG_A, channel, sealed.cipher, sealed.sha256, minutesAgo],
        );
      }
    };

    it(`${FAMILY_SEND_PER_HOUR} messages an hour: the next is a 429 (and the lane shows the volume)`, async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      expect((await send(bearer, "first")).statusCode).toBe(201);
      await backdate(inv.contactId, FAMILY_SEND_PER_HOUR - 1, 5);
      const res = await send(bearer, "one too many");
      expect(res.statusCode).toBe(429);
      const lane = (await staff(on, "GET", `${STAFF}/contacts`, nurse))
        .json()
        .contacts.find((c: Row) => c.contactId === inv.contactId);
      expect(lane.highVolume).toBe(true);
    });

    it(`${FAMILY_SEND_PER_DAY} messages a day: the next is a 429`, async () => {
      const inv = await invite(await mkFixture());
      const bearer = await activate(inv);
      expect((await send(bearer, "first")).statusCode).toBe(201);
      await backdate(inv.contactId, FAMILY_SEND_PER_DAY - 1, 180);
      expect((await send(bearer, "too many today")).statusCode).toBe(429);
    });

    it(`${FAMILY_THREAD_UNANSWERED_CAP} unanswered messages: the thread holds until staff reply, then sends again`, async () => {
      const fx = await mkFixture();
      const inv = await invite(fx);
      const bearer = await activate(inv);
      expect((await send(bearer, "first")).statusCode).toBe(201);
      await backdate(inv.contactId, FAMILY_THREAD_UNANSWERED_CAP, 60 * 30);
      expect((await send(bearer, "capped")).statusCode).toBe(429);
      expect(
        (
          await staff(on, "POST", `${STAFF}/contacts/${inv.contactId}/reply`, nurse, {
            body: "We are here.",
          })
        ).statusCode,
      ).toBe(201);
      // The reply answered the thread: the cap no longer holds.
      expect((await send(bearer, "after the reply")).statusCode).toBe(201);
    });

    it("two concurrent first sends create ONE conversation", async () => {
      const fx = await mkFixture();
      const bearer = await activate(await invite(fx));
      const [a, b] = await Promise.all([send(bearer, "race a"), send(bearer, "race b")]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 201]);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM channel WHERE channel_kind='family' AND subject_id=$1",
          [fx.patient],
        ),
      ).toBe(1);
    });

    it("the lane has no 'bulk' surface: no broadcast, announce or send-to-many route names a family contact", async () => {
      const routes = on.printRoutes({ commonPrefix: false });
      expect(routes).not.toMatch(/family[^\n]*(broadcast|announce|bulk)/i);
    });
  });
});
