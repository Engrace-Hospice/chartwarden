/**
 * M36 WP 3.7 - the OWNING modules of a chart promotion (M8 addendum, M14 agenda item), LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role. This is the Phase 3 release gate `chart-promotion-attribution` (docs/messaging-hub/03-phases-0-to-3.md).
 *
 * Real M36 promotion binding (real request rows, real message bodies, the seam `ChartPromotionSourceReader`), the real M8
 * encounter service and the real M14 IDG service, each publishing through the REAL catalog-validating outbox publisher
 * (never NOOP_OUTBOX), and M36's real outcome consumer fed from the stored `outbox_event` rows.
 *
 *   M8   a reviewer authors THEIR OWN draft addendum from a real proposal (attribution copied, no text), finalises, signs with
 *        step-up -> event -> M36 row `accepted`, result_ref = addendum id, decided_by = the signer. Reject, wrong patient,
 *        withdrawn, superseded and an unknown proposal are refused; a second live draft is 409; a voided addendum never
 *        accepts and frees the proposal; a plain addendum is untouched.
 *   M14  the coordinator adds an `other` agenda item from a proposal (pointer + attribution, NO text), event -> `accepted`,
 *        result_ref = the item id; no IDG decision is recorded; reject, wrong module, duplicate and an adjourned meeting.
 *   DB   the attribution is immutable and an INSERT must equal an open proposal for the same patient; no audit row carries the
 *        body hash or the message text; another tenant sees nothing.
 *   NONE no row is written to orders (M11) or the care plan (M7) by any path above.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:promotion-targets:live
 * Use a PRIVATE pgvector/pgvector:pg18 container (max_locks_per_transaction=2048): the suite resets the public schema and the
 * wardenx_* roles.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@wardenx/auth";
import type { ChartPromotionTargetModule } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import {
  type EncounterWriteOutboxPort,
  M8_OUTBOX_EVENTS,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { buildM36PromotionOutcomesConsumer } from "../src/modules/36-messaging/outbox-consumers/promotion-outcomes";
import { buildPromotionDeps } from "../src/modules/36-messaging/promotions/deps";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import {
  ADDENDUM_SELECTIONS,
  requiredSectionSelections,
  requiredVitalsCapture,
} from "./_hearthnote-fixtures";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  headerAuth,
  mkChannel,
  plainDoc,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000f0801";
const ORG_B = "22222222-2222-4222-8222-2222000f0802";
const FLAG = "messaging.promotions";
const PROMOTER_KEYS = [...STAFF_KEYS, "messaging.promote", "encounter.addendum_sign"];
const BODY_MARKER = "wp37-owner-secret-night-pain-marker";
const SERVICE_DATE = "2026-01-15";
const LIVE_NOW = "2026-01-16T17:00:00Z";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const OTHER_PATIENT = "55555555-5555-4555-8555-555555555555";
const ADMISSION = "66666666-6666-4666-8666-666666666666";
const SESSION = "77777777-7777-4777-8777-777777777777";
const M8T = { target_module: "m8", target_kind: "encounter_addendum" } as const;
const M14T = { target_module: "m14", target_kind: "idg_agenda_item" } as const;
const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 7) };
const CIPHERS = createHearthnoteCiphers({
  async dekForOrg() {
    return TEST_DEK;
  },
  async dekForOrgVersion(_org: string, version: string) {
    return { version, key: TEST_DEK.key };
  },
});

describe.skipIf(!DB_URL)(
  "M36 WP 3.7 chart-promotion-attribution - M8 + M14 owners, LIVE Postgres",
  () => {
    let kit: LiveKit;
    let app: FastifyInstance;
    let binding: ReturnType<typeof buildPromotionDeps>;
    let enc: ReturnType<typeof createDbEncounterRouteService>;
    let idg: ReturnType<typeof createDbIdgBackend>;
    let author: string;
    let requester: string;
    let reviewer: string;
    let reviewerMembership: string;
    let locationId: string;
    const part2Denied = new Set<string>();
    const withoutSign = new Set<string>();
    const channels = new Map<string, string>();
    const alerts: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const KEK = randomBytes(32);
    const inScope = () => true;
    const TREE = ADDENDUM_SELECTIONS;

    const call = (user: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: as(user, ORG_A, method === "GET" ? undefined : randomUUID()),
        ...(payload ? { payload } : {}),
      });

    /** A care-team channel for `patient` with a message from `author`, then a REAL proposal from `requester`. */
    async function propose(
      target: typeof M8T | typeof M14T,
      opts: { patient?: string; text?: string } = {},
    ): Promise<{ id: string; messageId: string; channelId: string; patient: string }> {
      const patient = opts.patient ?? PATIENT;
      // One care-team channel per patient (a unique subject); each proposal posts its own message in it.
      let channelId = channels.get(patient);
      if (!channelId) {
        channelId = await mkChannel(kit, "care_team", patient, [author, requester]);
        channels.set(patient, channelId);
      }
      const sent = await call(author, "POST", `/api/v1/messaging/channels/${channelId}/messages`, {
        bodyDoc: plainDoc(opts.text ?? BODY_MARKER),
      });
      expect(sent.statusCode).toBe(201);
      const messageId = sent.json().messageId as string;
      const res = await call(
        requester,
        "POST",
        `/api/v1/messaging/channels/${channelId}/messages/${messageId}/chart-promotions`,
        target,
      );
      expect(res.statusCode).toBe(201);
      return { id: res.json().promotion.id as string, messageId, channelId, patient };
    }

    /** The SHA-256 the messaging module stored for the message (of the sealed plaintext, not of the bare text). */
    const storedSha = async (messageId: string) =>
      (
        await kit.one<{ body_sha256: string }>("SELECT body_sha256 FROM message WHERE id=$1", [
          messageId,
        ])
      )[0]?.body_sha256 as string;
    const request = async (id: string) =>
      (
        await kit.one<Record<string, unknown>>(
          "SELECT * FROM chart_promotion_request WHERE id=$1",
          [id],
        )
      )[0];

    const consumer = () =>
      buildM36PromotionOutcomesConsumer({
        alerts: {
          emit: async (
            _o: string,
            input: { eventType: string; payload: Record<string, unknown> },
          ) => {
            alerts.push(input);
            return { alertId: "a", resolvedRecipientCount: 1 };
          },
        } as never,
        applyOutcome: (orgId, event) => binding.service.applyOutcome(orgId, event),
      });

    /** The owner's decided event rows for a proposal, exactly as stored by the real publisher. */
    const decidedRows = (eventType: string, promotionRequestId: string) =>
      kit.one<{
        id: string;
        organization_id: string;
        aggregate_kind: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT id, organization_id, aggregate_kind, aggregate_id, payload FROM outbox_event WHERE event_type=$1 AND payload->>'promotionRequestId'=$2 ORDER BY created_at",
        [eventType, promotionRequestId],
      );
    /** Hand every stored decided event of a proposal to M36's consumer, as the dispatcher would. */
    async function deliver(eventType: string, promotionRequestId: string): Promise<void> {
      for (const r of await decidedRows(eventType, promotionRequestId)) {
        await consumer().handle({
          id: r.id,
          organizationId: r.organization_id,
          eventType,
          aggregateKind: r.aggregate_kind,
          aggregateId: r.aggregate_id,
          payload: r.payload,
          attemptCount: 0,
          createdAt: new Date(),
        } as never);
      }
    }

    const rowsOfOrdersAndCarePlan = () =>
      kit.count(
        `SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text::int),0)::int AS n
         FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'
          AND (table_name ~ '^(order_|orders$|standing_order|verbal_order|care_plan|problem|goal$|intervention$)')`,
      );

    /** A signed RN encounter for PATIENT, and a draft/finalized addendum helper over it. */
    async function signedEncounter(): Promise<string> {
      const d = await enc.createDraft(ORG_A, reviewerMembership, {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit" as never,
        discipline: "rn" as never,
        serviceDate: SERVICE_DATE as never,
      });
      await enc.updateSelections(ORG_A, d.id, 0, requiredSectionSelections("routine_visit", "rn"));
      const vitals = requiredVitalsCapture("routine_visit", "rn");
      if (vitals) await enc.captureVitals(ORG_A, d.id, vitals);
      await enc.finalize(ORG_A, d.id, SERVICE_DATE as never);
      await enc.sign(ORG_A, d.id, actor(), { at: SERVICE_DATE as never });
      return d.id;
    }
    const actor = () => ({
      membershipId: reviewerMembership,
      sessionId: SESSION,
      userId: reviewer,
    });
    const promotedDraft = (encounterId: string, requestId: string) =>
      enc.createAddendum(ORG_A, encounterId, {
        reason: "Clarification drawn from a care-team message, reviewed.",
        authorMembershipId: reviewerMembership,
        promotion: { requestId, reviewerUserId: reviewer },
      });
    const finalizeAddendum = async (encounterId: string, addendumId: string) => {
      await enc.updateAddendumSelections(ORG_A, encounterId, addendumId, TREE);
      await enc.finalizeAddendum(ORG_A, encounterId, addendumId);
    };

    beforeAll(async () => {
      kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp37o");
      author = await kit.seedUser("author", ORG_A);
      requester = await kit.seedUser("requester", ORG_A, PROMOTER_KEYS);
      reviewer = await kit.seedUser("reviewer", ORG_A);
      reviewerMembership = (
        await kit.one<{ id: string }>(
          "SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2",
          [reviewer, ORG_A],
        )
      )[0]?.id as string;

      // Siting + an active admission (M8's createDraft validates and sites the encounter through M6's reader).
      const pe = (
        await kit.admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'01-5555','WP37 PE','1234567890','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      locationId = (
        await kit.admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'WP37 Loc','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      await kit.admin.query(
        `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$6)`,
        [ADMISSION, ORG_A, pe, locationId, PATIENT, "2025-12-01"],
      );

      __resetSeamsForTest();
      registerSeam(
        "SessionContextResolver",
        createSessionContextResolver(
          createInMemorySessionContextStore([
            {
              sessionClass: "staff",
              portalAccountId: null,
              sessionPatientId: null,
              sessionId: SESSION,
              userId: reviewer,
              membershipId: reviewerMembership,
              organizationId: ORG_A,
              roles: [],
              providerEntityIds: [],
              locationIds: [],
              lastStepUpAt: new Date(),
              lastStepUpFactor: "webauthn",
            },
          ]).store,
        ),
      );
      registerSeam("CarePlanReader", {
        relevantElementsForEncounter: async () => null,
        isReviewOverdue: async () => null,
        fifteenDayCycleCountsForOrg: async () => ({ numerator: 0, denominator: 0 }),
        terminologyCodeUsageForOrg: async () => [],
        linkSummary: async () => null,
      } as never);
      registerSeam("LatestAssessmentProvider", {
        latest: async () => null,
        latestBatch: async () => [],
      } as never);
      registerSeam(
        "AdmissionStatusReader",
        createAdmissionStatusReader(createDrizzleAdmissionReaderStore(kit.handle.db)),
      );

      const outbox = catalogOutbox();
      const messaging = createDbMessagingRouteService(kit.handle.db, {
        kek: KEK,
        outbox: outbox as never,
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      });
      binding = buildPromotionDeps({
        db: kit.handle.db,
        flags: { forOrg: async () => ({ [FLAG]: true }) },
        outbox: outbox as never,
        messaging,
        bodyOpener: createMessageBodyCipher({ kek: KEK }),
        part2Gate: {
          allowedUserIds: async ({ patientId, userIds }) =>
            new Set(userIds.filter((u) => !part2Denied.has(`${u}:${patientId}`))),
        },
        meetingExists: async () => true,
        permissionsFor: async (_org, userId) =>
          new Set(
            withoutSign.has(userId)
              ? PROMOTER_KEYS.filter((k) => k !== "encounter.addendum_sign")
              : PROMOTER_KEYS,
          ),
      });
      app = buildServer({
        db: kit.handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
        idempotencyStore: createDbIdempotencyStore(kit.handle.db),
      });
      registerMessagingRoutes(app, {
        service: messaging,
        announcements: createDbAnnouncementService(kit.handle.db),
        promotions: binding,
      });
      await app.ready();
      // The seam M8 and M14 read, bound to the REAL reader (flag on, real hash re-check, real Part 2 stub).
      registerSeam("ChartPromotionSourceReader", binding.sourceReader);

      const m8Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M8_OUTBOX_EVENTS]));
      const m8Outbox: EncounterWriteOutboxPort = {
        publish: (tx, e) => m8Publisher.publish(tx as never, { ...e, callerModule: "m8" }),
      };
      enc = createDbEncounterRouteService(
        kit.handle.db,
        m8Outbox,
        CIPHERS,
        () => new Date(LIVE_NOW),
      );
      const m14Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M14_OUTBOX_EVENTS]));
      const m14Outbox: IdgWriteOutboxPort = {
        publish: (tx, e) => m14Publisher.publish(tx as never, { ...e, callerModule: "m14" }),
      };
      idg = createDbIdgBackend(kit.handle.db, m14Outbox);
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      __resetSeamsForTest();
      await kit?.close();
    });

    describe("M8: a reviewer's own addendum, signed with step-up", () => {
      it("lists the proposal with the quoted snapshot, authors a draft that carries the attribution, and signs -> accepted", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const watched = await rowsOfOrdersAndCarePlan();

        const listed = await enc.listChartPromotions(ORG_A, encounterId, reviewer);
        expect(listed.enabled).toBe(true);
        expect(listed.promotions.find((x) => x.request_id === p.id)).toMatchObject({
          snapshot_text: BODY_MARKER,
          source_author_user_id: author,
          source_state: "current",
        });

        const draft = await promotedDraft(encounterId, p.id);
        const [attributed] = await kit.one<Record<string, unknown>>(
          "SELECT * FROM encounter_addendum WHERE id=$1",
          [draft.id],
        );
        const req = await request(p.id);
        expect(attributed).toMatchObject({
          status: "draft",
          authored_by_membership_id: reviewerMembership,
          promotion_request_id: p.id,
          source_message_id: p.messageId,
          source_author_user_id: author,
          source_body_sha256: await storedSha(p.messageId),
        });
        expect(new Date(attributed?.source_sent_at as string).toISOString()).toBe(
          (req?.source_sent_at as Date).toISOString(),
        );
        // Before signing the proposal is still open and nothing was decided.
        expect(req?.status).toBe("proposed");
        expect(await decidedRows("m8.chart_promotion.decided", p.id)).toHaveLength(0);
        // The reviewer's own text is not the message: nothing was copied into the addendum row.
        expect(JSON.stringify(attributed)).not.toContain(BODY_MARKER);

        await finalizeAddendum(encounterId, draft.id);
        expect(await decidedRows("m8.chart_promotion.decided", p.id)).toHaveLength(0);
        const signed = await enc.signAddendum(ORG_A, encounterId, draft.id, actor(), {
          at: SERVICE_DATE as never,
        });
        expect(signed.status).toBe("signed");

        const events = await decidedRows("m8.chart_promotion.decided", p.id);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toMatchObject({
          organizationId: ORG_A,
          promotionRequestId: p.id,
          outcome: "accepted",
          resultRef: draft.id,
          decidedByUserId: reviewer,
          reasonCode: null,
        });
        expect(JSON.stringify(events[0]?.payload)).not.toContain(BODY_MARKER);
        expect(JSON.stringify(events[0]?.payload)).not.toContain(PATIENT);

        await deliver("m8.chart_promotion.decided", p.id);
        expect(await request(p.id)).toMatchObject({
          status: "accepted",
          result_ref: draft.id,
          decided_by_user_id: reviewer,
        });
        expect(alerts.at(-1)?.payload).not.toHaveProperty("patientId");
        expect(await rowsOfOrdersAndCarePlan()).toBe(watched);
      });

      it("a proposal rejected after the draft was made cannot be signed into the chart (fails closed, 422)", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const draft = await promotedDraft(encounterId, p.id);
        await finalizeAddendum(encounterId, draft.id);
        // The race: another reviewer's reject event landed (the consumer applied it) before this reviewer signs.
        await kit.admin.query(
          `UPDATE chart_promotion_request SET status='rejected', reason_code='other', decided_by_user_id=$2,
             decided_at=now(), closed_at=now() WHERE id=$1`,
          [p.id, author],
        );
        await expect(
          enc.signAddendum(ORG_A, encounterId, draft.id, actor(), { at: SERVICE_DATE as never }),
        ).rejects.toMatchObject({ statusCode: 422, code: "PROMOTION_NOT_AVAILABLE" });
        const [row] = await kit.one<{ status: string }>(
          "SELECT status FROM encounter_addendum WHERE id=$1",
          [draft.id],
        );
        expect(row?.status).toBe("finalized");
        expect(await decidedRows("m8.chart_promotion.decided", p.id)).toHaveLength(0);
        // A new draft is refused too (the seam no longer offers a rejected proposal).
        await expect(promotedDraft(encounterId, p.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });
      });

      it("a draft made from a proposal holds a share lock on it: a concurrent reject cannot slip in before the draft commits", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const [encRow] = await kit.one<{ id: string }>("SELECT id FROM encounter WHERE id=$1", [
          encounterId,
        ]);
        const [req] = await kit.one<Record<string, unknown>>(
          "SELECT * FROM chart_promotion_request WHERE id=$1",
          [p.id],
        );
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query(
            `INSERT INTO encounter_addendum (organization_id, encounter_id, authored_by_membership_id, reason, status,
               promotion_request_id, source_message_id, source_author_user_id, source_sent_at, source_body_sha256)
             SELECT organization_id, id, $1, 'draft holding the proposal lock for the race test', 'draft', $2,$3,$4,$5,$6
               FROM encounter WHERE id=$7`,
            [
              reviewerMembership,
              p.id,
              req?.message_id,
              req?.source_author_user_id,
              req?.source_sent_at,
              req?.source_body_sha256,
              encRow?.id,
            ],
          );
          await kit.admin.query("SET lock_timeout = '400ms'");
          await expect(
            kit.admin.query(
              `UPDATE chart_promotion_request SET status='rejected', reason_code='other', decided_by_user_id=$2,
                 decided_at=now(), closed_at=now() WHERE id=$1`,
              [p.id, author],
            ),
          ).rejects.toThrow(/lock timeout|canceling statement/);
        } finally {
          await kit.admin.query("RESET lock_timeout");
          await kit.appConn.query("ROLLBACK");
        }
        expect((await request(p.id))?.status).toBe("proposed");
      });

      it("a reject is refused (409) while the proposal has a live addendum, and allowed once it is voided", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const draft = await promotedDraft(encounterId, p.id);
        const reject = () =>
          enc.rejectChartPromotion(ORG_A, encounterId, p.id, {
            reviewerUserId: reviewer,
            reasonCode: "other",
          });
        await expect(reject()).rejects.toMatchObject({ statusCode: 409 });
        expect(await decidedRows("m8.chart_promotion.decided", p.id)).toHaveLength(0);
        await kit.admin.query("UPDATE encounter_addendum SET status='voided' WHERE id=$1", [
          draft.id,
        ]);
        await expect(reject()).resolves.toMatchObject({ outcome: "rejected" });
      });

      it("a stale draft signed after the message was edited accepts the old request and closes its replacement", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const draft = await promotedDraft(encounterId, p.id);
        await finalizeAddendum(encounterId, draft.id);
        const edit = await call(author, "PATCH", `/api/v1/messaging/messages/${p.messageId}`, {
          bodyDoc: plainDoc("edited after the first proposal"),
        });
        expect(edit.statusCode).toBe(200);
        const again = await call(
          requester,
          "POST",
          `/api/v1/messaging/channels/${p.channelId}/messages/${p.messageId}/chart-promotions`,
          M8T,
        );
        expect(again.statusCode).toBe(201);
        const newer = again.json().promotion.id as string;
        expect((await request(p.id))?.status).toBe("superseded");

        await enc.signAddendum(ORG_A, encounterId, draft.id, actor(), {
          at: SERVICE_DATE as never,
        });
        await deliver("m8.chart_promotion.decided", p.id);

        expect(await request(p.id)).toMatchObject({ status: "accepted", result_ref: draft.id });
        expect(await request(newer)).toMatchObject({
          status: "superseded",
          reason_code: "superseded",
          result_ref: null,
        });
      });

      it("the reviewer's list serves no text for an edited message, and an M8 reviewer without encounter.addendum_sign sees nothing", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const edit = await call(author, "PATCH", `/api/v1/messaging/messages/${p.messageId}`, {
          bodyDoc: plainDoc("edited so the proposed text is superseded"),
        });
        expect(edit.statusCode).toBe(200);
        const listed = await enc.listChartPromotions(ORG_A, encounterId, reviewer);
        const mine = listed.promotions.find((x) => x.request_id === p.id);
        expect(mine).toMatchObject({ snapshot_text: null, source_state: "edited_since" });
        expect(JSON.stringify(mine)).not.toContain(BODY_MARKER);

        withoutSign.add(reviewer);
        try {
          const hidden = await enc.listChartPromotions(ORG_A, encounterId, reviewer);
          expect(hidden.promotions.map((x) => x.request_id)).not.toContain(p.id);
          await expect(promotedDraft(encounterId, p.id)).rejects.toMatchObject({
            code: "PROMOTION_NOT_AVAILABLE",
          });
        } finally {
          withoutSign.delete(reviewer);
        }
      });

      it("refuses a second live draft for the same proposal (409) even after the first was signed", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        await promotedDraft(encounterId, p.id);
        await expect(promotedDraft(encounterId, p.id)).rejects.toMatchObject({ statusCode: 409 });
      });

      it("never accepts from a draft or a voided addendum, and a voided draft frees the proposal", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const first = await promotedDraft(encounterId, p.id);
        await finalizeAddendum(encounterId, first.id);
        await kit.admin.query("UPDATE encounter_addendum SET status='voided' WHERE id=$1", [
          first.id,
        ]);

        await expect(
          enc.signAddendum(ORG_A, encounterId, first.id, actor(), { at: SERVICE_DATE as never }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await decidedRows("m8.chart_promotion.decided", p.id)).toHaveLength(0);
        expect((await request(p.id))?.status).toBe("proposed");

        const second = await promotedDraft(encounterId, p.id);
        expect(second.id).not.toBe(first.id);
      });

      it("reject publishes rejected with the reason and creates no addendum", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const before = await kit.count("SELECT count(*)::int AS n FROM encounter_addendum");

        const out = await enc.rejectChartPromotion(ORG_A, encounterId, p.id, {
          reviewerUserId: reviewer,
          reasonCode: "already_documented",
        });

        expect(out).toEqual({ promotionRequestId: p.id, outcome: "rejected" });
        expect(await kit.count("SELECT count(*)::int AS n FROM encounter_addendum")).toBe(before);
        await deliver("m8.chart_promotion.decided", p.id);
        expect(await request(p.id)).toMatchObject({
          status: "rejected",
          reason_code: "already_documented",
          decided_by_user_id: reviewer,
          result_ref: null,
        });
      });

      it("refuses a proposal for another patient, a withdrawn one, a superseded one and an unknown one (422), writing nothing", async () => {
        const encounterId = await signedEncounter();
        const before = await kit.count("SELECT count(*)::int AS n FROM encounter_addendum");

        const otherPatient = await propose(M8T, { patient: OTHER_PATIENT });
        await expect(promotedDraft(encounterId, otherPatient.id)).rejects.toMatchObject({
          statusCode: 422,
          code: "PROMOTION_NOT_AVAILABLE",
        });
        await expect(
          enc.rejectChartPromotion(ORG_A, encounterId, otherPatient.id, {
            reviewerUserId: reviewer,
            reasonCode: "other",
          }),
        ).rejects.toMatchObject({ code: "PROMOTION_NOT_AVAILABLE" });

        const withdrawn = await propose(M8T);
        const w = await call(
          requester,
          "POST",
          `/api/v1/messaging/chart-promotions/${withdrawn.id}/withdraw`,
        );
        expect(w.statusCode).toBe(200);
        await expect(promotedDraft(encounterId, withdrawn.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });

        const superseded = await propose(M8T);
        await kit.admin.query(
          "UPDATE chart_promotion_request SET status='superseded', closed_at=now(), reason_code='superseded' WHERE id=$1",
          [superseded.id],
        );
        await expect(promotedDraft(encounterId, superseded.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });

        await expect(promotedDraft(encounterId, randomUUID())).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });
        expect(await kit.count("SELECT count(*)::int AS n FROM encounter_addendum")).toBe(before);
      });

      it("an M14 proposal is not available to M8 (the owning module is checked)", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M14T);
        await expect(promotedDraft(encounterId, p.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });
      });

      it("a Part 2 denial for the reviewer hides the proposal and refuses the draft", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        part2Denied.add(`${reviewer}:${PATIENT}`);
        try {
          const listed = await enc.listChartPromotions(ORG_A, encounterId, reviewer);
          expect(listed.promotions.map((x) => x.request_id)).not.toContain(p.id);
          await expect(promotedDraft(encounterId, p.id)).rejects.toMatchObject({
            code: "PROMOTION_NOT_AVAILABLE",
          });
        } finally {
          part2Denied.clear();
        }
      });

      it("a plain addendum is untouched: no attribution, no decided event", async () => {
        const encounterId = await signedEncounter();
        const a = await enc.createAddendum(ORG_A, encounterId, {
          reason: "A plain late clarification of the plan.",
          authorMembershipId: reviewerMembership,
        });
        await finalizeAddendum(encounterId, a.id);
        await enc.signAddendum(ORG_A, encounterId, a.id, actor(), { at: SERVICE_DATE as never });

        const [row] = await kit.one<Record<string, unknown>>(
          "SELECT * FROM encounter_addendum WHERE id=$1",
          [a.id],
        );
        expect(row).toMatchObject({
          status: "signed",
          promotion_request_id: null,
          source_message_id: null,
          source_body_sha256: null,
        });
        const n = await kit.count(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m8.chart_promotion.decided' AND payload->>'resultRef'=$1",
          [a.id],
        );
        expect(n).toBe(0);
      });
    });

    describe("M14: the coordinator's agenda item (a pointer, no text)", () => {
      const meeting = async (status = "live") =>
        (
          await kit.admin.query(
            `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
             coordinator_membership_id, tenant_quorum_snapshot)
           VALUES ($1,$2, now(), now() + interval '2 hours', $3, $4, '{}'::jsonb) RETURNING id`,
            [ORG_A, locationId, status, reviewerMembership],
          )
        ).rows[0].id as string;
      const addFromPromotion = (meetingId: string, requestId: string, scope = inScope) =>
        idg.addAgendaItemFromPromotion(ORG_A, reviewerMembership, meetingId, {
          requestId,
          reviewerUserId: reviewer,
          inScope: scope,
        });

      it("adds an `other` item with attribution and no text, publishes accepted, and records no decision", async () => {
        const m = await meeting();
        const p = await propose(M14T);
        const watched = await rowsOfOrdersAndCarePlan();
        const decisions = await kit.count("SELECT count(*)::int AS n FROM idg_decision");

        const listed = await idg.listChartPromotions(ORG_A, m, {
          reviewerUserId: reviewer,
          patientIds: [PATIENT],
        });
        expect(listed.promotions.map((x) => x.request_id)).toContain(p.id);
        expect(JSON.stringify(listed)).not.toContain(BODY_MARKER);

        const item = await addFromPromotion(m, p.id);

        expect(item).toMatchObject({
          kind: "other",
          patientId: PATIENT,
          promotion: {
            request_id: p.id,
            source_author_user_id: author,
            source_message_id: p.messageId,
          },
        });
        const [row] = await kit.one<Record<string, unknown>>(
          "SELECT * FROM idg_agenda_item WHERE id=$1",
          [item.id],
        );
        expect(row).toMatchObject({
          kind: "other",
          patient_id: PATIENT,
          promotion_request_id: p.id,
          source_message_id: p.messageId,
          source_author_user_id: author,
          source_body_sha256: await storedSha(p.messageId),
          body_text: null,
        });
        expect(JSON.stringify(row)).not.toContain(BODY_MARKER);

        const [event] = await decidedRows("m14.chart_promotion.decided", p.id);
        expect(event?.payload).toMatchObject({
          outcome: "accepted",
          resultRef: item.id,
          decidedByUserId: reviewer,
          reasonCode: null,
        });
        await deliver("m14.chart_promotion.decided", p.id);
        expect(await request(p.id)).toMatchObject({
          status: "accepted",
          result_ref: item.id,
          decided_by_user_id: reviewer,
        });

        expect(await kit.count("SELECT count(*)::int AS n FROM idg_decision")).toBe(decisions);
        expect(
          await kit.count(
            "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='idg.decision_recorded' AND payload->>'meetingId'=$1",
            [m],
          ),
        ).toBe(0);
        expect(await rowsOfOrdersAndCarePlan()).toBe(watched);
      });

      it("refuses a second item for the same proposal (409)", async () => {
        const m = await meeting();
        const p = await propose(M14T);
        await addFromPromotion(m, p.id);
        await expect(addFromPromotion(m, p.id)).rejects.toMatchObject({ statusCode: 409 });
      });

      it("a reject is refused (409) once an agenda item was raised from the proposal", async () => {
        const m = await meeting();
        const p = await propose(M14T);
        await addFromPromotion(m, p.id);
        await expect(
          idg.rejectChartPromotion(ORG_A, m, p.id, {
            reviewerUserId: reviewer,
            reasonCode: "duplicate",
            inScope,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (await decidedRows("m14.chart_promotion.decided", p.id)).map((r) => r.payload.outcome),
        ).toEqual(["accepted"]);
      });

      it("an agenda item cannot be raised from a proposal that was rejected in the meantime", async () => {
        const m = await meeting();
        const p = await propose(M14T);
        await kit.admin.query(
          `UPDATE chart_promotion_request SET status='rejected', reason_code='other', decided_by_user_id=$2,
             decided_at=now(), closed_at=now() WHERE id=$1`,
          [p.id, author],
        );
        await expect(addFromPromotion(m, p.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });
      });

      it("reject publishes rejected and adds no agenda item", async () => {
        const m = await meeting();
        const p = await propose(M14T);
        const before = await kit.count("SELECT count(*)::int AS n FROM idg_agenda_item");

        await idg.rejectChartPromotion(ORG_A, m, p.id, {
          reviewerUserId: reviewer,
          reasonCode: "duplicate",
          inScope,
        });

        expect(await kit.count("SELECT count(*)::int AS n FROM idg_agenda_item")).toBe(before);
        await deliver("m14.chart_promotion.decided", p.id);
        expect(await request(p.id)).toMatchObject({ status: "rejected", reason_code: "duplicate" });
      });

      it("refuses an M8 proposal, an out-of-scope patient and an adjourned meeting, publishing nothing", async () => {
        const m = await meeting();
        const wrongModule = await propose(M8T);
        await expect(addFromPromotion(m, wrongModule.id)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });

        const outOfScope = await propose(M14T);
        await expect(addFromPromotion(m, outOfScope.id, () => false)).rejects.toMatchObject({
          code: "PROMOTION_NOT_AVAILABLE",
        });

        const adjourned = await meeting("adjourned");
        const p = await propose(M14T);
        await expect(addFromPromotion(adjourned, p.id)).rejects.toMatchObject({});
        expect(await decidedRows("m14.chart_promotion.decided", p.id)).toHaveLength(0);
        expect((await request(p.id))?.status).toBe("proposed");
      });

      it("a plain agenda item is untouched: no attribution on the row or the view", async () => {
        const m = await meeting();
        const item = await idg.addAgendaItem(ORG_A, reviewerMembership, m, {
          kind: "other",
          patientId: PATIENT,
        });
        expect(item).not.toHaveProperty("promotion");
        const [row] = await kit.one<Record<string, unknown>>(
          "SELECT promotion_request_id, source_message_id, source_body_sha256 FROM idg_agenda_item WHERE id=$1",
          [item.id],
        );
        expect(row).toEqual({
          promotion_request_id: null,
          source_message_id: null,
          source_body_sha256: null,
        });
        expect((await idg.listAgenda(ORG_A, m)).find((x) => x.id === item.id)).not.toHaveProperty(
          "promotion",
        );
      });
    });

    describe("database backstops, audit and tenancy", () => {
      const asApp = async (org: string, sql: string, params: unknown[] = []) => {
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
          return await kit.appConn.query(sql, params);
        } finally {
          await kit.appConn.query("ROLLBACK");
        }
      };

      it("the attribution on a promoted row is immutable (M8 and M14)", async () => {
        const encounterId = await signedEncounter();
        const p8 = await propose(M8T);
        const draft = await promotedDraft(encounterId, p8.id);
        await expect(
          asApp(ORG_A, "UPDATE encounter_addendum SET source_body_sha256=$2 WHERE id=$1", [
            draft.id,
            "b".repeat(64),
          ]),
        ).rejects.toThrow(/promotion_immutable/);

        const m = (
          await kit.admin.query(
            `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
             coordinator_membership_id, tenant_quorum_snapshot)
           VALUES ($1,$2, now(), now() + interval '2 hours', 'live', $3, '{}'::jsonb) RETURNING id`,
            [ORG_A, locationId, reviewerMembership],
          )
        ).rows[0].id as string;
        const p14 = await propose(M14T);
        const item = await idg.addAgendaItemFromPromotion(ORG_A, reviewerMembership, m, {
          requestId: p14.id,
          reviewerUserId: reviewer,
          inScope,
        });
        await expect(
          asApp(ORG_A, "UPDATE idg_agenda_item SET source_message_id=$2 WHERE id=$1", [
            item.id,
            randomUUID(),
          ]),
        ).rejects.toThrow(/promotion_immutable/);
      });

      it("an INSERT must equal an open proposal for the same patient: forged attribution is refused", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const [req] = await kit.one<Record<string, unknown>>(
          "SELECT * FROM chart_promotion_request WHERE id=$1",
          [p.id],
        );
        const insert = (over: Partial<Record<string, unknown>>) => {
          const v = {
            promotion_request_id: p.id,
            source_message_id: req?.message_id,
            source_author_user_id: req?.source_author_user_id,
            source_sent_at: req?.source_sent_at,
            source_body_sha256: req?.source_body_sha256,
            ...over,
          };
          return asApp(
            ORG_A,
            `INSERT INTO encounter_addendum (organization_id, encounter_id, authored_by_membership_id, reason, status,
             promotion_request_id, source_message_id, source_author_user_id, source_sent_at, source_body_sha256)
           SELECT organization_id, id, $1, 'forged attribution reason for the guard test', 'draft', $2,$3,$4,$5,$6
             FROM encounter WHERE id=$7`,
            [
              reviewerMembership,
              v.promotion_request_id,
              v.source_message_id,
              v.source_author_user_id,
              v.source_sent_at,
              v.source_body_sha256,
              encounterId,
            ],
          );
        };
        await expect(insert({ source_body_sha256: "c".repeat(64) })).rejects.toThrow(
          /promotion_source/,
        );
        await expect(insert({ source_author_user_id: reviewer })).rejects.toThrow(
          /promotion_source/,
        );
        await expect(insert({ promotion_request_id: randomUUID() })).rejects.toThrow(
          /promotion_source/,
        );
        // Control: the exact attribution is accepted by the guard.
        await expect(insert({})).resolves.toBeDefined();
      });

      it("no audit row carries the body hash or the message text", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        const draft = await promotedDraft(encounterId, p.id);
        const rows = await kit.one<{ before: unknown; after: unknown }>(
          "SELECT before, after FROM audit_event WHERE resource_kind='encounter_addendum' AND resource_id=$1",
          [draft.id],
        );
        expect(rows.length).toBeGreaterThan(0);
        const text = JSON.stringify(rows);
        expect(text).not.toContain(await storedSha(p.messageId));
        expect(text).not.toContain(BODY_MARKER);
        expect(text).toContain(p.id);
      });

      it("another tenant sees neither the proposal nor the attributed rows, and cannot review it", async () => {
        const encounterId = await signedEncounter();
        const p = await propose(M8T);
        await promotedDraft(encounterId, p.id);

        const seam = binding.sourceReader;
        expect(
          await seam.forReview(ORG_B, p.id, { targetModule: "m8", reviewerUserId: reviewer }),
        ).toBeNull();
        expect(
          await seam.pendingForPatients(ORG_B, {
            targetModule: "m8" as ChartPromotionTargetModule,
            patientIds: [PATIENT],
            reviewerUserId: reviewer,
            limit: 10,
          }),
        ).toEqual([]);
        const seen = await asApp(
          ORG_B,
          "SELECT (SELECT count(*) FROM encounter_addendum WHERE promotion_request_id=$1) AS a, (SELECT count(*) FROM chart_promotion_request WHERE id=$1) AS r",
          [p.id],
        );
        expect(seen.rows[0]).toEqual({ a: "0", r: "0" });
      });
    });
  },
);
