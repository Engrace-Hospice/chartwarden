/**
 * M36 WP 1.7 — tenant & IDOR proof, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role (+ a real Valkey for the socket half).
 *
 * An adversarial pass over every M36 route and the realtime gateway. Two organisations (A, B); inside A, members and a
 * non-member of private channels (a DM and a `location` channel). Everything runs on the real route stack: the real
 * Authorization Contract, the real `channel_visibility` / `channel_member_admin` ABAC predicates, the Postgres idempotency
 * store and the catalog-validating outbox publisher.
 *
 *   1. COVERAGE GUARD   every route a M36 registrar mounts is in ROUTES with a verdict; a new route or registrar fails here.
 *   2. NO ORACLE        an attacker (org B, or an in-org non-member) using A's channel / message / endpoint / alert / rule /
 *                       patient / user id gets the SAME status and body shape as for a random uuid, and 4xx never 2xx.
 *   3. NO LEAK          no error carries A's body text, names, or user ids.
 *   4. NO WRITE         the whole battery leaves every M36 table, audit_event and outbox_event byte-identical.
 *   5. RLS AT THE DB    as `chartwarden_app` with app.org_id = B: zero A rows readable, A-org INSERT / UPDATE rejected.
 *   6. SOCKETS          (needs CHARTWARDEN_TEST_REDIS_URL) a B socket and a non-member socket receive no hint for A's channels
 *                       and cannot choose a room.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… [CHARTWARDEN_TEST_REDIS_URL=redis://…] bun run test:m36:tenant-idor:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { computeRoomSet } from "@chartwarden/messaging";
import type { EscalationRouteAnswer, EscalationRouter } from "@chartwarden/types";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import {
  type RealtimeHandle,
  type RealtimePrincipal,
  createRealtimeEmitter,
  startRealtimeServer,
} from "../src/bootstrap/realtime";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createDrizzleCareTeamStore,
  createDrizzlePatientReaderStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import { guardEscalationRouter } from "../src/modules/36-messaging/ack-escalation/escalation-router-guard";
import { createDbAckStore } from "../src/modules/36-messaging/ack-requests/ack-store-db";
import { buildAckDeps } from "../src/modules/36-messaging/ack-requests/deps";
import { createOpenRequestLookup } from "../src/modules/36-messaging/ack-requests/open-request-lookup";
import { createDbRoleReplayLookup } from "../src/modules/36-messaging/ack-requests/role-replay-lookup";
import { createDbUnacknowledgedReader } from "../src/modules/36-messaging/ack-requests/unacknowledged-reader-db";
import { buildSmartInboxService } from "../src/modules/36-messaging/inbox/binding";
import { createUnacknowledgedService } from "../src/modules/36-messaging/ack-requests/unacknowledged-service";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import type { AttachmentStoragePort } from "../src/modules/36-messaging/attachments/attachment-ports";
import { createBuiltinScanner } from "../src/modules/36-messaging/attachments/attachment-scanners";
import { createAttachmentService } from "../src/modules/36-messaging/attachments/attachment-service-db";
import { createDbClinicalLinkStore } from "../src/modules/36-messaging/clinical-link/clinical-link-store-db";
import { createDbDeliveryTargetReader } from "../src/modules/36-messaging/delivery-target/delivery-target-reader-db";
import { createDeliveryTargetService } from "../src/modules/36-messaging/delivery-target/delivery-target-service";
import { createDbDraftService } from "../src/modules/36-messaging/drafts/draft-service-db";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { buildHandoffDeps } from "../src/modules/36-messaging/handoffs/deps";
import { buildIdgDiscussionDeps } from "../src/modules/36-messaging/idg/deps";
import {
  buildMedicationQuestionDeps,
  createDbChannelFactsLookup,
} from "../src/modules/36-messaging/medication-questions/deps";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import {
  channelHintAudience,
  createDbMessagingProvider,
} from "../src/modules/36-messaging/messaging-provider-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { createOnCallCoverageService } from "../src/modules/36-messaging/oncall-directory/oncall-coverage-service";
import { buildM36MessageHintConsumer } from "../src/modules/36-messaging/outbox-consumers/message-hints";
import { buildPromotionDeps } from "../src/modules/36-messaging/promotions/deps";
import { buildReviewDeps } from "../src/modules/36-messaging/review/deps";
import { registerAdminAlertDeliveriesRoutes } from "../src/modules/36-messaging/routes/admin-alert-deliveries-routes";
import { registerAttachmentRoutes } from "../src/modules/36-messaging/routes/attachment-routes";
import { registerDraftRoutes } from "../src/modules/36-messaging/routes/draft-routes";
import { registerGlobalSearchSettingsRoutes } from "../src/modules/36-messaging/routes/global-search-settings-routes";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  CHANNEL_VISIBILITY_READ_PREDICATE,
  channelMemberAdminPredicate,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { registerOffboardingRoutes } from "../src/modules/36-messaging/routes/offboarding-routes";
import { registerScheduledSendRoutes } from "../src/modules/36-messaging/routes/scheduled-send-routes";
import { registerSessionDeviceRoutes } from "../src/modules/36-messaging/routes/session-device-routes";
import { registerTemplateRoutes } from "../src/modules/36-messaging/routes/template-routes";
import { registerMessagingWebhookRoutes } from "../src/modules/36-messaging/routes/webhook-routes";
import { createDbSbarPolicyStore } from "../src/modules/36-messaging/sbar/sbar-policy-store-db";
import { createDbScheduledSendService } from "../src/modules/36-messaging/scheduled/scheduled-send-service-db";
import { createSnoozeReminderService } from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-service";
import { createDbSnoozeReminderStore } from "../src/modules/36-messaging/snooze-reminders/snooze-reminder-store-db";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import { buildUrgentDeps } from "../src/modules/36-messaging/urgent/deps";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROUTES_DIR = join(__dirname, "../src/modules/36-messaging/routes");
// chartwarden_destruction is cluster-global and created by 0157/1139: a second applyMigrations in the same cluster (the realtime
// block below) fails at 1142 unless it is dropped between runs, like the other live suites do.
const ROLES = [
  "chartwarden_destruction",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];
const KEK = randomBytes(32);
const ORIGIN = "https://app.chartwarden.test";
const SECRET_BODY = "WP17-SECRET-BODY-must-never-appear-in-an-error";
const A_NAME_TOKEN = "WP17-ORG-A-PERSON";

// ── the route inventory (the coverage guard's source of truth) ───────────────────────────────────────────────
// `idor`: takes a tenant-scoped id (or a body id) and is attacked below. `scoped`: no foreign id to guess - the actor's own
// org/user is the only input, proved by comparing what two orgs see. `excluded`: not a tenant-user route, with the reason.
type Verdict =
  | { readonly kind: "idor" | "scoped" }
  | { readonly kind: "excluded"; readonly reason: string };
const TEMPLATE_SUITE =
  "WP 2.8: org/owner isolation, random-id 404 parity and RLS are asserted in m36-message-templates.live";
const GLOBAL_SEARCH_SETTINGS_SUITE =
  "WP 2.7b C4: org-scoped singleton (no id), permission + step-up + cross-tenant isolation are asserted in m36-global-search-settings.live";
const SESSION_DEVICES_SUITE =
  "WP 5.5: own-session scope, foreign / other-tenant / repeat revoke is one 404, officer bounded to the organisation: asserted in m36-session-device-controls.live";
const OFFBOARDING_SUITE =
  "WP 5.9: foreign / other-tenant / unknown user is one 404 (preview and execute), key + step-up + review key refusals, nothing changes: asserted in m36-workforce-offboarding.live";
const ROUTES: Record<string, Verdict> = {
  "GET /api/v1/messaging/channels": { kind: "scoped" },
  "GET /api/v1/messaging/channels/:id": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/messages": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/messages/:messageId/thread": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/mention-candidates": { kind: "idor" },
  // WP 2.3: names of colleagues outside the channel; same channel gate, same random-id answer for everyone else.
  "GET /api/v1/messaging/channels/:id/mention-non-members": { kind: "idor" },
  // WP 2.4 reactions and pins: channel-scoped, every refusal is the 404 a random id gets.
  "PUT /api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji": { kind: "idor" },
  "PUT /api/v1/messaging/channels/:id/messages/:messageId/pin": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/messages/:messageId/pin": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/pins": { kind: "idor" },
  // WP 3.6 IDG discussions: read-only list behind the pin list's exact guards (asserted below and in m36-idg-coordination.live).
  "GET /api/v1/messaging/channels/:id/idg-discussions": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/search": { kind: "idor" },
  // WP 2.12 presence/typing: the channel's guards run before anything else; ids only (asserted in m36-presence.live).
  "POST /api/v1/messaging/channels/:id/presence": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/presence": { kind: "idor" },
  // WP 2.5 drafts: the id is a channel's; a draft is also private to its author inside the channel (asserted below).
  "GET /api/v1/messaging/channels/:id/draft": { kind: "idor" },
  "PUT /api/v1/messaging/channels/:id/draft": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/draft": { kind: "idor" },
  // WP 2.6 scheduled send: create is channel-scoped; the others take the row id of the caller's OWN scheduled message (a
  // colleague's or another tenant's id answers as a random id; asserted below).
  "POST /api/v1/messaging/channels/:id/scheduled-messages": { kind: "idor" },
  "GET /api/v1/messaging/scheduled-messages": { kind: "scoped" },
  "PATCH /api/v1/messaging/scheduled-messages/:id": { kind: "scoped" },
  "DELETE /api/v1/messaging/scheduled-messages/:id": { kind: "scoped" },
  "POST /api/v1/messaging/channels/:id/messages": { kind: "idor" },
  "PATCH /api/v1/messaging/messages/:id": { kind: "idor" },
  "DELETE /api/v1/messaging/messages/:id": { kind: "idor" },
  "POST /api/v1/messaging/messages/:id/read": { kind: "idor" },
  "POST /api/v1/messaging/dm": { kind: "idor" },
  // WP 1.5 attachments: the id is an attachment's (or a body channelId); every refusal must be a random id's answer.
  "POST /api/v1/messaging/attachments/uploads": { kind: "idor" },
  "POST /api/v1/messaging/attachments/:id/complete": { kind: "idor" },
  "GET /api/v1/messaging/attachments/:id": { kind: "idor" },
  "GET /api/v1/messaging/attachments/:id/access": { kind: "idor" },
  "GET /api/v1/messaging/dm/staff": { kind: "scoped" },
  "POST /api/v1/messaging/patients/:patientId/care-team-channel": { kind: "idor" },
  // WP 3.1 patient context panel: per-tile permission re-check; a caller with no tile access gets an empty projection for
  // a real and a random patient alike (asserted below). Tile DATA isolation rests on each owning seam's RLS.
  "GET /api/v1/messaging/patients/:patientId/context": { kind: "idor" },
  // WP 3.2 clinical links: the id is a link's; org B, an in-org non-member, a hidden source and a random id all get the
  // identical `{state:"unavailable"}` (asserted below), and the source seam is never consulted for them.
  "GET /api/v1/messaging/clinical-links/:linkId/resolve": { kind: "idor" },
  // WP 3.3 SBAR policy: an org-scoped singleton with no id to guess; org comes from the request context only (two orgs'
  // views and writes are compared below, and the policy table's FORCE RLS is attacked as chartwarden_app in m36-sbar.live).
  "GET /api/v1/messaging/sbar/policy": { kind: "scoped" },
  "PUT /api/v1/messaging/template-admin/sbar-policy": { kind: "scoped" },
  "DELETE /api/v1/messaging/template-admin/sbar-policy": { kind: "scoped" },
  // WP 3.4 communication tasks: a task id (or the channel + message it converts) from another org or a non-participant
  // is the identical 404 a random id gets (asserted below); the list is the caller's own rows only. The tables' FORCE RLS,
  // grants and the participant rule are also attacked in m36-tasks.live.
  "POST /api/v1/messaging/channels/:id/messages/:messageId/tasks": { kind: "idor" },
  "GET /api/v1/messaging/tasks": { kind: "scoped" },
  "GET /api/v1/messaging/tasks/:taskId": { kind: "idor" },
  "POST /api/v1/messaging/tasks/:taskId/accept": { kind: "idor" },
  "POST /api/v1/messaging/tasks/:taskId/complete": { kind: "idor" },
  "POST /api/v1/messaging/tasks/:taskId/cancel": { kind: "idor" },
  "POST /api/v1/messaging/tasks/:taskId/reassign": { kind: "idor" },
  // WP 3.5 clinical handoffs: a handoff id from another org or from a non-participant is the identical 404 a random id
  // gets (asserted below); the list, caseload, prefill and policy routes are the caller's own org/user only. The tables'
  // FORCE RLS, grants and the participant rule are also attacked in m36-handoffs.live.
  "GET /api/v1/messaging/handoffs": { kind: "scoped" },
  "GET /api/v1/messaging/handoffs/caseload": { kind: "scoped" },
  "POST /api/v1/messaging/handoffs/prefill": { kind: "scoped" },
  "POST /api/v1/messaging/handoffs": { kind: "scoped" },
  "GET /api/v1/messaging/handoffs/policy": { kind: "scoped" },
  "GET /api/v1/messaging/handoffs/:handoffId": { kind: "idor" },
  "POST /api/v1/messaging/handoffs/:handoffId/accept": { kind: "idor" },
  "POST /api/v1/messaging/handoffs/:handoffId/decline": { kind: "idor" },
  "POST /api/v1/messaging/handoffs/:handoffId/cancel": { kind: "idor" },
  "PUT /api/v1/messaging/template-admin/handoff-policy": { kind: "scoped" },
  "DELETE /api/v1/messaging/template-admin/handoff-policy": { kind: "scoped" },
  // WP 3.8 lifecycle review queue: a review item id from another org is the identical 404 a random id gets (asserted
  // below); the list is the caller's own org only. The table's FORCE RLS, grants and finality are also attacked in
  // m36-lifecycle-review.live.
  "GET /api/v1/messaging/review-items": { kind: "scoped" },
  "POST /api/v1/messaging/review-items/:reviewItemId/reassign": { kind: "idor" },
  "POST /api/v1/messaging/review-items/:reviewItemId/close": { kind: "idor" },
  // WP 3.7 chart promotion: a promotion id (or the channel + message it proposes) from another org or a non-reader is the
  // identical refusal a random id gets (asserted below); the list is the caller's own rows only. The table's FORCE RLS,
  // grants and immutability are also attacked in m36-promotions.live.
  // WP 3.10 medication questions: the id is a channel's; every refusal (org B, a non-member, a random id, flag off) is the 404 a
  // random channel gets, and nothing is written (also attacked in m36-medication-question.live).
  "POST /api/v1/messaging/channels/:id/medication-questions": { kind: "idor" },
  // WP 4.1 urgent clinical: same shape as the medication question - the id is a channel's; every refusal (org B, a non-member, a
  // random id, flag off) is the 404 a random channel gets, and nothing is written (also attacked in m36-urgency.live).
  "POST /api/v1/messaging/channels/:id/urgent-messages": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/urgent-messages/options": { kind: "idor" },
  // WP 4.2 acknowledgment requests: the id is a request's (or a channel's / a body message id); every refusal (org B, a non-member,
  // a random id) is the 404 a random id gets and nothing is written (also attacked in m36-ack-requests.live).
  // WP 4.8 deep link: the id is a delivery's; another user's, another org's and a random id answer identically (also attacked in m36-delivery-target.live).
  "GET /api/v1/messaging/deliveries/:id/target": { kind: "idor" },
  // WP 4.10 snooze / reminders: the id is a channel's or a message's; the caller's OWN row is the only thing ever touched, and every
  // refusal (org B, a non-member, a random id, flag off) is the 404 a random id gets (also attacked in m36-snooze-reminder.live).
  "GET /api/v1/messaging/channels/:id/snooze": { kind: "idor" },
  "PUT /api/v1/messaging/channels/:id/snooze": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/snooze": { kind: "idor" },
  "GET /api/v1/messaging/reminders": { kind: "scoped" },
  "PUT /api/v1/messaging/messages/:id/reminder": { kind: "idor" },
  "DELETE /api/v1/messaging/messages/:id/reminder": { kind: "idor" },
  // WP 4.12 on-call directory / ADR-0081 role-based send: the guessable ids are a PATIENT's (query or body) and, for the send, a
  // channel's. A chart-read gate (patient.read + caseload_or_scope) then an ORG-SCOPED existence check give an org-B caller, and a
  // missing patient, the one `resource` 404; the two channel routes also stop an in-org non-member at channel visibility (the coverage route takes no channel: its in-org scope is the real caseload_or_scope predicate, stubbed permissive here and proved in m36-oncall-directory.live). patientExists/channelPatient are test-local org-filtered stand-ins for the PatientReader seam. Every refusal is the
  // answer a random id gets and nothing is written (also attacked in m36-oncall-directory.live / m36-role-send.live).
  "GET /api/v1/messaging/oncall/coverage": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/role-send/resolution": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/role-send": { kind: "idor" },
  // WP 4.9 supervisor queue: no id to guess - the caller's organisation is the only scope (proved below and in m36-unacknowledged.live).
  "GET /api/v1/messaging/escalations/unacknowledged": { kind: "scoped" },
  // WP 6.1 smart work inbox: no id to guess - the caller's own assigned work in the caller's organisation is the only scope.
  "GET /api/v1/messaging/inbox": { kind: "scoped" },
  "POST /api/v1/messaging/escalations": { kind: "idor" },
  "GET /api/v1/messaging/escalations/:id": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/escalations": { kind: "idor" },
  "POST /api/v1/messaging/escalations/:id/acknowledge": { kind: "idor" },
  "POST /api/v1/messaging/escalations/:id/reassign": { kind: "idor" },
  "POST /api/v1/messaging/escalations/:id/resolve": { kind: "idor" },
  // ADR-0078: the card's picker and the supervisor reassign; the id is a request's, every refusal is the 404 a random id gets.
  "GET /api/v1/messaging/escalations/:id/reassign-candidates": { kind: "idor" },
  "GET /api/v1/messaging/escalations/:id/supervisor-reassign-candidates": { kind: "idor" },
  "POST /api/v1/messaging/escalations/:id/supervisor-reassign": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/medication-questions/options": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions": { kind: "idor" },
  "GET /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions": { kind: "idor" },
  "GET /api/v1/messaging/chart-promotions": { kind: "scoped" },
  "GET /api/v1/messaging/chart-promotions/:promotionId": { kind: "idor" },
  "POST /api/v1/messaging/chart-promotions/:promotionId/withdraw": { kind: "idor" },
  // Admin screens PR 1a: org_admin member list + archive; attacked in m36-channel-admin.live.test.ts.
  "GET /api/v1/messaging/channels/:id/members": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/archive": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/unarchive": { kind: "idor" },
  "POST /api/v1/messaging/channels/:id/members": { kind: "idor" },
  "DELETE /api/v1/messaging/channels/:id/members/:userId": { kind: "idor" },
  "POST /api/v1/messaging/announce": { kind: "scoped" },
  // WP 2.9: the id is an announcement message's / a location or role id in the body.
  "GET /api/v1/messaging/announcements/:messageId/receipts": { kind: "idor" },
  "POST /api/v1/messaging/department-channels": { kind: "idor" },
  "GET /api/v1/notifications/preferences": { kind: "scoped" },
  "PUT /api/v1/notifications/preferences": { kind: "idor" },
  "POST /api/v1/notifications/endpoints": { kind: "scoped" },
  "POST /api/v1/notifications/endpoints/:id/verify": { kind: "idor" },
  "DELETE /api/v1/notifications/endpoints/:id": { kind: "idor" },
  "GET /api/v1/alerts/inbox": { kind: "scoped" },
  "POST /api/v1/alerts/:id/read": { kind: "idor" },
  "GET /api/v1/alert-rules": { kind: "scoped" },
  "PATCH /api/v1/alert-rules/:id": { kind: "idor" },
  "GET /api/v1/admin/messaging/alert-deliveries": {
    kind: "excluded",
    reason: "platform_ops, deliberately cross-tenant; a tenant admin is refused (asserted below)",
  },
  // WP 2.8 message templates: attacked in their own live suite (m36-message-templates.live), which owns the matrix.
  "GET /api/v1/messaging/templates": { kind: "excluded", reason: TEMPLATE_SUITE },
  "GET /api/v1/messaging/templates/:id": { kind: "excluded", reason: TEMPLATE_SUITE },
  "POST /api/v1/messaging/templates/personal": { kind: "excluded", reason: TEMPLATE_SUITE },
  "PATCH /api/v1/messaging/templates/personal/:id": { kind: "excluded", reason: TEMPLATE_SUITE },
  "DELETE /api/v1/messaging/templates/personal/:id": { kind: "excluded", reason: TEMPLATE_SUITE },
  "GET /api/v1/messaging/template-admin": { kind: "excluded", reason: TEMPLATE_SUITE },
  "POST /api/v1/messaging/template-admin/shared": { kind: "excluded", reason: TEMPLATE_SUITE },
  "PATCH /api/v1/messaging/template-admin/shared/:id": { kind: "excluded", reason: TEMPLATE_SUITE },
  "DELETE /api/v1/messaging/template-admin/shared/:id": {
    kind: "excluded",
    reason: TEMPLATE_SUITE,
  },
  "PUT /api/v1/messaging/template-admin/platform/:id/overlay": {
    kind: "excluded",
    reason: TEMPLATE_SUITE,
  },
  "DELETE /api/v1/messaging/template-admin/platform/:id/overlay": {
    kind: "excluded",
    reason: TEMPLATE_SUITE,
  },
  "GET /api/v1/messaging/global-search/settings": {
    kind: "excluded",
    reason: GLOBAL_SEARCH_SETTINGS_SUITE,
  },
  "PUT /api/v1/messaging/global-search/settings": {
    kind: "excluded",
    reason: GLOBAL_SEARCH_SETTINGS_SUITE,
  },
  // WP 5.5 (ADR-0083): a session is acted on by its own owner (or, for the officer, within the officer's organisation); a foreign, other-tenant,
  // unknown and already-revoked id are one 404, asserted with real Better Auth sessions as chartwarden_app in m36-session-device-controls.live.
  "GET /api/v1/devices": { kind: "excluded", reason: SESSION_DEVICES_SUITE },
  "DELETE /api/v1/devices/:id": { kind: "excluded", reason: SESSION_DEVICES_SUITE },
  "GET /api/v1/messaging/governance/sessions": { kind: "excluded", reason: SESSION_DEVICES_SUITE },
  "DELETE /api/v1/messaging/governance/sessions/:id": {
    kind: "excluded",
    reason: SESSION_DEVICES_SUITE,
  },
  // WP 5.9 (ADR-0084): the :userId is a departed user in the officer's own organisation; another tenant's and an unknown id are one 404.
  "GET /api/v1/messaging/governance/offboarding/:userId": {
    kind: "excluded",
    reason: OFFBOARDING_SUITE,
  },
  "POST /api/v1/messaging/governance/offboarding/:userId/execute": {
    kind: "excluded",
    reason: OFFBOARDING_SUITE,
  },
  "POST /webhooks/twilio/sms-status": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
  "POST /webhooks/twilio/voice-status": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
  "POST /webhooks/postmark/event": {
    kind: "excluded",
    reason: "vendor-signed, no tenant principal; unsigned call refused (asserted below)",
  },
};
/** The registrar files under routes/ - a new file must be classified here, then mounted in `registeredRoutes`. */
const REGISTRAR_FILES = [
  "admin-alert-deliveries-routes.ts",
  "announcement-routes.ts",
  "announcement-typebox.ts", // schemas only
  "attachment-routes.ts",
  "draft-routes.ts",
  "draft-typebox.ts", // schemas only
  "scheduled-send-routes.ts",
  "search-routes.ts", // WP 2.7a in-conversation search
  "search-typebox.ts", // schemas only
  "scheduled-send-typebox.ts", // schemas only
  "messaging-routes.ts",
  "messaging-typebox.ts", // schemas only
  "oncall-routes.ts", // WP 4.12 on-call directory, mounted by registerMessagingRoutes
  "oncall-typebox.ts", // schemas only
  "role-send-routes.ts", // ADR-0081 role-based send, mounted by registerMessagingRoutes
  "role-send-typebox.ts", // schemas only
  "reaction-pin-routes.ts", // mounted by registerMessagingRoutes
  "reaction-pin-typebox.ts", // schemas only
  "global-search-routes.ts", // WP 2.7b global search (inert until enabled)
  "global-search-typebox.ts", // schemas only
  "poll-routes.ts", // WP 2.10 polls
  "poll-typebox.ts", // schemas only
  "presence-routes.ts", // WP 2.12 presence/typing
  "presence-typebox.ts", // schemas only
  "global-search-settings-routes.ts", // WP 2.7b C4 tenant global search switch
  "global-search-settings-typebox.ts", // schemas only
  "clinical-link-routes.ts", // WP 3.2 link resolve, mounted by registerMessagingRoutes
  "clinical-link-typebox.ts", // schemas only
  "sbar-routes.ts", // WP 3.3 SBAR policy, mounted by registerMessagingRoutes
  "sbar-typebox.ts", // schemas only
  "task-routes.ts", // WP 3.4 communication tasks, mounted by registerMessagingRoutes
  "task-typebox.ts", // schemas only
  "handoff-routes.ts", // WP 3.5 clinical handoffs, mounted by registerMessagingRoutes
  "handoff-typebox.ts", // schemas only
  "review-routes.ts", // WP 3.8 lifecycle review queue, mounted by registerMessagingRoutes
  "review-typebox.ts", // schemas only
  "medication-question-routes.ts", // WP 3.10 medication questions, mounted by registerMessagingRoutes
  "medication-question-typebox.ts", // schemas only
  "urgent-routes.ts", // WP 4.1 urgent clinical message, mounted by registerMessagingRoutes
  "delivery-target-routes.ts", // WP 4.8 deep-link resolver, mounted by registerMessagingRoutes
  "delivery-target-typebox.ts", // schemas only
  "unacknowledged-routes.ts", // WP 4.9 supervisor unacknowledged queue, mounted by registerMessagingRoutes
  "inbox-routes.ts", // WP 6.1 smart work inbox, mounted by registerMessagingRoutes
  "inbox-typebox.ts", // schemas only
  "snooze-reminder-routes.ts", // WP 4.10 snooze and reminders, mounted by registerMessagingRoutes
  "snooze-reminder-typebox.ts", // schemas only
  "unacknowledged-typebox.ts", // schemas only
  "ack-routes.ts", // WP 4.2 acknowledgment requests, mounted by registerMessagingRoutes
  "ack-typebox.ts", // schemas only
  "urgent-typebox.ts", // schemas only
  "promotion-routes.ts", // WP 3.7 chart promotion, mounted by registerMessagingRoutes
  "promotion-typebox.ts", // schemas only
  "idg-discussion-routes.ts", // WP 3.6 IDG discussions, mounted by registerMessagingRoutes
  "idg-discussion-typebox.ts", // schemas only
  "patient-context-routes.ts", // WP 3.1 context panel, mounted by registerMessagingRoutes
  "patient-context-typebox.ts", // schemas only
  "template-routes.ts",
  "template-typebox.ts", // schemas only
  "session-device-routes.ts", // WP 5.5 device and session manager (own sessions; officer variant bounded to the organisation)
  "session-device-typebox.ts", // schemas only
  "offboarding-routes.ts", // WP 5.9 workforce offboarding (preview and execute; officer bounded to the organisation)
  "offboarding-typebox.ts", // schemas only
  // Registrars mounted by the composition root (index.ts), not by `registeredRoutes` above: they need a real service graph (flags, step-up,
  // artefact store), so their route-level cross-tenant proof lives in each feature's own live suite, run as chartwarden_app on real RLS.
  "retention-governance-routes.ts", // WP 5.6 legal hold: org-wide, officer-only; foreign/unknown hold is one 404 - m36-retention-governance.live "CROSS-TENANT"
  "retention-governance-typebox.ts", // schemas only
  "message-redaction-routes.ts", // WP 5.6 redaction request/approve/self-approve/countersign: org-bound; a foreign or unknown id is the same 404 - m36-retention-governance.live "CROSS-TENANT (IDOR)"
  "export-routes.ts", // WP 5.7 restricted export: job get/approve/reject/cancel/download are 404 across orgs - m36-export.live "another organisation"
  "export-typebox.ts", // schemas only
  "break-glass-routes.ts", // WP 5.8 break-glass: open/end/review/complete are the random-id 404 across orgs - m36-break-glass.live "CROSS-TENANT"
  "break-glass-typebox.ts", // schemas only
  "ack-broadcast-routes.ts", // WP 6.8 ack-required broadcast: org B gets 404 by id and an empty list, RLS hides the rows as chartwarden_app, a non-creator announcer gets the uniform 404 - m36-ack-broadcast.live "tenancy"
  "ack-broadcast-typebox.ts", // schemas only
  "death-board-routes.ts", // WP 6.9 death-event board (flag off): a foreign-tenant or non-viewer id is the missing-board 404, byte-identical body, FORCEd RLS hides the rows - m36-death-board.live "3. routes"
  "death-board-typebox.ts", // schemas only
  "external-share-routes.ts", // ADR-0096 external partner share (flag off): another org's staff lists/revokes nothing, a bearer or invitation under another org matches nothing, RLS on all three tables - m36-external-share.live "tenancy"
  "external-share-typebox.ts", // schemas only
  "uuid-params.ts", // preHandler helper, no routes
  "webhook-routes.ts",
];

function registeredRoutes(): string[] {
  const probe = Fastify();
  const seen = new Set<string>();
  probe.addHook("onRoute", (route) => {
    for (const m of ([] as string[]).concat(route.method as string | string[])) {
      if (m !== "HEAD" && m !== "OPTIONS") seen.add(`${m} ${route.url}`);
    }
  });
  registerMessagingRoutes(probe, { service: {} as never, announcements: {} as never });
  registerAttachmentRoutes(probe, { service: {} as never });
  registerDraftRoutes(probe, { service: {} as never });
  registerScheduledSendRoutes(probe, { service: {} as never, announcements: {} as never });
  registerAdminAlertDeliveriesRoutes(probe, {} as never);
  registerTemplateRoutes(probe, { service: {} as never });
  registerGlobalSearchSettingsRoutes(probe, { service: {} as never });
  registerMessagingWebhookRoutes(probe, { publicBaseUrl: "https://x.test" } as never);
  registerSessionDeviceRoutes(probe, { service: {} as never });
  registerOffboardingRoutes(probe, { service: {} as never });
  return [...seen].sort();
}

// ── principals & helpers ─────────────────────────────────────────────────────────────────────────────────────
interface Who {
  readonly name: string;
  readonly userId: string;
  readonly org: string;
  readonly roles: readonly string[];
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles ? roles.split(",") : ["clinical_rn"];
  request.context.locationIds = [];
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VOLATILE_KEYS = new Set(["requestId", "correlationId", "timestamp", "traceId"]);
/** An on-call router that always resolves tier 1 to these users (the roster is not under test; tenancy is). */
function coveredBy(...ids: [string, ...string[]]): EscalationRouter {
  return {
    resolveTier: async (_org, request) =>
      ({
        kind: "resolved",
        userIds: ids,
        ranks: ids.map((_, i) => (i === 0 ? "primary" : "backup")),
        nextTier: null,
        timeZone: "America/Los_Angeles",
        tier: request.tier,
        asOf: request.asOf,
        source: "m19",
      }) as EscalationRouteAnswer,
  };
}

/** Status + body with ids and per-request fields masked, so a real id and a random id can be compared exactly. */
function shape(res: { statusCode: number; body: string }): string {
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // non-JSON body: compared verbatim
  }
  const scrub = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(scrub)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !VOLATILE_KEYS.has(k))
              .map(([k, x]) => [k, scrub(x)]),
          )
        : typeof v === "string"
          ? v.replace(UUID, "<id>")
          : v;
  return `${res.statusCode} ${JSON.stringify(scrub(body))}`;
}

describe.skipIf(!DB_URL)("M36 WP 1.7 tenant & IDOR proof — LIVE Postgres", () => {
  let admin: Client;
  let appUrl: string;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let u1: Who;
  let promoterA: Who; // WP 3.7: an org-A proposer who is NOT a member of the channel
  let promoterB: Who; // WP 3.7: an org-B proposer
  let reviewerB: Who; // WP 3.8: an org-B holder of messaging.review
  let u2: Who;
  let outsider: Who;
  let adminA: Who;
  let bUser: Who;
  let b2: Who;
  let adminB: Who;
  let patientA: string;
  let dmA: string;
  let locA: string;
  let dmB: string;
  let msgDmA: string;
  let msgLocA: string;
  let linkA: string; // WP 3.2: a clinical link on a message in dmA
  const LINK_SOURCE = randomUUID();
  let linkSourceCalls = 0;
  let endpointA: string;
  let alertA: string;
  let ruleA: string;
  let careTeamA: string;
  let attClean: string; // a clean attachment bound to a message in dmA
  let attPending: string; // completed, awaiting a verdict
  let attQuarantined: string; // infected
  let attUnattached: string; // clean, not yet sent
  const exercised = new Set<string>();
  const attackers = new Set<string>();

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  const seedUser = async (name: string, org: string, roles: string[], label: string) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp17-${name}@x.test`,
        `${label} ${name}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [id, org],
    );
    return { name, userId: id, org, roles } satisfies Who;
  };

  const headers = (who: Who, extra: Record<string, string> = {}) => ({
    "x-test-user": who.userId,
    "x-test-org": who.org,
    "x-test-roles": who.roles.join(","),
    ...extra,
  });

  /** One request against a ROUTES key; `params` fills `:id`/`:userId`/`:patientId`. */
  async function call(
    route: string,
    who: Who,
    params: Record<string, string> = {},
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
    query = "",
  ) {
    expect(ROUTES[route], `unknown route ${route}`).toBeDefined();
    const [method, template] = route.split(" ") as [string, string];
    let url = template;
    for (const [k, v] of Object.entries(params)) url = url.replace(`:${k}`, v);
    exercised.add(route);
    if (attackers.has(who.name)) exercisedByAttacker.add(route);
    const needsKey =
      route === "POST /api/v1/messaging/channels/:id/messages" ||
      route === "POST /api/v1/messaging/channels/:id/scheduled-messages" ||
      route === "POST /api/v1/messaging/attachments/uploads" ||
      route === "POST /api/v1/messaging/attachments/:id/complete" ||
      route === "POST /api/v1/messaging/announce" ||
      route === "POST /api/v1/messaging/channels/:id/medication-questions" ||
      route === "POST /api/v1/messaging/channels/:id/urgent-messages" ||
      route === "POST /api/v1/messaging/channels/:id/role-send" ||
      route === "POST /api/v1/messaging/escalations" ||
      route === "PUT /api/v1/messaging/channels/:id/snooze" ||
      route === "PUT /api/v1/messaging/messages/:id/reminder";
    const res = await app.inject({
      method: method as "GET",
      url: url + query,
      headers: headers(who, {
        ...(needsKey ? { "idempotency-key": randomUUID() } : {}),
        ...extraHeaders,
      }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return res;
  }
  const exercisedByAttacker = new Set<string>();

  /** The world fingerprint: a row-hash of every table an M36 write could touch, plus audit and outbox. */
  const FINGERPRINT_TABLES = [
    "channel",
    "channel_member",
    "message",
    "message_revision",
    "message_receipt",
    "message_attachment",
    "message_draft",
    "scheduled_message",
    "message_search_token",
    "attachment_access_event",
    "message_entity_reference",
    "clinical_link",
    "tenant_sbar_policy",
    "communication_task",
    "communication_task_event",
    "clinical_handoff",
    "clinical_handoff_item",
    "clinical_handoff_event",
    "tenant_handoff_policy",
    "chart_promotion_request",
    "messaging_review_item",
    "message_reaction",
    "message_pin",
    "delivery_endpoint",
    "user_notification_preferences",
    "alert_rule",
    "alert_receipt",
    "audit_event",
    "outbox_event",
  ];
  async function fingerprint(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of FINGERPRINT_TABLES) {
      const r = await admin.query(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
      );
      out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
    }
    return out;
  }
  const cell = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows[0].n as number;

  /** attacker's call with a real foreign id must be indistinguishable from the same call with a random id. */
  async function expectNoOracle(
    route: string,
    attacker: Who,
    real: Record<string, string>,
    payload?: unknown,
    query = "",
  ) {
    attackers.add(attacker.name);
    const control = Object.fromEntries(Object.keys(real).map((k) => [k, randomUUID()]));
    const got = await call(route, attacker, real, payload, {}, query);
    const ctl = await call(route, attacker, control, payload, {}, query);
    const label = `${attacker.name} ${route} ${JSON.stringify(real)}`;
    expect(got.statusCode, `${label}: ${got.body}`).toBeGreaterThanOrEqual(400);
    expect(got.statusCode, label).toBeLessThan(500);
    expect(shape(got), `${label}: differs from a nonexistent id`).toBe(shape(ctl));
    expectNoLeak(got.body, attacker, label);
  }
  function expectNoLeak(body: string, attacker: Who, label: string) {
    expect(body, label).not.toContain(SECRET_BODY);
    expect(body, label).not.toContain(A_NAME_TOKEN);
    for (const w of [u1, u2, adminA, outsider]) {
      if (w.userId !== attacker.userId)
        expect(body, `${label} leaks ${w.name}`).not.toContain(w.userId);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    orgA = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('wp17-a','A','A') RETURNING id",
      )
    ).rows[0].id as string;
    orgB = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('wp17-b','B','B') RETURNING id",
      )
    ).rows[0].id as string;
    u1 = await seedUser("u1", orgA, ["clinical_rn"], A_NAME_TOKEN);
    u2 = await seedUser("u2", orgA, ["clinical_rn"], A_NAME_TOKEN);
    outsider = await seedUser("outsider", orgA, ["clinical_rn"], A_NAME_TOKEN);
    adminA = await seedUser("adminA", orgA, ["org_admin"], A_NAME_TOKEN);
    bUser = await seedUser("b1", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    b2 = await seedUser("b2", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    adminB = await seedUser("adminB", orgB, ["org_admin"], "WP17-ORG-B-PERSON");
    promoterA = await seedUser("promoterA", orgA, ["clinical_rn"], A_NAME_TOKEN);
    promoterB = await seedUser("promoterB", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    reviewerB = await seedUser("reviewerB", orgB, ["clinical_rn"], "WP17-ORG-B-PERSON");
    patientA = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-WP17','Care','Team','1990-01-01','F','active') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [patientA, orgA, u1.userId],
    );

    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    registerPatientSeams({
      db: handle.db,
      careTeam: { store: createDrizzleCareTeamStore(handle.db) },
      readerStore: createDrizzlePatientReaderStore(handle.db),
    });
    registerSeam("ConsentEvaluator", createDbConsentEvaluator(handle.db));

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
    };
    const provider = createDbMessagingProvider(handle.db);
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: outbox as never,
      syncCareTeamChannel: (o, p) => provider.syncCareTeamChannel(o, p),
      sendEndpointVerificationCode: async () => undefined,
    });

    const base = ["messaging.read", "messaging.send", "messaging.dm", "orders.read"];
    const self = ["notifications.preferences.manage", "notifications.endpoint.manage"];
    const adminKeys = [
      "messaging.manage_members",
      "messaging.template.manage",
      "messaging.announce",
      "alert.rules.read",
      "alert.rules.manage",
    ];
    const grants = createInMemoryEffectivePermissionStore(
      [u1, u2, outsider, adminA, bUser, b2, adminB, promoterA, promoterB, reviewerB].map((w) => ({
        orgId: w.org,
        userId: w.userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              ...base,
              ...self,
              // WP 3.5: only the two org-A members who hand work off hold the patient-read gate the handoff routes add.
              ...(w === u1 || w === u2 ? ["patient.read"] : []),
              // WP 3.7: proposers hold messaging.promote and patient.read; the two attackers promoterA / promoterB hold
              // BOTH, so only channel visibility / tenancy (not a missing permission) can stop them.
              ...(w === u1 || w === u2 || w === promoterA || w === promoterB
                ? ["messaging.promote", "patient.read"]
                : []),
              // WP 3.8: the org-A reviewer u1 and the org-B reviewerB hold the queue permission (reviewerB also
              // patient.read), so only tenancy - not a missing permission - stops reviewerB. The queue is org-wide for
              // its permission holders by design, so no org-A attacker holds it.
              // WP 4.1: EVERY persona holds messaging.urgent.send, so only channel visibility / tenancy stops an attacker.
              "messaging.urgent.send",
              // WP 4.2: EVERY persona also holds messaging.urgent.receive, so the acknowledge / resolve routes are stopped only by
              // tenancy and the assignee rule, never by a missing key.
              "messaging.urgent.receive",
              // WP 4.12 / ADR-0081: EVERY persona holds both on-call keys, and the org-B reviewer / promoter already hold patient.read (the
              // scope stub passes patient A for any holder), so only the org-scoped patient check / channel visibility stops them.
              "messaging.oncall.read",
              "messaging.oncall.send",
              ...(w === u1 ? ["messaging.review"] : []),
              ...(w === reviewerB ? ["messaging.review", "patient.read"] : []),
              ...(w.roles.includes("org_admin") ? adminKeys : ["alert.rules.read"]),
            ],
          },
        ],
      })),
    );
    registerEffectivePermissionResolver(grants.store);
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    // ADR-0087: the read GETs (detail, message list, thread) gate on membership OR a live break-glass grant.
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return service.canReadChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
    // WP 3.2: the attackers HOLD the order permission and pass this scope; only channel visibility / tenancy can stop them.
    registry.register("caseload_or_scope", async (_ctx, target) => target.patientId === patientA);
    registerAbacRegistry(registry);

    app = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    const unackQueueService = createUnacknowledgedService({
      read: createDbUnacknowledgedReader(handle.db),
      canViewChannel: service.canViewChannel,
      displayName: async () => null,
    });
    registerMessagingRoutes(app, {
      service,
      announcements: createDbAnnouncementService(handle.db),
      clinicalLinks: {
        isEnabled: async () => true,
        sources: {
          summary: async (_kind, _org, id) => {
            linkSourceCalls += 1;
            return id === LINK_SOURCE
              ? { id, patientId: patientA as never, status: "active", occurredAt: null }
              : null;
          },
        },
        store: createDbClinicalLinkStore(handle.db),
      },
      sbar: { isEnabled: async () => true, store: createDbSbarPolicyStore(handle.db) },
      idgDiscussions: buildIdgDiscussionDeps({
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        flags: {
          forOrg: async () => ({ "messaging.idg": true, "messaging.clinical_links": true }),
        },
      }),
      tasks: buildTaskDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.tasks": true }) },
        messaging: service,
        careTeamMembers: async () => [],
      }),
      handoffs: buildHandoffDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.handoffs": true }) },
        outbox: outbox as never,
        messaging: service,
        // Only the org-A member u1 has a caseload; everyone else (attackers included) has none.
        caseloadPatientIds: async (_org, userId) => (userId === u1.userId ? [patientA] : []),
        patientLabels: async (_org, ids) =>
          new Map(ids.map((id) => [id, { displayName: "Pat P.", mrnSuffix: "0001" }] as const)),
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        permissionsFor: async () => new Set(["messaging.read", "messaging.send", "patient.read"]),
      }),
      review: buildReviewDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.tasks": true }) },
        outbox: outbox as never,
        messaging: service,
        patientLabels: async (_org, ids) =>
          new Map(ids.map((id) => [id, { displayName: "Pat P.", mrnSuffix: "0001" }] as const)),
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      }),
      medicationQuestions: buildMedicationQuestionDeps({
        db: handle.db,
        flags: {
          forOrg: async () => ({ "messaging.medication_questions": true, "messaging.tasks": true }),
        },
        outbox: outbox as never,
        messaging: service,
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        permissionsFor: async () => new Set(["messaging.read", "messaging.send", "patient.read"]),
        careTeamMembers: async () => [],
        primaryRn: async () => null,
      }),
      urgent: buildUrgentDeps({
        db: handle.db,
        flags: {
          forOrg: async () => ({ "messaging.urgent_clinical": true, "messaging.sbar": true }),
        },
        outbox: outbox as never,
        messaging: service,
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        permissionsFor: async () =>
          new Set(["messaging.read", "messaging.send", "patient.read", "messaging.urgent.receive"]),
        careTeamMembers: async () => [],
      }),
      unacknowledged: { service: unackQueueService },
      inbox: {
        service: buildSmartInboxService({
          isEnabled: async () => true,
          unacknowledged: unackQueueService,
          listChannels: service.listChannels,
        }),
      },
      oncall: {
        // The org-scoped existence check under test (the real one is RLS-backstopped; this one filters by org explicitly).
        patientExists: async (org, id) =>
          (await admin.query("SELECT 1 FROM patient WHERE organization_id=$1 AND id=$2", [org, id]))
            .rowCount === 1,
        service: createOnCallCoverageService({
          isEnabled: async () => true,
          router: coveredBy(u2.userId),
          displayName: async () => null,
        }),
        roleSend: {
          isEnabled: async () => true,
          router: guardEscalationRouter({
            resolveTier: (org, req) => coveredBy(u2.userId).resolveTier(org, req),
          }),
          displayName: createMentionActorNameResolver(handle.db),
          channelPatient: async (org, ch) => {
            const facts = await createDbChannelFactsLookup(handle.db)(org, ch);
            return facts?.kind === "care_team" ? facts.subjectId : null;
          },
          findReplay: createDbRoleReplayLookup(handle.db),
        },
      },
      snoozeReminders: {
        service: createSnoozeReminderService({
          isEnabled: async () => true,
          store: createDbSnoozeReminderStore(handle.db),
          canViewChannel: service.canViewChannel,
        }),
      },
      deliveryTarget: {
        service: createDeliveryTargetService({
          read: createDbDeliveryTargetReader(handle.db),
          messaging: service,
          openRequestId: createOpenRequestLookup(createDbAckStore(handle.db)),
        }),
      },
      ackRequests: {
        service: buildAckDeps({
          db: handle.db,
          flags: { forOrg: async () => ({ "messaging.ack_requests": true }) },
          outbox: outbox as never,
          messaging: service,
          part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
          permissionsFor: async () =>
            new Set([
              "messaging.read",
              "messaging.send",
              "patient.read",
              "messaging.urgent.receive",
            ]),
          careTeamMembers: async () => [u1.userId, u2.userId],
        }).service,
      },
      promotions: buildPromotionDeps({
        db: handle.db,
        flags: { forOrg: async () => ({ "messaging.promotions": true }) },
        outbox: outbox as never,
        messaging: service,
        bodyOpener: createMessageBodyCipher({ kek: KEK }),
        part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
        permissionsFor: async () =>
          new Set(["messaging.read", "messaging.send", "messaging.promote", "patient.read"]),
      }),
    });
    const blobs = new Map<string, Uint8Array>();
    const fakeStorage: AttachmentStoragePort = {
      presignUpload: async ({ objectKey }) => ({
        url: `https://objects.test/put/${objectKey}`,
        headers: {},
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
      inspect: async ({ objectKey }) => {
        const b = blobs.get(objectKey);
        return b
          ? { byteSize: b.length, mimeType: "application/pdf", sha256Hex: sha256Of(b) }
          : null;
      },
      readBytes: async ({ objectKey }) => blobs.get(objectKey) ?? null,
      destroyObject: async ({ objectKey }) => {
        blobs.delete(objectKey);
      },
      presignDownload: async ({ objectKey, ttlSeconds }) => ({
        url: `https://objects.test/get/${objectKey}`,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }),
    };
    const attachmentService = createAttachmentService({
      db: handle.db,
      storage: fakeStorage,
      scanner: createBuiltinScanner(),
      outbox: outbox as never,
      canViewChannel: service.canViewChannel,
    });
    registerAttachmentRoutes(app, { service: attachmentService });
    registerDraftRoutes(app, {
      service: createDbDraftService({
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
      }),
    });
    registerScheduledSendRoutes(app, {
      service: createDbScheduledSendService({
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        canViewChannel: service.canViewChannel,
      }),
      announcements: createDbAnnouncementService(handle.db),
    });
    /** Upload + complete a file as `who` straight through the service (the fixture, not an attack). */
    const makeAttachment = async (who: Who, channelId: string, text: string, scan = true) => {
      const bytes = new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);
      const up = await attachmentService.authorize(who.org, {
        userId: who.userId,
        channelId,
        fileName: "wp17-attachment.pdf",
        contentType: "application/pdf",
        byteSize: bytes.length,
        sha256Hex: sha256Of(bytes),
      });
      const key = (
        await admin.query("SELECT object_key FROM message_attachment WHERE id=$1", [
          up.attachmentId,
        ])
      ).rows[0].object_key as string;
      blobs.set(key, bytes);
      if (scan)
        await attachmentService.complete(who.org, {
          userId: who.userId,
          attachmentId: up.attachmentId,
        });
      else {
        // completed but never scanned: a service with no scanner leaves it pending
        const noScan = createAttachmentService({
          db: handle.db,
          storage: fakeStorage,
          canViewChannel: service.canViewChannel,
        });
        await noScan.complete(who.org, { userId: who.userId, attachmentId: up.attachmentId });
      }
      return up.attachmentId;
    };

    // ── fixtures: org A's private world, org B's own ────────────────────────────────────────────────────────
    dmA = (await service.openDm(orgA, u1.userId, u2.userId)).channelId;
    dmB = (await service.openDm(orgB, bUser.userId, b2.userId)).channelId;
    locA = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location',$2,'WP17 private location','care_related') RETURNING id`,
        [orgA, randomUUID()],
      )
    ).rows[0].id as string;
    for (const w of [u1, u2]) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [orgA, locA, w.userId],
      );
    }
    msgDmA = (
      await service.sendMessage(orgA, {
        channelId: dmA,
        authorUserId: u1.userId,
        body: SECRET_BODY,
      })
    ).messageId;
    msgLocA = (
      await service.sendMessage(orgA, {
        channelId: locA,
        authorUserId: u1.userId,
        body: SECRET_BODY,
      })
    ).messageId;
    // WP 3.2: a message in A's private DM that links an order (the link row is written by the real write core).
    const linkMsg = (
      await service.sendMessage(orgA, {
        channelId: dmA,
        authorUserId: u1.userId,
        body: "[linked record]",
        bodyKind: "rich",
        richBody: {
          schemaVersion: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "clinicalLink", kind: "order", entityId: LINK_SOURCE }],
              },
            ],
          },
        } as never,
        clinicalLinks: [{ kind: "order", sourceId: LINK_SOURCE, patientId: patientA }],
      })
    ).messageId;
    linkA = (await admin.query("SELECT id FROM clinical_link WHERE message_id=$1", [linkMsg]))
      .rows[0].id as string;
    await service.editMessage(orgA, {
      userId: u1.userId,
      messageId: msgDmA,
      body: `${SECRET_BODY} (edited)`,
    });
    await service.sendMessage(orgB, {
      channelId: dmB,
      authorUserId: bUser.userId,
      body: "org B hello",
    });
    await admin.query(
      `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename)
       VALUES ($1,$2,$3,$4,'application/pdf',10,'wp17.pdf')`,
      [orgA, dmA, msgDmA, u1.userId],
    );
    attClean = await makeAttachment(u1, dmA, "clean");
    attUnattached = await makeAttachment(u1, dmA, "unattached");
    attPending = await makeAttachment(u1, dmA, "pending", false);
    attQuarantined = await makeAttachment(
      u1,
      dmA,
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    await service.sendMessage(orgA, {
      channelId: dmA,
      authorUserId: u1.userId,
      body: "with a file",
      attachments: [{ attachmentId: attClean }],
    });
    careTeamA = (await service.openCareTeamChannel(orgA, u1.userId, patientA)).channelId;
    endpointA = (
      await service.registerEndpoint(orgA, u1.userId, { channel: "email", target: "wp17-a@x.test" })
    ).endpointId;
    await service.putPreferences(orgA, u1.userId, {
      routingMap: {},
      quietHours: { tz: "Pacific/Auckland", ranges: [], severityOverride: "critical" },
      vacationForwardToUserId: null,
      vacationUntil: null,
    });
    alertA = (
      await admin.query(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id)
         VALUES ($1,'m36.test','warn','{"secret":"${A_NAME_TOKEN}"}','wp17') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel)
       VALUES ($1,$2,'clinical_routine','warn','email')`,
      [alertA, u1.userId],
    );
    const platformRule = (
      await admin.query(
        `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver)
         VALUES (NULL,'wp17.test.event','operational','info','tenant_admins') RETURNING id`,
      )
    ).rows[0].id as string;
    ruleA = (
      await call("PATCH /api/v1/alert-rules/:id", adminA, { id: platformRule }, { enabled: false })
    ).json().ruleId as string;
    expect(ruleA).not.toBe(platformRule);
    exercised.clear();
    exercisedByAttacker.clear();
    attackers.clear();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  // ── 1. coverage guard ──────────────────────────────────────────────────────────────────────────────────────
  describe("coverage guard", () => {
    it("every route a M36 registrar mounts has a verdict (and no verdict is stale)", () => {
      expect(registeredRoutes()).toEqual(Object.keys(ROUTES).sort());
    });
    it("every registrar file under routes/ is classified", () => {
      expect(
        readdirSync(ROUTES_DIR)
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .sort(),
      ).toEqual([...REGISTRAR_FILES].sort());
    });
  });

  // ── 2/3. no existence oracle, no leak ──────────────────────────────────────────────────────────────────────
  describe("channel-id routes: org B and an in-org non-member get the answer for a nonexistent id", () => {
    const channelRoutes = [
      "GET /api/v1/messaging/channels/:id",
      "GET /api/v1/messaging/channels/:id/messages",
      "GET /api/v1/messaging/channels/:id/mention-candidates",
      "GET /api/v1/messaging/channels/:id/mention-non-members",
      "GET /api/v1/messaging/channels/:id/presence", // WP 2.12: the guard answers before the (off) tenant flag
    ];
    it("POST presence (WP 2.12): org B and an in-org non-member get a random id's answer and write nothing", async () => {
      const before = await fingerprint();
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA, careTeamA]) {
          await expectNoOracle(
            "POST /api/v1/messaging/channels/:id/presence",
            attacker,
            { id },
            {
              typing: true,
            },
          );
        }
      }
      expect(await fingerprint()).toEqual(before);
    });
    it("legitimate members read (the attacks below are not vacuous)", async () => {
      for (const ch of [dmA, locA]) {
        const res = await call("GET /api/v1/messaging/channels/:id/messages", u2, { id: ch });
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.json())).toContain("messageId");
      }
    });
    for (const route of channelRoutes) {
      it(`${route}`, async () => {
        for (const attacker of [bUser, outsider]) {
          for (const id of [dmA, locA, careTeamA]) await expectNoOracle(route, attacker, { id });
        }
      });
    }
    it("GET search (WP 2.7a) with a real query: members search, everyone else gets a random id's answer", async () => {
      const route = "GET /api/v1/messaging/channels/:id/search";
      const query = "?q=attack";
      const ok = await call(route, u2, { id: dmA }, undefined, {}, query);
      expect(ok.statusCode).toBe(200);
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA, careTeamA]) {
          await expectNoOracle(route, attacker, { id }, undefined, query);
        }
      }
    });
    it("POST send (incl. a reply) into A's channels", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA]) {
          await expectNoOracle(route, attacker, { id }, { body: "attack" });
          await expectNoOracle(
            route,
            attacker,
            { id },
            { body: "attack", parentMessageId: msgDmA },
          );
        }
      }
    });
    it("lists show only the caller's own channels", async () => {
      for (const [who, ownIds, foreign] of [
        [bUser, [dmB], [dmA, locA, careTeamA]],
        [outsider, [], [dmA, locA, careTeamA, dmB]],
        [b2, [dmB], [dmA, locA]],
      ] as Array<[Who, string[], string[]]>) {
        attackers.add(who.name);
        const res = await call("GET /api/v1/messaging/channels", who);
        expect(res.statusCode).toBe(200);
        const ids = (res.json().channels as Array<{ channelId: string }>).map((c) => c.channelId);
        for (const f of foreign) expect(ids).not.toContain(f);
        for (const o of ownIds) expect(ids).toContain(o);
        expectNoLeak(res.body, who, `list ${who.name}`);
      }
    });
  });

  describe("draft routes (WP 2.5): org B and an in-org non-member get the answer for a nonexistent id", () => {
    const draftBody = { body: "WP25-private-draft", deviceId: "dev-1", baseRevision: 0 };
    it("a member saves and reads their own draft, and a fellow member never sees it (attacks are not vacuous)", async () => {
      const saved = await call(
        "PUT /api/v1/messaging/channels/:id/draft",
        u1,
        { id: dmA },
        draftBody,
      );
      expect(saved.statusCode).toBe(200);
      const own = await call("GET /api/v1/messaging/channels/:id/draft", u1, { id: dmA });
      expect(own.json().draft.body).toBe("WP25-private-draft");
      const peer = await call("GET /api/v1/messaging/channels/:id/draft", u2, { id: dmA });
      expect(peer.statusCode).toBe(200);
      expect(peer.json()).toEqual({ draft: null });
      // the peer's delete leaves it alone
      await call("DELETE /api/v1/messaging/channels/:id/draft", u2, { id: dmA });
      const still = await call("GET /api/v1/messaging/channels/:id/draft", u1, { id: dmA });
      expect(still.json().draft.body).toBe("WP25-private-draft");
    });
    it("org B and the in-org non-member are refused exactly like a random channel id", async () => {
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA]) {
          await expectNoOracle("GET /api/v1/messaging/channels/:id/draft", attacker, { id });
          await expectNoOracle(
            "PUT /api/v1/messaging/channels/:id/draft",
            attacker,
            { id },
            draftBody,
          );
        }
      }
    });
    it("DELETE of one's own draft answers 204 for any channel id alike (no oracle) and never touches another user's draft", async () => {
      // Discarding one's OWN draft needs no channel access (a user who lost the channel can still clear it), so the
      // answer is the same 204 for a real channel, a stranger's channel and a random id; the owner filter keeps it safe.
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA, randomUUID()]) {
          const res = await call("DELETE /api/v1/messaging/channels/:id/draft", attacker, { id });
          expect(res.statusCode, `${attacker.name} ${id}`).toBe(204);
        }
      }
      const kept = await call("GET /api/v1/messaging/channels/:id/draft", u1, { id: dmA });
      expect(kept.json().draft.body).toBe("WP25-private-draft");
    });
  });

  describe("scheduled-send routes (WP 2.6): private to their author, no oracle for a foreign id", () => {
    const CREATE = "POST /api/v1/messaging/channels/:id/scheduled-messages";
    const when = () => new Date(Date.now() + 3_600_000).toISOString();
    const scheduleBody = () => ({ body: "WP26-private-scheduled", scheduledFor: when() });
    it("a member schedules and lists their own; a fellow member never sees it or can touch it", async () => {
      const made = await call(CREATE, u1, { id: dmA }, scheduleBody());
      expect(made.statusCode).toBe(201);
      const id = made.json().id as string;
      const own = await call("GET /api/v1/messaging/scheduled-messages", u1);
      expect(own.json().scheduledMessages.map((m: { id: string }) => m.id)).toContain(id);
      const peer = await call("GET /api/v1/messaging/scheduled-messages", u2);
      expect(peer.json()).toEqual({ scheduledMessages: [] });
      // a peer's cancel and reschedule answer as they do for a random id, and leave the row alone
      for (const who of [u2, bUser, outsider]) {
        attackers.add(who.name);
        const real = await call("DELETE /api/v1/messaging/scheduled-messages/:id", who, { id });
        const random = await call("DELETE /api/v1/messaging/scheduled-messages/:id", who, {
          id: randomUUID(),
        });
        expect(shape(real), `${who.name} cancel`).toBe(shape(random));
        const moved = await call(
          "PATCH /api/v1/messaging/scheduled-messages/:id",
          who,
          { id },
          { scheduledFor: when() },
        );
        const movedRandom = await call(
          "PATCH /api/v1/messaging/scheduled-messages/:id",
          who,
          { id: randomUUID() },
          { scheduledFor: when() },
        );
        expect(moved.statusCode, `${who.name} reschedule`).toBe(404);
        expect(shape(moved)).toBe(shape(movedRandom));
        expectNoLeak(moved.body, who, `${who.name} reschedule`);
      }
      const still = await call("GET /api/v1/messaging/scheduled-messages", u1);
      expect(still.json().scheduledMessages.map((m: { id: string }) => m.id)).toContain(id);
      expect(
        (await call("DELETE /api/v1/messaging/scheduled-messages/:id", u1, { id })).json(),
      ).toEqual({ cancelled: true });
    });
    it("org B and the in-org non-member cannot schedule into a channel, exactly like a random channel id", async () => {
      for (const attacker of [bUser, outsider]) {
        for (const id of [dmA, locA]) {
          await expectNoOracle(CREATE, attacker, { id }, scheduleBody());
        }
      }
    });
  });

  describe("attachment routes (WP 1.5): org B and an in-org non-member get the answer for a nonexistent id", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\nattack\n%%EOF");
    const uploadBody = (channelId: string) => ({
      channelId,
      fileName: "attack.pdf",
      contentType: "application/pdf",
      byteSize: bytes.length,
      sha256Hex: sha256Of(bytes),
    });
    it("legitimate use works (the attacks are not vacuous)", async () => {
      expect(
        (await call("GET /api/v1/messaging/attachments/:id/access", u2, { id: attClean }))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("GET /api/v1/messaging/attachments/:id", u1, { id: attClean })).statusCode,
      ).toBe(200);
      expect(
        (await call("POST /api/v1/messaging/attachments/uploads", u1, {}, uploadBody(dmA)))
          .statusCode,
      ).toBe(201);
      expect(
        (
          await call(
            "POST /api/v1/messaging/attachments/:id/complete",
            u1,
            { id: attUnattached },
            {},
          )
        ).statusCode,
      ).toBe(200);
    });
    it("access / status / complete of A's attachments (clean, unattached, pending, quarantined)", async () => {
      for (const route of [
        "GET /api/v1/messaging/attachments/:id/access",
        "GET /api/v1/messaging/attachments/:id",
        "POST /api/v1/messaging/attachments/:id/complete",
      ]) {
        const payload = route.startsWith("POST") ? {} : undefined;
        for (const attacker of [bUser, outsider]) {
          for (const id of [attClean, attUnattached, attPending, attQuarantined]) {
            await expectNoOracle(route, attacker, { id }, payload);
          }
        }
      }
    });
    it("authorizing an upload into A's channels answers as a nonexistent channel", async () => {
      const route = "POST /api/v1/messaging/attachments/uploads";
      for (const attacker of [bUser, outsider]) {
        attackers.add(attacker.name);
        for (const channelId of [dmA, locA, careTeamA]) {
          const real = await call(route, attacker, {}, uploadBody(channelId));
          const ctl = await call(route, attacker, {}, uploadBody(randomUUID()));
          expect(real.statusCode, real.body).toBeGreaterThanOrEqual(400);
          expect(shape(real), `${attacker.name} ${channelId}`).toBe(shape(ctl));
          expectNoLeak(real.body, attacker, `upload ${attacker.name}`);
        }
      }
    });
    it("an A member cannot bind A's attachment from another user, and org B cannot send one into B's own channel", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      // u2 is a member of dmA but did not upload attClean/attUnattached
      attackers.add(u2.name);
      const stolen = await call(
        route,
        u2,
        { id: dmA },
        { body: "x", attachments: [{ attachmentId: attUnattached }] },
      );
      const random = await call(
        route,
        u2,
        { id: dmA },
        { body: "x", attachments: [{ attachmentId: randomUUID() }] },
      );
      expect(stolen.statusCode, stolen.body).toBe(422);
      expect(shape(stolen)).toBe(shape(random));
      attackers.add(bUser.name);
      const cross = await call(
        route,
        bUser,
        { id: dmB },
        { body: "x", attachments: [{ attachmentId: attUnattached }] },
      );
      const ctl = await call(
        route,
        bUser,
        { id: dmB },
        { body: "x", attachments: [{ attachmentId: randomUUID() }] },
      );
      expect(cross.statusCode, cross.body).toBe(422);
      expect(shape(cross)).toBe(shape(ctl));
    });
    it("a quarantined or pending file is not even the uploader's to open", async () => {
      for (const id of [attQuarantined, attPending]) {
        const real = await call("GET /api/v1/messaging/attachments/:id/access", u1, { id });
        const ctl = await call("GET /api/v1/messaging/attachments/:id/access", u1, {
          id: randomUUID(),
        });
        expect(shape(real)).toBe(shape(ctl));
      }
    });
  });

  describe("message-id routes", () => {
    it("edit / delete / mark-read of A's messages", async () => {
      for (const route of [
        "PATCH /api/v1/messaging/messages/:id",
        "DELETE /api/v1/messaging/messages/:id",
        "POST /api/v1/messaging/messages/:id/read",
      ]) {
        const payload = route.startsWith("PATCH")
          ? { body: "tampered" }
          : route.endsWith("read")
            ? {}
            : undefined;
        for (const attacker of [bUser, outsider]) {
          for (const id of [msgDmA, msgLocA])
            await expectNoOracle(route, attacker, { id }, payload);
        }
      }
    });
    it("a member who is not the author cannot edit or delete", async () => {
      attackers.add(u2.name);
      for (const [route, payload] of [
        ["PATCH /api/v1/messaging/messages/:id", { body: "tampered" }],
        ["DELETE /api/v1/messaging/messages/:id", undefined],
      ] as const) {
        const res = await call(route, u2, { id: msgDmA }, payload);
        expect(res.statusCode).toBe(403);
      }
      attackers.delete(u2.name);
    });
  });

  describe("reply / quote references from another tenant or channel", () => {
    it("parentMessageId and quotedMessageId must be a message of the SAME channel, else the answer for a random id", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      const cases: Array<[Who, string, string]> = [
        [bUser, dmB, msgDmA], // another org's message
        [u1, locA, msgDmA], // another channel of the same org
        [outsider, dmA, msgDmA], // a channel the sender cannot see
      ];
      for (const [who, channel, foreign] of cases) {
        attackers.add(who.name);
        for (const field of ["parentMessageId", "quotedMessageId"] as const) {
          const real = await call(route, who, { id: channel }, { body: "x", [field]: foreign });
          const ctl = await call(route, who, { id: channel }, { body: "x", [field]: randomUUID() });
          const label = `${who.name} ${field}`;
          expect(real.statusCode, `${label}: ${real.body}`).toBe(ctl.statusCode);
          expect(real.statusCode, label).toBeGreaterThanOrEqual(400);
          expect(real.statusCode, label).toBeLessThan(500);
          expect(shape(real), label).toBe(shape(ctl));
          if (who === u1) {
            const code =
              field === "parentMessageId"
                ? "PARENT_MESSAGE_NOT_IN_CHANNEL"
                : "QUOTED_MESSAGE_NOT_IN_CHANNEL";
            expect(real.body, label).toContain(code);
          }
        }
      }
    });
    it("positive control: a same-channel parent and quote are accepted", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      const ok = await call(
        route,
        u1,
        { id: dmA },
        { body: "ok", parentMessageId: msgDmA, quotedMessageId: msgDmA },
      );
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  // ── WP 2.2 threads ─────────────────────────────────────────────────────────────────────────────────────────
  describe("threads (WP 2.2): permissions are the channel's, counts and paging are exact", () => {
    const THREAD = "GET /api/v1/messaging/channels/:id/messages/:messageId/thread";
    let thr: string; // a private channel: u1, u2 active; `outsider` removed
    let root: string;
    let replyIds: string[];
    const send = (who: Who, body: string, parentMessageId?: string, channelId = thr) =>
      service.sendMessage(who.org, {
        channelId,
        authorUserId: who.userId,
        body,
        parentMessageId,
      });
    const thread = async (who: Who, query = "", channelId = thr, messageId = root) =>
      call(THREAD, who, { id: channelId, messageId }, undefined, {}, query);
    const channelPage = async (who: Who, channelId = thr) =>
      (await call("GET /api/v1/messaging/channels/:id/messages", who, { id: channelId })).json()
        .messages as Array<{ messageId: string; replyCount?: number; lastReplyAt?: string }>;

    beforeAll(async () => {
      thr = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'location',$2,'WP22 threads','care_related') RETURNING id`,
          [orgA, randomUUID()],
        )
      ).rows[0].id as string;
      for (const w of [u1, u2]) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual')`,
          [orgA, thr, w.userId],
        );
      }
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source, removed_at)
         VALUES ($1,$2,$3,'member','manual',now())`,
        [orgA, thr, outsider.userId],
      );
      root = (await send(u1, `${SECRET_BODY} thread root`)).messageId;
      replyIds = [];
      for (let i = 0; i < 5; i++) {
        replyIds.push((await send(i % 2 ? u1 : u2, `reply ${i}`, root)).messageId);
      }
      // a reply in ANOTHER thread of the same channel and a top-level message: neither counts toward `root`
      const other = (await send(u1, "other root")).messageId;
      await send(u2, "other reply", other);
      // three replies share one created_at to the microsecond, two share the next: the keyset must not skip or repeat
      await admin.query(
        `UPDATE message SET created_at = timestamptz '2026-01-01 00:00:00.123456+00' WHERE id = ANY($1)`,
        [replyIds.slice(0, 3)],
      );
      await admin.query(
        `UPDATE message SET created_at = timestamptz '2026-01-01 00:00:00.123457+00' WHERE id = ANY($1)`,
        [replyIds.slice(3)],
      );
    });

    it("a member reads the root and its replies oldest first, and the channel list carries the same count", async () => {
      const res = await thread(u2);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.root.messageId).toBe(root);
      expect(body.root.body).toContain("thread root");
      expect(body.replies.map((r: { messageId: string }) => r.messageId).sort()).toEqual(
        [...replyIds].sort(),
      );
      expect(
        body.replies.every((r: { parentMessageId: string }) => r.parentMessageId === root),
      ).toBe(true);
      expect(body.root.replyCount).toBe(5);
      expect(body.root.lastReplyAt).toBe("2026-01-01T00:00:00.123Z");
      const list = await channelPage(u2);
      expect(list.find((m) => m.messageId === root)?.replyCount).toBe(5);
      expect(list.find((m) => m.messageId === replyIds[0])?.replyCount).toBe(0);
    });

    it("cursor paging returns every reply once, in (created_at, id) order, across microsecond ties", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await thread(u1, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.statusCode, res.body).toBe(200);
        const page = res.json();
        seen.push(...page.replies.map((r: { messageId: string }) => r.messageId));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(seen.length);
      const expected = (
        await admin.query(
          `SELECT id FROM message WHERE parent_message_id=$1 ORDER BY created_at, id`,
          [root],
        )
      ).rows.map((r) => r.id);
      expect(seen).toEqual(expected);
    });

    it("a deleted reply leaves the count and stays a bodiless tombstone; a hidden-attachment reply still counts", async () => {
      const gone = (await send(u2, "WP22-DELETED-REPLY-BODY", root)).messageId;
      expect((await thread(u1)).json().root.replyCount).toBe(6);
      await service.deleteMessage(orgA, { userId: u2.userId, messageId: gone });
      const after = (await thread(u1)).json();
      expect(after.root.replyCount).toBe(5);
      const tomb = after.replies.find((r: { messageId: string }) => r.messageId === gone);
      expect(tomb?.body).toBe("");
      expect(JSON.stringify(after)).not.toContain("WP22-DELETED-REPLY-BODY");
      // an attachment-only reply whose file u2 cannot open yet: it is a live row for every member, so it counts
      const bound = (await send(u1, "", root).catch(() => null)) ?? null;
      expect(bound).toBeNull(); // a blank body without an attachment is refused (WP 1.5)
      const withFile = (await send(u1, "with a file nobody can open yet", root)).messageId;
      await admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename)
         VALUES ($1,$2,$3,$4,'application/pdf',10,'wp22.pdf')`,
        [orgA, thr, withFile, u1.userId],
      );
      const seen = (await thread(u2)).json();
      expect(seen.root.replyCount).toBe(6);
      expect(
        seen.replies.find((r: { messageId: string }) => r.messageId === withFile)
          ?.hiddenAttachmentCount,
      ).toBe(1);
      await service.deleteMessage(orgA, { userId: u1.userId, messageId: withFile });
      expect((await thread(u2)).json().root.replyCount).toBe(5);
    });

    it("a reply to a reply is refused (422), a quote of a reply is not, and a reply to a root still works", async () => {
      const route = "POST /api/v1/messaging/channels/:id/messages";
      const toReply = await call(
        route,
        u1,
        { id: thr },
        { body: "nested", parentMessageId: replyIds[0] },
      );
      expect(toReply.statusCode, toReply.body).toBe(422);
      expect(toReply.body).toContain("PARENT_MESSAGE_IS_REPLY");
      const quoted = await call(
        route,
        u1,
        { id: thr },
        { body: "quoting", quotedMessageId: replyIds[0] },
      );
      expect(quoted.statusCode, quoted.body).toBe(201);
      const toRoot = await call(
        route,
        u1,
        { id: thr },
        { body: "ok reply", parentMessageId: root },
      );
      expect(toRoot.statusCode, toRoot.body).toBe(201);
      // the refusal wrote nothing: no row has a reply as its parent
      expect(
        await cell(
          `SELECT count(*)::int AS n FROM message c JOIN message p ON p.id = c.parent_message_id WHERE p.parent_message_id IS NOT NULL`,
        ),
      ).toBe(0);
    });

    it("a malformed cursor is a 400 on the thread read and the channel list, never a 500 and never a silent first page", async () => {
      const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
      const bad = [
        b64("not-a-time|not-a-uuid"),
        b64("2026-01-01 00:00:00.123456+00|not-a-uuid"),
        b64(`garbage|${randomUUID()}`),
        b64("no separator at all"),
        "!!!not base64!!!",
      ];
      for (const cursor of bad) {
        const t = await thread(u1, `?cursor=${encodeURIComponent(cursor)}`);
        expect(t.statusCode, `thread ${cursor}: ${t.body}`).toBe(400);
        const l = await call(
          "GET /api/v1/messaging/channels/:id/messages",
          u1,
          { id: thr },
          undefined,
          {},
          `?cursor=${encodeURIComponent(cursor)}`,
        );
        expect(l.statusCode, `list ${cursor}: ${l.body}`).toBe(400);
      }
      // a cursor the server itself issued still works (positive control)
      const first = (await thread(u1, "?limit=2")).json();
      expect(first.nextCursor).toBeTruthy();
      expect((await thread(u1, `?limit=2&cursor=${first.nextCursor}`)).statusCode).toBe(200);
    });

    it("org B, an in-org non-member and a removed member get the answer for a nonexistent id", async () => {
      expect((await thread(u1)).statusCode).toBe(200); // not vacuous
      for (const attacker of [bUser, outsider]) {
        await expectNoOracle(THREAD, attacker, { id: thr, messageId: root });
      }
    });

    it("a member of the channel cannot reach a message of ANOTHER channel through the thread route", async () => {
      // u1 may read locA; msgDmA lives in dmA and root in thr: both are the 404 a random message id gets
      for (const foreign of [msgDmA, root]) {
        const real = await thread(u1, "", locA, foreign);
        const ctl = await thread(u1, "", locA, randomUUID());
        expect(real.statusCode, real.body).toBe(404);
        expect(shape(real)).toBe(shape(ctl));
      }
      attackers.add(u1.name);
    });
  });

  describe("reactions & pins (WP 2.4): the channel's access rule, non-clinical, audited, never an acknowledgement", () => {
    const REACT = "PUT /api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji";
    const UNREACT = "DELETE /api/v1/messaging/channels/:id/messages/:messageId/reactions/:emoji";
    const PIN = "PUT /api/v1/messaging/channels/:id/messages/:messageId/pin";
    const UNPIN = "DELETE /api/v1/messaging/channels/:id/messages/:messageId/pin";
    const PINS = "GET /api/v1/messaging/channels/:id/pins";
    const IDG = "GET /api/v1/messaging/channels/:id/idg-discussions";
    let rp: string; // private: u1, u2 active; `outsider` removed
    let rpArchived: string;
    let m1: string;
    let m2: string;
    let archivedMsg: string;
    const mk = async (channelId: string, body: string) =>
      (await service.sendMessage(orgA, { channelId, authorUserId: u1.userId, body })).messageId;
    const channelOf = async (title: string, archived = false) => {
      const id = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'location',$2,$3,'care_related') RETURNING id`,
          [orgA, randomUUID(), title],
        )
      ).rows[0].id as string;
      for (const w of [u1, u2]) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual')`,
          [orgA, id, w.userId],
        );
      }
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source, removed_at)
         VALUES ($1,$2,$3,'member','manual',now())`,
        [orgA, id, outsider.userId],
      );
      return { id, archived };
    };
    const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await admin.query(sql, params)).rows as T[];
    const listed = async (who: Who, channelId = rp) =>
      (await call("GET /api/v1/messaging/channels/:id/messages", who, { id: channelId })).json()
        .messages as Array<{
        messageId: string;
        pinned?: boolean;
        reactions?: Array<{ emoji: string; count: number; reactedByMe: boolean }>;
      }>;

    beforeAll(async () => {
      rp = (await channelOf("WP24 reactions")).id;
      rpArchived = (await channelOf("WP24 archived")).id;
      m1 = await mk(rp, `${SECRET_BODY} pinned`);
      m2 = await mk(rp, "second");
      archivedMsg = await mk(rpArchived, "before archive");
      await admin.query(`UPDATE channel SET is_archived = true WHERE id = $1`, [rpArchived]);
    });

    it("outsiders and org B get the 404 of a random id on every route (incl. a real message of ANOTHER channel)", async () => {
      for (const attacker of [bUser, outsider]) {
        for (const channelId of [rp, dmA, locA]) {
          const messageId = channelId === rp ? m1 : channelId === dmA ? msgDmA : msgLocA;
          await expectNoOracle(REACT, attacker, { id: channelId, messageId, emoji: "heart" });
          await expectNoOracle(UNREACT, attacker, { id: channelId, messageId, emoji: "heart" });
          await expectNoOracle(PIN, attacker, { id: channelId, messageId });
          await expectNoOracle(UNPIN, attacker, { id: channelId, messageId });
          await expectNoOracle(PINS, attacker, { id: channelId });
          // WP 3.6: the IDG discussion list is refused exactly like the pin list (same guards, same random-id answer).
          await expectNoOracle(IDG, attacker, { id: channelId });
        }
      }
    });

    it("a member cannot reach a message of ANOTHER channel (or another org) through a channel they may use", async () => {
      attackers.add(u1.name);
      for (const foreign of [msgDmA, m1]) {
        const channelId = foreign === m1 ? locA : rp;
        for (const [route, extra] of [
          [REACT, { emoji: "heart" }],
          [PIN, {}],
        ] as const) {
          const real = await call(route, u1, { id: channelId, messageId: foreign, ...extra });
          const ctl = await call(route, u1, { id: channelId, messageId: randomUUID(), ...extra });
          expect(real.statusCode, real.body).toBe(404);
          expect(shape(real)).toBe(shape(ctl));
        }
      }
      expect(
        await rows(`SELECT 1 FROM message_reaction WHERE message_id = ANY($1)`, [[msgDmA]]),
      ).toEqual([]);
    });

    it("reacting is idempotent, counts per emoji, flags the viewer's own, and writes nothing to receipts", async () => {
      const receiptsBefore = await rows(
        `SELECT status, count(*)::int AS n FROM message_receipt GROUP BY 1 ORDER BY 1`,
      );
      for (const [who, emoji] of [
        [u2, "heart"],
        [u2, "heart"],
        [u1, "heart"],
        [u1, "thanks"],
      ] as const) {
        const res = await call(REACT, who, { id: rp, messageId: m1, emoji });
        expect(res.statusCode, res.body).toBe(200);
      }
      const seenByU2 = (await listed(u2)).find((m) => m.messageId === m1);
      expect(seenByU2?.reactions).toEqual([
        { emoji: "heart", count: 2, reactedByMe: true },
        { emoji: "thanks", count: 1, reactedByMe: false },
      ]);
      expect((await listed(u1)).find((m) => m.messageId === m1)?.reactions?.[1]?.reactedByMe).toBe(
        true,
      );
      expect(await rows(`SELECT 1 FROM message_reaction WHERE message_id = $1`, [m1])).toHaveLength(
        3,
      );
      // never an acknowledgement: receipts are exactly what they were
      expect(
        await rows(`SELECT status, count(*)::int AS n FROM message_receipt GROUP BY 1 ORDER BY 1`),
      ).toEqual(receiptsBefore);
      const removed = await call(UNREACT, u1, { id: rp, messageId: m1, emoji: "thanks" });
      expect(removed.json().reactions).toEqual([{ emoji: "heart", count: 2, reactedByMe: true }]);
      expect((await call(UNREACT, u1, { id: rp, messageId: m1, emoji: "thanks" })).statusCode).toBe(
        200,
      );
    });

    it("an unknown reaction key is a 422 and the CHECK refuses one written directly", async () => {
      const res = await call(REACT, u2, { id: rp, messageId: m1, emoji: "thumbs_up" });
      expect(res.statusCode, res.body).toBe(422);
      await expect(
        admin.query(
          `INSERT INTO message_reaction (organization_id, channel_id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4,'thumbs_up')`,
          [orgA, rp, m1, u2.userId],
        ),
      ).rejects.toThrow(/message_reaction_emoji_check/);
    });

    it("the database refuses a reaction or pin whose channel is not the message's channel", async () => {
      for (const table of ["message_reaction", "message_pin"]) {
        const [cols, vals] =
          table === "message_reaction"
            ? ["user_id, emoji", `'${u2.userId}', 'heart'`]
            : ["pinned_by_user_id", `'${u2.userId}'`];
        await expect(
          admin.query(
            `INSERT INTO ${table} (organization_id, channel_id, message_id, ${cols}) VALUES ($1,$2,$3,${vals})`,
            [orgA, locA, m2],
          ),
        ).rejects.toThrow(/_message_channel_fk/);
      }
    });

    it("pin and unpin are idempotent, audited with the ACTOR, hinted, and listed newest first", async () => {
      const hintsBefore = Number(
        (
          await rows<{ n: number }>(
            `SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'm36.message.annotated'`,
          )
        )[0]!.n,
      );
      expect((await call(PIN, u2, { id: rp, messageId: m1 })).statusCode).toBe(200);
      expect((await call(PIN, u1, { id: rp, messageId: m1 })).statusCode).toBe(200); // repeat: no-op
      expect((await call(PIN, u1, { id: rp, messageId: m2 })).statusCode).toBe(200);
      const pins = await call(PINS, u2, { id: rp });
      expect(pins.statusCode, pins.body).toBe(200);
      expect(pins.json().pins.map((p: { messageId: string }) => p.messageId)).toEqual([m2, m1]);
      expect(pins.json().pins[1].body).toContain(SECRET_BODY);
      expect(
        (await listed(u1))
          .filter((m) => m.pinned)
          .map((m) => m.messageId)
          .sort(),
      ).toEqual([m1, m2].sort());
      // one row per message; the first pinner stays
      expect(
        await rows(`SELECT pinned_by_user_id FROM message_pin WHERE message_id = $1`, [m1]),
      ).toEqual([{ pinned_by_user_id: u2.userId }]);
      // outbox: one hint per CHANGE (two pins), ids only
      const hints = await rows<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox_event WHERE event_type = 'm36.message.annotated' ORDER BY created_at`,
      );
      expect(hints.length - hintsBefore).toBe(2);
      expect(JSON.stringify(hints.at(-1)!.payload)).not.toContain(SECRET_BODY);
      expect((await call(UNPIN, u1, { id: rp, messageId: m1 })).statusCode).toBe(204);
      expect((await call(UNPIN, u1, { id: rp, messageId: m1 })).statusCode).toBe(204); // repeat: no-op
      const audit = await rows<{ event_type: string; actor_user_id: string | null }>(
        `SELECT event_type, actor_user_id FROM audit_event WHERE resource_kind = 'message_pin' ORDER BY created_at, id`,
      );
      expect(audit.map((a) => [a.event_type, a.actor_user_id])).toEqual([
        ["message_pin.insert", u2.userId],
        ["message_pin.insert", u1.userId],
        ["message_pin.delete", u1.userId], // the UNPINNER, not the original pinner
      ]);
      expect((await call(UNPIN, u1, { id: rp, messageId: m2 })).statusCode).toBe(204);
    });

    it("caps pins per channel with a 409 and refuses a tombstoned message (404) and an archived channel (410)", async () => {
      await admin.query(`DELETE FROM message_pin WHERE channel_id = $1`, [rp]);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(await mk(rp, `cap ${i}`));
      for (const id of ids)
        expect((await call(PIN, u1, { id: rp, messageId: id })).statusCode).toBe(200);
      const over = await call(PIN, u1, { id: rp, messageId: m2 });
      expect(over.statusCode, over.body).toBe(409);
      expect(over.json().error?.code ?? over.json().code).toBe("PIN_LIMIT_REACHED");
      // a deleted message leaves the pin list and takes no new reaction
      await service.deleteMessage(orgA, { userId: u1.userId, messageId: ids[0]! });
      const after = await call(PINS, u2, { id: rp });
      expect(after.json().pins.map((p: { messageId: string }) => p.messageId)).not.toContain(
        ids[0],
      );
      expect(
        (await call(REACT, u2, { id: rp, messageId: ids[0]!, emoji: "heart" })).statusCode,
      ).toBe(404);
      expect((await call(PIN, u1, { id: rpArchived, messageId: archivedMsg })).statusCode).toBe(
        410,
      );
      expect(
        (await call(REACT, u1, { id: rpArchived, messageId: archivedMsg, emoji: "heart" }))
          .statusCode,
      ).toBe(410);
      expect((await call(UNPIN, u1, { id: rpArchived, messageId: archivedMsg })).statusCode).toBe(
        410,
      );
    });

    it("a member removed from the channel loses reactions and pins at once", async () => {
      for (const [route, params] of [
        [REACT, { id: rp, messageId: m1, emoji: "heart" }],
        [PIN, { id: rp, messageId: m1 }],
        [PINS, { id: rp }],
      ] as const) {
        const res = await call(route, outsider, params);
        expect(res.statusCode, `${route}: ${res.body}`).toBeGreaterThanOrEqual(400);
        expect(res.body).not.toContain(SECRET_BODY);
      }
    });

    it("as the real app role: no UPDATE on either table, and another tenant's session sees none of A's rows", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
        await expect(c.query(`UPDATE message_reaction SET emoji = 'hug'`)).rejects.toThrow(
          /permission denied/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
        for (const t of ["message_reaction", "message_pin"]) {
          expect(
            (
              await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [
                orgA,
              ])
            ).rows[0].n,
          ).toBe(0);
        }
        await expect(
          c.query(
            `INSERT INTO message_pin (organization_id, channel_id, message_id, pinned_by_user_id) VALUES ($1,$2,$3,$4)`,
            [orgA, rp, m2, u1.userId],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    });
  });

  describe("dm, staff directory, care-team channel", () => {
    it("org B cannot open a DM with an org A user, same answer as for a random user", async () => {
      attackers.add(bUser.name);
      const real = await call("POST /api/v1/messaging/dm", bUser, {}, { userId: u1.userId });
      const ctl = await call("POST /api/v1/messaging/dm", bUser, {}, { userId: randomUUID() });
      expect(real.statusCode).toBe(404);
      expect(shape(real)).toBe(shape(ctl));
    });
    it("the staff directory never lists the other org", async () => {
      for (const [who, foreignToken] of [
        [bUser, A_NAME_TOKEN],
        [u1, "WP17-ORG-B-PERSON"],
      ] as Array<[Who, string]>) {
        attackers.add(who.name);
        const res = await call("GET /api/v1/messaging/dm/staff", who, {}, undefined, {}, "?q=WP17");
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(foreignToken);
      }
    });
    it("a care-team channel for an org A patient is not reachable from org B, nor by an unassigned in-org user", async () => {
      const route = "POST /api/v1/messaging/patients/:patientId/care-team-channel";
      await expectNoOracle(route, bUser, { patientId: patientA });
      await expectNoOracle(route, outsider, { patientId: patientA });
    });
    it("WP 3.2: org B and an in-org non-member get the identical `unavailable` for A's link as for a random id, and A's source seam is never consulted", async () => {
      const route = "GET /api/v1/messaging/clinical-links/:linkId/resolve";
      const member = await call(route, u2, { linkId: linkA });
      expect(member.json()).toMatchObject({
        state: "ok",
        kind: "order",
        link: `/orders/${LINK_SOURCE}`,
      });
      for (const attacker of [bUser, outsider, adminB]) {
        attackers.add(attacker.name);
        const consulted = linkSourceCalls;
        const real = await call(route, attacker, { linkId: linkA });
        const ctl = await call(route, attacker, { linkId: randomUUID() });
        expect(real.statusCode).toBe(200);
        expect(shape(real)).toBe(shape(ctl));
        expect(real.json()).toEqual({ state: "unavailable" });
        expect(linkSourceCalls, `${attacker.name} reached the source seam`).toBe(consulted);
        expectNoLeak(real.body, attacker, `${attacker.name} ${route}`);
        expect(real.body).not.toContain(LINK_SOURCE);
        expect(real.body).not.toContain(patientA);
      }
    });
    it("WP 3.3: SBAR policy reads and writes touch only the caller's own org", async () => {
      const policy = "/api/v1/messaging/sbar/policy";
      const admin_ = "/api/v1/messaging/template-admin/sbar-policy";
      const get = (who: Who) => call(`GET ${policy}`, who, {});
      const put = (who: Who, minChars: number) =>
        call(`PUT ${admin_}`, who, {}, { minChars: { situation: minChars } });
      expect((await put(adminA, 77)).statusCode).toBe(200);
      const bBefore = await get(bUser);
      expect(bBefore.json()).toMatchObject({ customized: false });
      expect(bBefore.json().minChars.situation).toBe(1);
      expect((await get(u2)).json().minChars.situation).toBe(77);
      // org B's admin writes and clears its own row; org A's row is untouched.
      expect((await put(adminB, 9)).statusCode).toBe(200);
      expect((await get(u2)).json().minChars.situation).toBe(77);
      expect((await get(bUser)).json().minChars.situation).toBe(9);
      expect((await call(`DELETE ${admin_}`, adminB, {})).statusCode).toBe(204);
      expect((await get(u2)).json().minChars.situation).toBe(77);
      // non-admins of either org cannot write.
      expect((await put(u2, 5)).statusCode).toBe(403);
      expect((await put(bUser, 5)).statusCode).toBe(403);
      expect((await get(u2)).json().minChars.situation).toBe(77);
      expect((await call(`DELETE ${admin_}`, adminA, {})).statusCode).toBe(204);
    });
    it("WP 3.10: org B and an in-org non-member get a random channel's answer for A's care-team medication question and options, and nothing is written", async () => {
      const askRoute = "POST /api/v1/messaging/channels/:id/medication-questions";
      const optionsRoute = "GET /api/v1/messaging/channels/:id/medication-questions/options";
      const body = { text: "Which dose is due?", client_message_id: randomUUID() };
      const messages = () =>
        admin.query("SELECT count(*)::int AS n FROM message WHERE channel_id=$1", [careTeamA]);
      const before = (await messages()).rows[0].n;
      for (const attacker of [bUser, adminB, outsider]) {
        await expectNoOracle(askRoute, attacker, { id: careTeamA }, body);
        await expectNoOracle(optionsRoute, attacker, { id: careTeamA });
      }
      expect((await messages()).rows[0].n).toBe(before);
      // the member, with nobody to route to, can send it unrouted: the attacks above were refused for tenancy, not for shape.
      const sent = await call(askRoute, u1, { id: careTeamA }, { ...body, allow_unrouted: true });
      expect(sent.statusCode, sent.body).toBe(201);
      expect((await messages()).rows[0].n).toBe(before + 1);
    });
    it("WP 4.10: snooze and reminder routes touch only the caller's own row; org B and an in-org non-member get a random id's answer and write nothing", async () => {
      const SNOOZE = "/api/v1/messaging/channels/:id/snooze";
      const REMINDER = "/api/v1/messaging/messages/:id/reminder";
      const remindAt = () => new Date(Date.now() + 3_600_000).toISOString();
      const rows = () =>
        admin.query(
          "SELECT (SELECT count(*)::int FROM message_snooze) AS s, (SELECT count(*)::int FROM message_reminder) AS r",
        );
      const before = (await rows()).rows[0];
      for (const attacker of [bUser, adminB, outsider]) {
        for (const id of [dmA, locA, careTeamA]) {
          await expectNoOracle(`GET ${SNOOZE}`, attacker, { id });
          await expectNoOracle(`PUT ${SNOOZE}`, attacker, { id }, { duration_minutes: 60 });
        }
        await expectNoOracle(
          `PUT ${REMINDER}`,
          attacker,
          { id: msgLocA },
          { remind_at: remindAt() },
        );
        // Withdrawing is a no-op for a stranger: the same answer for a real and a random id, and nothing leaks.
        for (const [route, real] of [
          [`DELETE ${SNOOZE}`, locA],
          [`DELETE ${REMINDER}`, msgLocA],
        ] as const) {
          const got = await call(route, attacker, { id: real });
          const ctl = await call(route, attacker, { id: randomUUID() });
          expect(got.statusCode, `${attacker.name} ${route}`).toBe(ctl.statusCode);
          expect(shape(got), `${attacker.name} ${route}`).toBe(shape(ctl));
          expectNoLeak(got.body, attacker, `${attacker.name} ${route}`);
        }
      }
      expect((await rows()).rows[0]).toEqual(before);
      // The member's own rows work, and an attacker's list never shows them.
      expect(
        (await call(`PUT ${SNOOZE}`, u1, { id: locA }, { duration_minutes: 60 })).statusCode,
      ).toBe(200);
      expect(
        (await call(`PUT ${REMINDER}`, u1, { id: msgLocA }, { remind_at: remindAt() })).statusCode,
      ).toBe(200);
      const mine = await call("GET /api/v1/messaging/reminders", u1);
      expect(mine.json().reminders).toHaveLength(1);
      for (const attacker of [u2, bUser, outsider]) {
        const theirs = await call("GET /api/v1/messaging/reminders", attacker);
        expect(theirs.json().reminders, attacker.name).toEqual([]);
        expectNoLeak(theirs.body, attacker, `${attacker.name} reminders`);
      }
      // A fellow member cannot end or cancel it.
      expect((await call(`DELETE ${SNOOZE}`, u2, { id: locA })).json()).toEqual({ cleared: false });
      expect((await call(`DELETE ${REMINDER}`, u2, { id: msgLocA })).json()).toEqual({
        cleared: false,
      });
      expect((await call(`DELETE ${SNOOZE}`, u1, { id: locA })).json()).toEqual({ cleared: true });
      expect((await call(`DELETE ${REMINDER}`, u1, { id: msgLocA })).json()).toEqual({
        cleared: true,
      });
    });
    it("WP 4.1: org B and an in-org non-member get a random channel's answer for A's care-team urgent message and options, and nothing is written", async () => {
      const sendRoute = "POST /api/v1/messaging/channels/:id/urgent-messages";
      const optionsRoute = "GET /api/v1/messaging/channels/:id/urgent-messages/options";
      const para = (value: string) => ({
        type: "paragraph",
        content: [{ type: "text", text: value }],
      });
      const body = {
        client_message_id: randomUUID(),
        recipient_user_id: u2.userId,
        body_doc: {
          schemaVersion: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "sbar",
                urgencyHint: "routine",
                situation: [para("Pain is uncontrolled")],
                background: [para("Day three on service")],
                assessment: [para("Not responding")],
                recommendation: [para("Please review")],
              },
            ],
          },
        },
      };
      const urgent = () =>
        admin.query(
          "SELECT count(*)::int AS n FROM message WHERE urgency='urgent' AND channel_id=$1",
          [careTeamA],
        );
      const before = (await urgent()).rows[0].n;
      for (const attacker of [bUser, adminB, outsider]) {
        await expectNoOracle(sendRoute, attacker, { id: careTeamA }, body);
        await expectNoOracle(optionsRoute, attacker, { id: careTeamA });
      }
      expect((await urgent()).rows[0].n).toBe(before);
    });
    it("WP 4.2: org B and an in-org non-member get a random id's answer for A's acknowledgment request, and change nothing", async () => {
      const BASE = "/api/v1/messaging/escalations";
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual') ON CONFLICT DO NOTHING`,
        [orgA, careTeamA, u2.userId],
      );
      const sent = await service.sendMessage(orgA, {
        channelId: careTeamA,
        authorUserId: u1.userId,
        body: "please look at this",
      });
      const made = await call(
        `POST ${BASE}`,
        u1,
        {},
        { message_id: sent.messageId, assigned_user_id: u2.userId },
      );
      expect(made.statusCode, made.body).toBe(201);
      const id = made.json().request.id as string;
      const state = () =>
        admin.query(
          "SELECT status, assigned_user_id, version, (SELECT count(*)::int FROM message_acknowledgment_event) AS events FROM message_acknowledgment_request WHERE id=$1",
          [id],
        );
      const before = (await state()).rows[0];

      for (const attacker of [bUser, adminB, outsider]) {
        // the body id: A's real message and a random one must answer identically
        const real = await call(
          `POST ${BASE}`,
          attacker,
          {},
          { message_id: sent.messageId, assigned_user_id: attacker.userId },
        );
        const control = await call(
          `POST ${BASE}`,
          attacker,
          {},
          { message_id: randomUUID(), assigned_user_id: attacker.userId },
        );
        attackers.add(attacker.name);
        expect(real.statusCode, `${attacker.name}: ${real.body}`).toBeGreaterThanOrEqual(400);
        expect(real.statusCode).toBeLessThan(500);
        expect(shape(real), `${attacker.name} create differs from a random message id`).toBe(
          shape(control),
        );
        expectNoLeak(real.body, attacker, `${attacker.name} create`);
        await expectNoOracle("GET /api/v1/messaging/escalations/:id", attacker, { id });
        await expectNoOracle("POST /api/v1/messaging/escalations/:id/acknowledge", attacker, {
          id,
        });
        await expectNoOracle("POST /api/v1/messaging/escalations/:id/resolve", attacker, { id });
        await expectNoOracle(
          "POST /api/v1/messaging/escalations/:id/reassign",
          attacker,
          { id },
          { assigned_user_id: attacker.userId },
        );
        await expectNoOracle("GET /api/v1/messaging/channels/:id/escalations", attacker, {
          id: careTeamA,
        });
        await expectNoOracle(
          "GET /api/v1/messaging/escalations/:id/reassign-candidates",
          attacker,
          {
            id,
          },
        );
      }
      // ADR-0078: the org-B holder of messaging.review reaches the service and is stopped by tenancy alone.
      await expectNoOracle(
        "GET /api/v1/messaging/escalations/:id/supervisor-reassign-candidates",
        reviewerB,
        { id },
      );
      await expectNoOracle(
        "POST /api/v1/messaging/escalations/:id/supervisor-reassign",
        reviewerB,
        { id },
        { assigned_user_id: reviewerB.userId, reason_code: "workload" },
      );
      expect((await state()).rows[0]).toEqual(before);
      // the assignee, by contrast, really can act: the refusals above were tenancy, not shape.
      const ack = await call("POST /api/v1/messaging/escalations/:id/acknowledge", u2, { id });
      expect(ack.statusCode, ack.body).toBe(200);
    });
    it("WP 4.12 / ADR-0081: org B and an in-org non-member get a random id's answer for A's patient and care-team channel on the on-call directory and role-based send, and nothing is written", async () => {
      const COVERAGE = "GET /api/v1/messaging/oncall/coverage";
      const RESOLVE = "GET /api/v1/messaging/channels/:id/role-send/resolution";
      const SEND = "POST /api/v1/messaging/channels/:id/role-send";
      const para = (value: string) => ({
        type: "paragraph",
        content: [{ type: "text", text: value }],
      });
      const roleBody = (patientId: string) => ({
        role: "rn",
        patient_id: patientId,
        recipient_user_id: u2.userId,
        client_message_id: randomUUID(),
        body_doc: {
          schemaVersion: 1,
          doc: {
            type: "doc",
            content: [
              {
                type: "sbar",
                urgencyHint: "routine",
                situation: [para("Uncontrolled pain nine of ten")],
                background: [para("Day three on service, on morphine")],
                assessment: [para("Pain is not controlled by the current plan")],
                recommendation: [para("Please review the plan within the hour")],
              },
            ],
          },
        },
      });
      const qs = (patientId: string) => `?role=rn&patient_id=${patientId}`;
      const written = () =>
        admin.query(
          `SELECT (SELECT count(*)::int FROM message) AS m,
                  (SELECT count(*)::int FROM message_acknowledgment_request) AS a,
                  (SELECT count(*)::int FROM outbox_event) AS o,
                  (SELECT count(*)::int FROM audit_event) AS e`,
        );

      // Org B's own channel (the channel gates pass there), made before the baseline.
      const ownB = (await service.openDm(orgB, reviewerB.userId, b2.userId)).channelId;
      // Positive controls (the attacks below are not vacuous): a care-team member holding the chart scope reads both.
      const cov = await call(COVERAGE, u1, {}, undefined, {}, qs(patientA));
      expect(cov.statusCode, cov.body).toBe(200);
      const res = await call(RESOLVE, u1, { id: careTeamA }, undefined, {}, qs(patientA));
      expect(res.statusCode, res.body).toBe(200);

      const before = (await written()).rows[0];
      // 1. The directory names a patient and nothing else: org B (chart-read permission AND scope stub pass) gets a missing patient's 404.
      for (const attacker of [reviewerB, promoterB]) {
        attackers.add(attacker.name);
        const real = await call(COVERAGE, attacker, {}, undefined, {}, qs(patientA));
        const ctl = await call(COVERAGE, attacker, {}, undefined, {}, qs(randomUUID()));
        expect(real.statusCode, `${attacker.name} coverage: ${real.body}`).toBe(404);
        expect(shape(real), `${attacker.name} coverage differs from a missing patient`).toBe(
          shape(ctl),
        );
        expectNoLeak(real.body, attacker, `${attacker.name} coverage`);
      }
      // 2. Org B's OWN channel (so the channel gates pass) naming A's patient: the org-scoped existence check alone stops it.
      const ownReal = await call(RESOLVE, reviewerB, { id: ownB }, undefined, {}, qs(patientA));
      const ownCtl = await call(RESOLVE, reviewerB, { id: ownB }, undefined, {}, qs(randomUUID()));
      expect(ownReal.statusCode, `own-channel resolve: ${ownReal.body}`).toBe(404);
      expect(shape(ownReal)).toBe(shape(ownCtl));
      const sentReal = await call(SEND, reviewerB, { id: ownB }, roleBody(patientA));
      const sentCtl = await call(SEND, reviewerB, { id: ownB }, roleBody(randomUUID()));
      expect(sentReal.statusCode, `own-channel send: ${sentReal.body}`).toBe(404);
      expect(shape(sentReal)).toBe(shape(sentCtl));
      // 3. A's care-team channel: org B and the in-org non-member get a random channel's answer.
      for (const attacker of [bUser, adminB, outsider]) {
        await expectNoOracle(RESOLVE, attacker, { id: careTeamA }, undefined, qs(patientA));
        await expectNoOracle(SEND, attacker, { id: careTeamA }, roleBody(patientA));
      }
      expect((await written()).rows[0]).toEqual(before);
    });
    it("WP 4.8: org B and an in-org non-member get a random id's answer for A's notification link", async () => {
      const route = "GET /api/v1/messaging/deliveries/:id/target";
      const sent = await service.sendMessage(orgA, {
        channelId: careTeamA,
        authorUserId: u1.userId,
        body: "please look at this",
      });
      const alert = (
        await admin.query(
          `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id, outcome)
           VALUES ($1,'m36.ack.requested','warn',$2,$3,'pending') RETURNING id`,
          [
            orgA,
            JSON.stringify({ channelId: careTeamA, messageId: sent.messageId }),
            `wp48-${randomUUID()}`,
          ],
        )
      ).rows[0].id as string;
      const id = (
        await admin.query(
          `INSERT INTO notification_delivery (alert_id, recipient_user_id, alert_category, alert_severity, channel, status)
           VALUES ($1,$2,'clinical_urgent','warn','push','pending') RETURNING id`,
          [alert, u2.userId],
        )
      ).rows[0].id as string;
      for (const attacker of [bUser, adminB, outsider, u1]) {
        await expectNoOracle(route, attacker, { id });
      }
      // the recipient, by contrast, really can resolve it: the refusals above were ownership, not shape.
      const ok = await call(route, u2, { id });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({
        channel_id: careTeamA,
        message_id: sent.messageId,
        ack_request_id: null,
      });
    });
    it("WP 4.9: the supervisor queue lists A's waiting request to A's reviewer only; org B's reviewer and every non-reviewer get none of it", async () => {
      const route = "GET /api/v1/messaging/escalations/unacknowledged";
      const sent = await service.sendMessage(orgA, {
        channelId: careTeamA,
        authorUserId: u1.userId,
        body: `${SECRET_BODY} queue`,
      });
      const requestId = (
        await admin.query(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes') RETURNING id`,
          [orgA, sent.messageId, careTeamA, patientA, u1.userId, u2.userId],
        )
      ).rows[0].id as string;
      // the legitimate reviewer lists it (the attacks are not vacuous): a row is there, restricted or not.
      const own = await call(route, u1);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().counts.unfiltered).toBeGreaterThanOrEqual(1);
      expect(own.body).not.toContain(SECRET_BODY);
      // org B's reviewer holds the permission and sees only org B's (empty) queue; the rest lack it.
      for (const attacker of [reviewerB, bUser, adminB, outsider]) {
        const res = await call(route, attacker);
        expect(res.statusCode, `${attacker.name}: ${res.body}`).toBe(
          attacker === reviewerB ? 200 : 403,
        );
        if (attacker === reviewerB) {
          expect(res.json().items).toEqual([]);
          expect(res.json().counts.unfiltered).toBe(0);
        }
        expectNoLeak(res.body, attacker, `${attacker.name} unacknowledged queue`);
        expect(res.body).not.toContain(requestId);
      }
    });
    it("WP 6.1: the smart inbox lists only the caller's own assigned work; org B, the requester and non-members get none of A's ids", async () => {
      const route = "GET /api/v1/messaging/inbox";
      const sent = await service.sendMessage(orgA, {
        channelId: careTeamA,
        authorUserId: u1.userId,
        body: `${SECRET_BODY} inbox`,
      });
      const requestId = (
        await admin.query(
          `INSERT INTO message_acknowledgment_request
             (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, requested_at, window_started_at, deadline_at)
           VALUES ($1,$2,$3,$4,'important',$5,$6,now(),now(), now() + interval '60 minutes') RETURNING id`,
          [orgA, sent.messageId, careTeamA, patientA, u1.userId, u2.userId],
        )
      ).rows[0].id as string;
      // the assignee sees it (the attacks are not vacuous); no message text.
      const own = await call(route, u2);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().items.map((i: { key: string }) => i.key)).toContain(`ack:${requestId}`);
      expect(own.body).not.toContain(SECRET_BODY);
      // the requester is not the assignee: it is not their work.
      const requester = await call(route, u1);
      expect(requester.statusCode, requester.body).toBe(200);
      expect(requester.body).not.toContain(requestId);
      for (const attacker of [bUser, adminB, reviewerB, outsider]) {
        const res = await call(route, attacker);
        expect(res.statusCode, `${attacker.name}: ${res.body}`).toBeLessThan(500);
        expectNoLeak(res.body, attacker, `${attacker.name} smart inbox`);
        expect(res.body).not.toContain(requestId);
      }
    });
    it("WP 3.4: org B and an in-org non-member get a random id's answer for A's task and A's message, and list none of it", async () => {
      const convertRoute = "POST /api/v1/messaging/channels/:id/messages/:messageId/tasks";
      const made = await call(
        convertRoute,
        u1,
        { id: dmA, messageId: msgDmA },
        {
          assignee_user_id: u2.userId,
        },
      );
      expect(made.statusCode).toBe(201);
      const taskId = made.json().task.id as string;
      expect((await call("GET /api/v1/messaging/tasks/:taskId", u2, { taskId })).statusCode).toBe(
        200,
      );
      for (const attacker of [bUser, adminB, outsider]) {
        await expectNoOracle(
          convertRoute,
          attacker,
          { id: dmA, messageId: msgDmA },
          { assignee_user_id: attacker.userId },
        );
        await expectNoOracle("GET /api/v1/messaging/tasks/:taskId", attacker, { taskId });
        await expectNoOracle("POST /api/v1/messaging/tasks/:taskId/accept", attacker, { taskId });
        await expectNoOracle(
          "POST /api/v1/messaging/tasks/:taskId/complete",
          attacker,
          { taskId },
          { reason: "action_taken" },
        );
        await expectNoOracle(
          "POST /api/v1/messaging/tasks/:taskId/cancel",
          attacker,
          { taskId },
          { reason: "duplicate" },
        );
        await expectNoOracle(
          "POST /api/v1/messaging/tasks/:taskId/reassign",
          attacker,
          { taskId },
          { assignee_user_id: attacker.userId },
        );
        const list = await call(
          "GET /api/v1/messaging/tasks",
          attacker,
          {},
          undefined,
          {},
          "?state=all&scope=created",
        );
        expect(list.statusCode).toBe(200);
        expect(list.json().tasks).toEqual([]);
        expectNoLeak(list.body, attacker, `${attacker.name} list tasks`);
      }
      // the attacks changed nothing: the task is still the assignee's, open.
      const row = (
        await admin.query("SELECT status, assignee_id FROM communication_task WHERE id=$1", [
          taskId,
        ])
      ).rows[0];
      expect(row).toEqual({ status: "open", assignee_id: u2.userId });
    });
    it("WP 3.5: org B and an in-org non-participant get a random id's answer for A's handoff, and list none of it", async () => {
      const H = "/api/v1/messaging/handoffs";
      const made = await call(
        `POST ${H}`,
        u1,
        {},
        {
          to_user_id: u2.userId,
          items: [{ kind: "patient", ref_id: patientA, patient_id: patientA }],
        },
      );
      expect(made.statusCode).toBe(201);
      const handoffId = made.json().handoff.id as string;
      const itemId = (
        await admin.query("SELECT id FROM clinical_handoff_item WHERE handoff_id=$1", [handoffId])
      ).rows[0].id as string;
      expect((await call(`GET ${H}/:handoffId`, u2, { handoffId })).statusCode).toBe(200);
      expect((await call(`GET ${H}/:handoffId`, u1, { handoffId })).statusCode).toBe(200);
      for (const attacker of [bUser, adminB, outsider]) {
        await expectNoOracle(`GET ${H}/:handoffId`, attacker, { handoffId });
        await expectNoOracle(
          `POST ${H}/:handoffId/accept`,
          attacker,
          { handoffId },
          { item_ids: [itemId] },
        );
        await expectNoOracle(`POST ${H}/:handoffId/decline`, attacker, { handoffId }, {});
        await expectNoOracle(`POST ${H}/:handoffId/cancel`, attacker, { handoffId });
        for (const scope of ["incoming", "outgoing"]) {
          const list = await call(
            `GET ${H}`,
            attacker,
            {},
            undefined,
            {},
            `?scope=${scope}&state=all`,
          );
          expect(list.statusCode).toBe(200);
          expect(list.json().handoffs).toEqual([]);
          expectNoLeak(list.body, attacker, `${attacker.name} list handoffs`);
        }
        // the caseload and prefill answers are the caller's own: an attacker with no caseload gets nothing of A's patient.
        for (const route of [`GET ${H}/caseload`, `POST ${H}/prefill`]) {
          const res = await call(
            route,
            attacker,
            {},
            route.startsWith("POST") ? { patient_ids: [patientA] } : undefined,
          );
          expect(res.statusCode).toBeGreaterThanOrEqual(200);
          expect(res.body).not.toContain(patientA);
        }
      }
      // the attacks changed nothing: still offered, items still the sender's.
      const row = (
        await admin.query(
          `SELECT h.state, i.state AS item_state, i.accountable_user_id
             FROM clinical_handoff h JOIN clinical_handoff_item i ON i.handoff_id = h.id WHERE h.id=$1`,
          [handoffId],
        )
      ).rows[0];
      expect(row).toEqual({
        state: "offered",
        item_state: "pending",
        accountable_user_id: u1.userId,
      });
    });
    it("WP 3.8: org B and an in-org non-reviewer get a random id's answer for A's review item, and list none of it", async () => {
      const R = "/api/v1/messaging/review-items";
      const convertRoute = "POST /api/v1/messaging/channels/:id/messages/:messageId/tasks";
      for (const w of [u1, u2]) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual') ON CONFLICT DO NOTHING`,
          [orgA, careTeamA, w.userId],
        );
      }
      const messageId = (
        await service.sendMessage(orgA, {
          channelId: careTeamA,
          authorUserId: u1.userId,
          body: `${SECRET_BODY} follow up`,
        })
      ).messageId;
      const made = await call(
        convertRoute,
        u1,
        { id: careTeamA, messageId },
        { assignee_user_id: u2.userId },
      );
      expect(made.statusCode, made.body).toBe(201);
      const taskId = made.json().task.id as string;
      const reviewItemId = (
        await admin.query(
          `INSERT INTO messaging_review_item
             (organization_id, source, cause, trigger_ref, patient_id, subject_user_id, item_kind, item_id)
           VALUES ($1,'patient_lifecycle','death',$2,$2,$3,'task',$4) RETURNING id`,
          [orgA, patientA, u2.userId, taskId],
        )
      ).rows[0].id as string;
      // the legitimate reviewer lists it (the attacks are not vacuous).
      const own = await call(`GET ${R}`, u1, {}, undefined, {}, "?state=all");
      expect(own.statusCode).toBe(200);
      expect(own.json().items.map((i: { id: string }) => i.id)).toContain(reviewItemId);
      for (const attacker of [reviewerB, bUser, adminB, outsider]) {
        await expectNoOracle(
          `POST ${R}/:reviewItemId/reassign`,
          attacker,
          { reviewItemId },
          { to_user_id: attacker.userId },
        );
        await expectNoOracle(
          `POST ${R}/:reviewItemId/close`,
          attacker,
          { reviewItemId },
          { reason: "duplicate" },
        );
        const list = await call(`GET ${R}`, attacker, {}, undefined, {}, "?state=all");
        // reviewerB holds the permission and sees an empty org-B queue; the others lack it (403).
        expect(list.statusCode).toBe(attacker === reviewerB ? 200 : 403);
        if (attacker === reviewerB) expect(list.json().items).toEqual([]);
        expectNoLeak(list.body, attacker, `${attacker.name} list review items`);
      }
      // the attacks changed nothing: still open, the task still the assignee's.
      const row = (
        await admin.query(
          `SELECT r.state, t.status, t.assignee_id FROM messaging_review_item r
             JOIN communication_task t ON t.id = r.item_id WHERE r.id=$1`,
          [reviewItemId],
        )
      ).rows[0];
      expect(row).toEqual({ state: "open", status: "open", assignee_id: u2.userId });
    });
    it("WP 3.7: org B and an in-org non-member get a random id's answer for A's promotion and A's message, and list none of it", async () => {
      const P = "/api/v1/messaging/chart-promotions";
      const proposeRoute =
        "POST /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions";
      const channel = careTeamA;
      for (const w of [u1, u2]) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
           VALUES ($1,$2,$3,'member','manual') ON CONFLICT DO NOTHING`,
          [orgA, channel, w.userId],
        );
      }
      const messageId = (
        await service.sendMessage(orgA, {
          channelId: channel,
          authorUserId: u1.userId,
          body: `${SECRET_BODY} promoted`,
        })
      ).messageId;
      const target = { target_module: "m8", target_kind: "encounter_addendum" };
      const made = await call(proposeRoute, u1, { id: channel, messageId }, target);
      expect(made.statusCode, made.body).toBe(201);
      const promotionId = made.json().promotion.id as string;
      expect((await call(`GET ${P}/:promotionId`, u2, { promotionId })).statusCode).toBe(200);
      for (const attacker of [promoterB, promoterA, bUser, adminB, outsider]) {
        await expectNoOracle(proposeRoute, attacker, { id: channel, messageId }, target);
        await expectNoOracle(
          "GET /api/v1/messaging/channels/:id/messages/:messageId/chart-promotions",
          attacker,
          { id: channel, messageId },
        );
        await expectNoOracle(`GET ${P}/:promotionId`, attacker, { promotionId });
        await expectNoOracle(`POST ${P}/:promotionId/withdraw`, attacker, { promotionId });
        const list = await call(`GET ${P}`, attacker, {}, undefined, {}, "?status=all");
        expect(list.statusCode).toBe(200);
        expect(list.json().promotions).toEqual([]);
        expectNoLeak(list.body, attacker, `${attacker.name} list promotions`);
      }
      // the attacks changed nothing: still one proposed request by the original requester, no text stored.
      const rows = (
        await admin.query(
          "SELECT status, requested_by_user_id, row_to_json(c)::text AS dump FROM chart_promotion_request c WHERE message_id=$1",
          [messageId],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "proposed", requested_by_user_id: u1.userId });
      expect(rows[0].dump).not.toContain(SECRET_BODY);
    });
    it("WP 3.5: the handoff policy and the policy-read route touch only the caller's own org", async () => {
      const policy = "/api/v1/messaging/handoffs/policy";
      const admin_ = "/api/v1/messaging/template-admin/handoff-policy";
      const get = (who: Who) => call(`GET ${policy}`, who, {});
      const put = (who: Who, minutes: number) =>
        call(`PUT ${admin_}`, who, {}, { expiry_minutes: minutes });
      expect((await put(adminA, 60)).statusCode).toBe(200);
      expect((await get(u2)).json().expiry_minutes).toBe(60);
      expect((await get(bUser)).json().expiry_minutes).toBe(240);
      expect((await put(adminB, 30)).statusCode).toBe(200);
      expect((await get(u2)).json().expiry_minutes).toBe(60);
      expect((await get(bUser)).json().expiry_minutes).toBe(30);
      expect((await put(u2, 20)).statusCode).toBe(403);
      expect((await put(bUser, 20)).statusCode).toBe(403);
      expect((await call(`DELETE ${admin_}`, adminB, {})).statusCode).toBe(200);
      expect((await get(u2)).json().expiry_minutes).toBe(60);
      expect((await call(`DELETE ${admin_}`, adminA, {})).statusCode).toBe(200);
      expect((await get(u2)).json().expiry_minutes).toBe(240);
      // prefill is a pure read of the caller's own caseload
      const prefill = await call(
        "POST /api/v1/messaging/handoffs/prefill",
        u1,
        {},
        { patient_ids: [patientA] },
      );
      expect(prefill.statusCode).toBe(200);
      expect((await call("GET /api/v1/messaging/handoffs/caseload", u1, {})).statusCode).toBe(200);
    });
    it("the WP 3.1 context panel gives org B and an in-org outsider the same empty projection for A's patient as for a random id", async () => {
      const route = "GET /api/v1/messaging/patients/:patientId/context";
      for (const attacker of [bUser, outsider]) {
        attackers.add(attacker.name);
        const real = await call(route, attacker, { patientId: patientA });
        const ctl = await call(route, attacker, { patientId: randomUUID() });
        expect(real.statusCode).toBe(ctl.statusCode);
        expect(real.json().tiles).toEqual(ctl.json().tiles);
        expect(real.json().tiles).toEqual({});
        expectNoLeak(real.body, attacker, `${attacker.name} ${route}`);
      }
    });
  });

  describe("member administration", () => {
    const addRoute = "POST /api/v1/messaging/channels/:id/members";
    const delRoute = "DELETE /api/v1/messaging/channels/:id/members/:userId";
    it("org B admin / A non-admin cannot add or remove members of A's channels", async () => {
      for (const attacker of [adminB, outsider]) {
        for (const id of [locA, dmA]) {
          await expectNoOracle(addRoute, attacker, { id }, { userId: attacker.userId });
          await expectNoOracle(delRoute, attacker, { id, userId: u1.userId });
        }
      }
    });
    it("an A admin cannot manage B's channel, nor pull a B user into A", async () => {
      await expectNoOracle(addRoute, adminA, { id: dmB }, { userId: u1.userId });
      await expectNoOracle(delRoute, adminA, { id: dmB, userId: bUser.userId });
      attackers.add(adminA.name);
      const real = await call(addRoute, adminA, { id: locA }, { userId: bUser.userId });
      const ctl = await call(addRoute, adminA, { id: locA }, { userId: randomUUID() });
      expect(real.statusCode).toBeGreaterThanOrEqual(400);
      expect(shape(real)).toBe(shape(ctl));
      attackers.delete(adminA.name);
    });
  });

  describe("announcement receipts and department channels (WP 2.9)", () => {
    const receiptsRoute = "GET /api/v1/messaging/announcements/:messageId/receipts";
    const departmentRoute = "POST /api/v1/messaging/department-channels";
    it("org B admin and an in-org non-admin get a random id's answer for A's announcement receipts", async () => {
      const posted = await call("POST /api/v1/messaging/announce", adminA, {}, { body: "wp29" });
      expect(posted.statusCode).toBe(201);
      const messageId = posted.json().messageId as string;
      expect((await call(receiptsRoute, adminA, { messageId })).statusCode).toBe(200);
      await expectNoOracle(receiptsRoute, adminB, { messageId });
      await expectNoOracle(receiptsRoute, outsider, { messageId });
    });
    it("org B admin cannot create a department channel for A's location or A's role", async () => {
      const provider = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'CCN-WP29','WP29 Provider','NPI-WP29','\\x00','12-31') RETURNING id`,
          [orgA],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
             VALUES ($1,'WP29 Loc','1 St','Town','OR','97000','America/Los_Angeles','active') RETURNING id`,
          [provider],
        )
      ).rows[0].id as string;
      const role = (
        await admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'wp29-role','WP29 Role','clinical_staff',true) RETURNING id`,
          [orgA],
        )
      ).rows[0].id as string;
      attackers.add(adminB.name);
      const before = await fingerprint();
      for (const [kind, subjectId] of [
        ["location", location],
        ["discipline", role],
      ] as const) {
        const real = await call(departmentRoute, adminB, {}, { kind, subjectId });
        const ctl = await call(departmentRoute, adminB, {}, { kind, subjectId: randomUUID() });
        expect(real.statusCode, kind).toBe(404);
        expect(shape(real), kind).toBe(shape(ctl));
        expectNoLeak(real.body, adminB, kind);
      }
      // A non-admin of A is refused before any lookup, so a real and a random subject are indistinguishable.
      attackers.add(outsider.name);
      const denied = await call(
        departmentRoute,
        outsider,
        {},
        { kind: "location", subjectId: location },
      );
      const deniedCtl = await call(
        departmentRoute,
        outsider,
        {},
        { kind: "location", subjectId: randomUUID() },
      );
      expect(denied.statusCode).toBe(403);
      expect(shape(denied)).toBe(shape(deniedCtl));
      expect(await fingerprint()).toEqual(before);
      // The owner org can create it (the attacks above are not vacuous).
      const owner = await call(
        departmentRoute,
        adminA,
        {},
        { kind: "location", subjectId: location },
      );
      expect(owner.statusCode).toBe(201);
    });
  });

  describe("announce, notifications, alerts, rules", () => {
    it("an org B admin's announcement lands in B only; a non-admin and a forged org header are refused", async () => {
      const before = await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [
        orgA,
      ]);
      attackers.add(adminB.name);
      const ok = await call("POST /api/v1/messaging/announce", adminB, {}, { body: "from B" });
      expect(ok.statusCode).toBe(201);
      expect(
        await cell(`SELECT count(*)::int AS n FROM channel WHERE id=$1 AND organization_id=$2`, [
          ok.json().channelId,
          orgB,
        ]),
      ).toBe(1);
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [orgA]),
      ).toBe(before);
      attackers.add(outsider.name);
      expect(
        (await call("POST /api/v1/messaging/announce", outsider, {}, { body: "x" })).statusCode,
      ).toBe(403);
      const forged = { ...adminB, org: orgA, name: "adminB-forged-org" };
      attackers.add(forged.name);
      for (const [route, params, payload] of [
        ["POST /api/v1/messaging/announce", {}, { body: "x" }],
        ["GET /api/v1/messaging/channels", {}, undefined],
        ["GET /api/v1/messaging/channels/:id/messages", { id: dmA }, undefined],
      ] as const) {
        const res = await call(route, forged, params, payload);
        expect(res.statusCode, route).toBeGreaterThanOrEqual(400);
      }
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE organization_id=$1`, [orgA]),
      ).toBe(before);
    });
    it("preferences are per user and org; B cannot forward vacation to an A user", async () => {
      attackers.add(bUser.name);
      const res = await call("GET /api/v1/notifications/preferences", bUser);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Pacific/Auckland");
      const body = (to: string) => ({
        routingMap: {},
        quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
        vacationForwardToUserId: to,
        vacationUntil: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const real = await call("PUT /api/v1/notifications/preferences", bUser, {}, body(u1.userId));
      const ctl = await call(
        "PUT /api/v1/notifications/preferences",
        bUser,
        {},
        body(randomUUID()),
      );
      expect(real.statusCode).toBeGreaterThanOrEqual(400);
      expect(shape(real)).toBe(shape(ctl));
    });
    it("endpoints of another user or org are a 404 like a random id", async () => {
      attackers.add("endpoint-attackers");
      await call(
        "POST /api/v1/notifications/endpoints",
        u2,
        {},
        { channel: "email", target: "wp17-u2@x.test" },
      );
      for (const attacker of [bUser, u2]) {
        await expectNoOracle(
          "POST /api/v1/notifications/endpoints/:id/verify",
          attacker,
          { id: endpointA },
          { token: "000000" },
        );
        await expectNoOracle("DELETE /api/v1/notifications/endpoints/:id", attacker, {
          id: endpointA,
        });
      }
    });
    it("alerts: B's inbox is empty of A's, and A's alert id cannot be marked read from B", async () => {
      attackers.add(bUser.name);
      const inbox = await call("GET /api/v1/alerts/inbox", bUser);
      expect(inbox.statusCode).toBe(200);
      expect(inbox.body).not.toContain(A_NAME_TOKEN);
      expect(inbox.body).not.toContain(alertA);
      await expectNoOracle("POST /api/v1/alerts/:id/read", bUser, { id: alertA });
      await expectNoOracle("POST /api/v1/alerts/:id/read", outsider, { id: alertA });
    });
    it("alert rules: B never sees or patches A's override", async () => {
      attackers.add(adminB.name);
      const list = await call("GET /api/v1/alert-rules", adminB);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(ruleA);
      expect(list.body).not.toContain(orgA);
      await expectNoOracle(
        "PATCH /api/v1/alert-rules/:id",
        adminB,
        { id: ruleA },
        { enabled: true },
      );
    });
    it("the platform-ops drill and vendor webhooks refuse a tenant admin / an unsigned call", async () => {
      const probe = buildServer({
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerAdminAlertDeliveriesRoutes(probe, {
        list: async () => [],
        audit: async () => undefined,
      } as never);
      registerMessagingWebhookRoutes(probe, {
        publicBaseUrl: "https://api.chartwarden.test",
        resolveTwilioAuthToken: () => "t",
        service: {
          recordTwilioSmsStatus: async () => {
            throw new Error("must not run");
          },
        },
      } as never);
      try {
        const drill = await probe.inject({
          method: "GET",
          url: "/api/v1/admin/messaging/alert-deliveries",
          headers: headers(adminA),
        });
        expect(drill.statusCode).toBeGreaterThanOrEqual(401);
        expect(drill.statusCode).toBeLessThan(500);
        const hook = await probe.inject({
          method: "POST",
          url: "/webhooks/twilio/sms-status",
          payload: { MessageSid: "SM1", MessageStatus: "delivered" },
        });
        expect(hook.statusCode).toBeGreaterThanOrEqual(400);
        expect(hook.statusCode).toBeLessThan(500);
      } finally {
        await probe.close();
      }
    });
  });

  // ── 4. nothing changed ─────────────────────────────────────────────────────────────────────────────────────
  describe("the attack battery wrote nothing", () => {
    it("re-running every attack leaves each M36 table, audit_event and outbox_event byte-identical", async () => {
      // Freeze the world, replay a cross-section of the denied calls, compare. (The per-test assertions above already
      // proved every one of these is a 4xx; this proves a 4xx did not leave a partial write behind.)
      const before = await fingerprint();
      const replay: Array<[string, Who, Record<string, string>, unknown?]> = [
        ["PATCH /api/v1/messaging/messages/:id", bUser, { id: msgDmA }, { body: "tampered" }],
        ["PATCH /api/v1/messaging/messages/:id", outsider, { id: msgLocA }, { body: "tampered" }],
        ["DELETE /api/v1/messaging/messages/:id", bUser, { id: msgDmA }],
        ["DELETE /api/v1/messaging/messages/:id", outsider, { id: msgLocA }],
        ["POST /api/v1/messaging/messages/:id/read", bUser, { id: msgDmA }, {}],
        ["POST /api/v1/messaging/messages/:id/read", outsider, { id: msgLocA }, { upTo: true }],
        ["POST /api/v1/messaging/channels/:id/messages", bUser, { id: dmA }, { body: "x" }],
        ["GET /api/v1/messaging/attachments/:id/access", bUser, { id: attClean }],
        ["GET /api/v1/messaging/attachments/:id/access", outsider, { id: attClean }],
        ["GET /api/v1/messaging/attachments/:id", outsider, { id: attClean }],
        ["POST /api/v1/messaging/attachments/:id/complete", bUser, { id: attPending }, {}],
        ["POST /api/v1/messaging/attachments/:id/complete", outsider, { id: attPending }, {}],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          outsider,
          { id: locA },
          { body: "x", parentMessageId: msgLocA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          bUser,
          { id: dmB },
          { body: "x", parentMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          bUser,
          { id: dmB },
          { body: "x", quotedMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/messages",
          u1,
          { id: locA },
          { body: "x", quotedMessageId: msgDmA },
        ],
        [
          "POST /api/v1/messaging/channels/:id/members",
          adminB,
          { id: locA },
          { userId: bUser.userId },
        ],
        [
          "POST /api/v1/messaging/channels/:id/members",
          adminA,
          { id: locA },
          { userId: bUser.userId },
        ],
        [
          "DELETE /api/v1/messaging/channels/:id/members/:userId",
          adminB,
          { id: locA, userId: u1.userId },
        ],
        ["GET /api/v1/messaging/channels/:id/members", adminB, { id: locA }],
        ["POST /api/v1/messaging/channels/:id/archive", adminB, { id: locA }],
        ["POST /api/v1/messaging/channels/:id/unarchive", adminB, { id: locA }],
        ["POST /api/v1/messaging/announce", outsider, {}, { body: "x" }],
        ["POST /api/v1/messaging/dm", bUser, {}, { userId: u1.userId }],
        [
          "POST /api/v1/notifications/endpoints/:id/verify",
          bUser,
          { id: endpointA },
          { token: "000000" },
        ],
        ["DELETE /api/v1/notifications/endpoints/:id", bUser, { id: endpointA }],
        [
          "PUT /api/v1/messaging/channels/:id/draft",
          bUser,
          { id: dmA },
          { body: "x", deviceId: "d", baseRevision: 0 },
        ],
        ["POST /api/v1/alerts/:id/read", bUser, { id: alertA }],
        ["PATCH /api/v1/alert-rules/:id", adminB, { id: ruleA }, { enabled: true }],
        ["GET /api/v1/messaging/channels/:id/members", adminB, { id: locA }],
        ["POST /api/v1/messaging/channels/:id/archive", adminB, { id: locA }],
        ["POST /api/v1/messaging/channels/:id/unarchive", adminB, { id: locA }],
      ];
      for (const [route, who, params, payload] of replay) {
        const res = await call(route, who, params, payload);
        expect(res.statusCode, `${who.name} ${route}`).toBeGreaterThanOrEqual(400);
      }
      expect(await fingerprint()).toEqual(before);
    });
  });

  // ── coverage: every route was driven by an attacker (idor) or by two orgs (scoped) ─────────────────────────
  describe("route coverage", () => {
    it("every idor route was attacked and every scoped route exercised in this run", () => {
      const missing = Object.entries(ROUTES)
        .filter(([route, v]) =>
          v.kind === "idor"
            ? !exercisedByAttacker.has(route)
            : v.kind === "scoped"
              ? !exercised.has(route)
              : false,
        )
        .map(([route]) => route);
      expect(missing).toEqual([]);
    });
  });

  // ── 5. RLS at the database, as the app role ────────────────────────────────────────────────────────────────
  describe("RLS as the real chartwarden_app role with app.org_id = B", () => {
    async function asOrgB<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    }
    it("connects as a non-superuser, non-BYPASSRLS role", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      const r = await c.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      await c.end();
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
    const orgScoped = [
      "channel",
      "channel_member",
      "message",
      "message_revision",
      "message_receipt",
      "message_reaction",
      "message_pin",
    ];
    it.each(orgScoped)(
      "SELECT on %s returns no org A rows (and the table is non-empty for A)",
      async (table) => {
        expect(
          await cell(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id=$1`, [orgA]),
        ).toBeGreaterThan(0);
        await asOrgB(async (c) => {
          const a = await c.query(
            `SELECT count(*)::int AS n FROM "${table}" WHERE organization_id=$1`,
            [orgA],
          );
          expect(a.rows[0].n).toBe(0);
          const all = await c.query(`SELECT DISTINCT organization_id FROM "${table}"`);
          expect(all.rows.every((r) => r.organization_id === orgB)).toBe(true);
        });
      },
    );
    it("message_attachment is unreadable for org A's message", async () => {
      expect(await cell(`SELECT count(*)::int AS n FROM message_attachment`)).toBeGreaterThan(0);
      await asOrgB(async (c) => {
        expect((await c.query("SELECT count(*)::int AS n FROM message_attachment")).rows[0].n).toBe(
          0,
        );
      });
    });
    it("with no org context at all nothing is readable", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        for (const t of [...orgScoped, "message_attachment"]) {
          expect((await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n, t).toBe(0);
        }
      } finally {
        await c.end();
      }
    });
    it("INSERT carrying org A's organization_id is rejected by WITH CHECK", async () => {
      const inserts: Array<[string, string, () => unknown[]]> = [
        [
          "message",
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',repeat('a',64))`,
          () => [dmA, orgA, u1.userId],
        ],
        [
          "channel",
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class) VALUES ($1,'announcement','x','operational')`,
          () => [orgA],
        ],
        [
          "channel_member",
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          () => [orgA, dmA, outsider.userId],
        ],
        [
          "message_receipt",
          `INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)`,
          () => [orgA, msgLocA, outsider.userId],
        ],
        [
          "message_revision",
          `INSERT INTO message_revision (organization_id, message_id, revision_no, body_cipher, body_sha256, body_kind, body_written_at, edited_by)
           VALUES ($1,$2,99,'\\x00',repeat('a',64),'plain',now(),$3)`,
          () => [orgA, msgDmA, u1.userId],
        ],
        [
          "message_attachment",
          `INSERT INTO message_attachment (organization_id, channel_id, uploaded_by, mime_type, byte_size, filename) VALUES ($1,$2,$3,'a/b',1,'x')`,
          () => [orgA, dmA, u1.userId],
        ],
      ];
      for (const [table, sql, args] of inserts) {
        await asOrgB(async (c) => {
          // 1075: message_attachment carries organization_id, so RLS itself refuses it like every other table.
          await expect(c.query(sql, args()), table).rejects.toThrow(/row-level security/i);
        });
      }
      expect(
        await cell(`SELECT count(*)::int AS n FROM message WHERE body_sha256 = repeat('a',64)`),
      ).toBe(0);
    });
    it("composite FKs: an org B row cannot point at an org A channel or message (FK checks bypass RLS)", async () => {
      const insMsg = `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, parent_message_id, quoted_message_id)
                      VALUES ($1,$2,$3,'user','\\x00',repeat('a',64),$4,$5)`;
      const cases: Array<[string, string, unknown[]]> = [
        ["message.channel_id -> org A channel", insMsg, [dmA, orgB, bUser.userId, null, null]],
        [
          "message.parent_message_id -> org A message",
          insMsg,
          [dmB, orgB, bUser.userId, msgDmA, null],
        ],
        [
          "message.quoted_message_id -> org A message",
          insMsg,
          [dmB, orgB, bUser.userId, null, msgDmA],
        ],
        [
          "channel_member.channel_id -> org A channel",
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [orgB, dmA, bUser.userId],
        ],
        [
          "message_receipt.message_id -> org A message",
          `INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)`,
          [orgB, msgDmA, bUser.userId],
        ],
      ];
      for (const [label, sql, args] of cases) {
        await asOrgB(async (c) => {
          await expect(c.query(sql, args), label).rejects.toThrow(
            /violates foreign key constraint/i,
          );
        });
      }
      // positive control: the same message insert against org B's own channel is accepted
      await asOrgB(async (c) => {
        const ok = await c.query(insMsg, [dmB, orgB, bUser.userId, null, null]);
        expect(ok.rowCount).toBe(1);
      });
    });
    it("WP 2.2 / D6: the database itself refuses a parent or quote in another channel (direct INSERT/UPDATE, app role and superuser)", async () => {
      const insMsg = `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, parent_message_id, quoted_message_id)
                      VALUES ($1,$2,$3,'user','\\x00',repeat('b',64),$4,$5) RETURNING id`;
      const sameChannelFk = /violates foreign key constraint "message_(parent|quoted)_channel_fk"/i;
      // msgDmA lives in dmA; locA is another channel of the SAME org, dmB belongs to org B.
      const cases: Array<[string, unknown[], RegExp]> = [
        ["cross-channel parent", [locA, orgA, u1.userId, msgDmA, null], sameChannelFk],
        ["cross-channel quote", [locA, orgA, u1.userId, null, msgDmA], sameChannelFk],
        ["cross-org parent", [dmB, orgB, bUser.userId, msgDmA, null], sameChannelFk],
        ["cross-org quote", [dmB, orgB, bUser.userId, null, msgDmA], sameChannelFk],
      ];
      const asOrg = async <T>(org: string, fn: (c: Client) => Promise<T>): Promise<T> => {
        const c = new Client({ connectionString: appUrl });
        await c.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
          return await fn(c);
        } finally {
          await c.query("ROLLBACK").catch(() => undefined);
          await c.end();
        }
      };
      for (const [label, args, re] of cases) {
        await asOrg(args[1] as string, async (c) => {
          await expect(c.query(insMsg, args), `app role: ${label}`).rejects.toThrow(re);
        });
        // the superuser bypasses RLS, not constraints
        await admin.query("BEGIN");
        try {
          await expect(admin.query(insMsg, args), `superuser: ${label}`).rejects.toThrow(re);
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      // an UPDATE that moves an existing reply's parent to another channel is refused too
      await asOrg(orgA, async (c) => {
        const ok = await c.query(insMsg, [dmA, orgA, u1.userId, msgDmA, msgDmA]);
        expect(ok.rowCount, "positive control: same-channel parent and quote").toBe(1);
        await expect(
          c.query("UPDATE message SET parent_message_id = $1 WHERE id = $2", [
            msgLocA,
            ok.rows[0].id,
          ]),
        ).rejects.toThrow(sameChannelFk);
      });
      // and moving the REPLY to another channel while keeping its parent is refused
      await asOrg(orgA, async (c) => {
        const ok = await c.query(insMsg, [dmA, orgA, u1.userId, msgDmA, null]);
        await expect(
          c.query("UPDATE message SET channel_id = $1 WHERE id = $2", [locA, ok.rows[0].id]),
        ).rejects.toThrow(sameChannelFk);
      });
    });
    it("channel_member.last_read_message_id: a cross-tenant pointer is refused; erasing the message only nulls the pointer", async () => {
      const upd = `UPDATE channel_member SET last_read_message_id = $1
                   WHERE organization_id = $2 AND channel_id = $3 AND user_id = $4`;
      await asOrgB(async (c) => {
        await expect(c.query(upd, [msgDmA, orgB, dmB, bUser.userId])).rejects.toThrow(
          /violates foreign key constraint/i,
        );
      });
      // SET NULL: point u1's membership at a throwaway org A message, erase it, the member row survives
      const mid = (
        await admin.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
           VALUES ($1,$2,$3,'user','\\x00',repeat('b',64)) RETURNING id`,
          [dmA, orgA, u1.userId],
        )
      ).rows[0].id as string;
      await admin.query(upd, [mid, orgA, dmA, u1.userId]);
      expect(
        await cell(
          `SELECT count(*)::int AS n FROM channel_member WHERE last_read_message_id = $1`,
          [mid],
        ),
      ).toBe(1);
      await admin.query(`DELETE FROM message WHERE id = $1`, [mid]);
      expect(
        await cell(
          `SELECT count(*)::int AS n FROM channel_member
            WHERE organization_id = $1 AND channel_id = $2 AND user_id = $3 AND last_read_message_id IS NULL`,
          [orgA, dmA, u1.userId],
        ),
      ).toBe(1);
    });
    it("UPDATE / DELETE of org A rows touches zero rows; moving a B row into org A is rejected", async () => {
      await asOrgB(async (c) => {
        const upd = await c.query(
          `UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE organization_id=$1 OR id=$2`,
          [orgA, msgDmA],
        );
        expect(upd.rowCount).toBe(0);
        expect((await c.query(`UPDATE channel SET title='pwn' WHERE id=$1`, [dmA])).rowCount).toBe(
          0,
        );
        expect(
          (await c.query(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1`, [locA]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await c.query(
              `UPDATE message_receipt SET status='read', read_at=now() WHERE message_id=$1`,
              [msgDmA],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await c.query(`DELETE FROM channel_member WHERE channel_id=$1`, [locA])).rowCount,
        ).toBe(0);
      });
      // 1075: the app role has no DELETE on message_attachment at all (stronger than zero rows under RLS).
      await asOrgB(async (c) => {
        await expect(
          c.query(`DELETE FROM message_attachment WHERE message_id=$1`, [msgDmA]),
        ).rejects.toThrow(/permission denied/i);
      });
      await asOrgB(async (c) => {
        await expect(
          c.query(`UPDATE channel SET organization_id=$1 WHERE id=$2`, [orgA, dmB]),
        ).rejects.toThrow(/row-level security/i);
      });
      expect(
        await cell(`SELECT count(*)::int AS n FROM channel WHERE id=$1 AND organization_id=$2`, [
          dmB,
          orgB,
        ]),
      ).toBe(1);
    });
  });
});

// ── 6. sockets ───────────────────────────────────────────────────────────────────────────────────────────────
// Needs Postgres (real service) and Valkey. The gateway is the real one; authentication is a token table and the room
// set is the production `resolveRooms` body (computeRoomSet over the real `listChannels`).
describe.skipIf(!DB_URL || !REDIS_URL)(
  "M36 WP 1.7 realtime: no cross-tenant or non-member hint",
  () => {
    // The Postgres fixture is rebuilt here so this block is independent of the HTTP block above.
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let service: ReturnType<typeof createDbMessagingRouteService>;
    const redis: Redis[] = [];
    const clients: Socket[] = [];
    let httpServer: Server;
    let realtime: RealtimeHandle;
    let url: string;
    let orgA: string;
    let orgB: string;
    let member: string;
    let peer: string;
    let nonMember: string;
    let foreign: string;
    let privateA: string;
    let privateMsg: string;

    const newRedis = () => {
      const r = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
      r.on("error", () => {});
      redis.push(r);
      return r;
    };
    const readyEmitter = async () => {
      const r = newRedis();
      await new Promise<void>((res) =>
        r.status === "ready" ? res() : r.once("ready", () => res()),
      );
      return createRealtimeEmitter(r);
    };
    const open = (token: string) => {
      const s = connect(url, {
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: { cookie: `better-auth.session_token=${token}`, origin: ORIGIN },
      });
      clients.push(s);
      return s;
    };
    const connected = (s: Socket) =>
      new Promise<void>((res, rej) => {
        s.once("connect", () => res());
        s.once("connect_error", (e) => rej(e));
      });
    /** Every hint a socket receives within `ms`. */
    const hintsWithin = (s: Socket, ms: number) =>
      new Promise<unknown[]>((res) => {
        const got: unknown[] = [];
        const on = (h: unknown) => got.push(h);
        s.on("hint", on);
        setTimeout(() => {
          s.off("hint", on);
          res(got);
        }, ms);
      });

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (process.env.CHARTWARDEN_TEST_NO_PGVECTOR) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
      const org = async (slug: string) =>
        (
          await admin.query(
            `INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,$1,$1) RETURNING id`,
            [slug],
          )
        ).rows[0].id as string;
      orgA = await org("wp17s-a");
      orgB = await org("wp17s-b");
      const user = async (n: string, o: string) => {
        const id = (
          await admin.query(`INSERT INTO "user" (email,name) VALUES ($1,$1) RETURNING id`, [
            `wp17s-${n}@x.test`,
          ])
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
          [id, o],
        );
        return id;
      };
      member = await user("member", orgA);
      peer = await user("peer", orgA);
      nonMember = await user("nonmember", orgA);
      foreign = await user("foreign", orgB);
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
      service = createDbMessagingRouteService(handle.db, {
        kek: KEK,
        outbox: {
          publish: (tx: unknown, e: Record<string, unknown>) =>
            publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
        } as never,
      });
      privateA = (await service.openDm(orgA, member, peer)).channelId;
      privateMsg = (
        await service.sendMessage(orgA, {
          channelId: privateA,
          authorUserId: member,
          body: "hello",
        })
      ).messageId;

      const principals: Record<string, RealtimePrincipal> = {
        tok_member: { userId: member, organizationId: orgA, sessionId: "s1" },
        tok_nonmember: { userId: nonMember, organizationId: orgA, sessionId: "s2" },
        tok_foreign: { userId: foreign, organizationId: orgB, sessionId: "s3" },
      };
      httpServer = createServer();
      const pub = newRedis();
      const sub = pub.duplicate();
      sub.on("error", () => {});
      redis.push(sub);
      realtime = startRealtimeServer({
        httpServer,
        pubClient: pub,
        subClient: sub,
        trustedOrigins: [ORIGIN],
        recheckIntervalMs: 60_000,
        authenticate: async (h) =>
          principals[/session_token=([^;]+)/.exec(h.cookie ?? "")?.[1] ?? ""] ?? null,
        // the production resolveRooms body (apps/backend/src/index.ts)
        resolveRooms: async ({ organizationId, userId }) =>
          computeRoomSet({
            userId,
            orgId: organizationId,
            channels: (await service.listChannels(organizationId, userId)).map((c) => ({
              channelId: c.channelId,
              kind: c.kind,
              subjectId: c.subjectId,
            })),
          }),
        stillValid: async () => true,
      });
      await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    }, 240_000);

    afterAll(async () => {
      for (const c of clients) c.close();
      await realtime?.close();
      httpServer?.close();
      for (const r of redis) r.disconnect();
      await handle?.close();
      await admin?.end();
    });

    it("a committed message in a private channel hints its members only: not a non-member, not another org", async () => {
      const [m, nm, f] = [open("tok_member"), open("tok_nonmember"), open("tok_foreign")];
      await Promise.all([connected(m), connected(nm), connected(f)]);
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const consumer = buildM36MessageHintConsumer({
        audience: (o, c) => channelHintAudience(handle.db, o, c),
        emitToRooms: (rooms, hint) => emitter.emit(rooms, "hint", hint),
      });
      const event = (organizationId: string, channelId: string) => ({
        id: randomUUID(),
        organizationId,
        eventType: "m36.message.sent",
        aggregateKind: "message",
        aggregateId: privateMsg,
        payload: { organizationId, channelId, messageId: privateMsg, at: new Date().toISOString() },
        attemptCount: 0,
        createdAt: new Date(),
      });
      const heard = [hintsWithin(m, 1200), hintsWithin(nm, 1200), hintsWithin(f, 1200)];
      await consumer.handle(event(orgA, privateA));
      // a forged envelope: org B's tenant with org A's channel id - RLS makes the audience empty, nothing is emitted
      await consumer.handle(event(orgB, privateA));
      const [forMember, forNonMember, forForeign] = await Promise.all(heard);
      expect(forMember).toHaveLength(1);
      expect(forMember![0]).toMatchObject({ ids: { channelId: privateA, messageId: privateMsg } });
      expect(forNonMember).toEqual([]);
      expect(forForeign).toEqual([]);
    });

    it("a client cannot choose a room: join / subscribe / channel names from the client deliver nothing", async () => {
      const nm = open("tok_nonmember");
      const f = open("tok_foreign");
      await Promise.all([connected(nm), connected(f)]);
      const targets = [
        `user:${orgA}:${member}`,
        `channel:${privateA}`,
        privateA,
        `account:${member}`,
      ];
      for (const s of [nm, f]) {
        for (const evt of ["join", "subscribe", "join_room", "channel.subscribe"]) {
          for (const t of targets) s.emit(evt, t);
          s.emit(evt, { room: targets[0], channelId: privateA });
        }
      }
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const heard = [hintsWithin(nm, 1000), hintsWithin(f, 1000)];
      await emitter.emit(targets, "hint", {
        kind: "message.new",
        cursor: "c",
        ids: { channelId: privateA },
      });
      expect(await Promise.all(heard)).toEqual([[], []]);
    });

    it("an announcement hint goes to the sender's org room only", async () => {
      const nm = open("tok_nonmember");
      const f = open("tok_foreign");
      await Promise.all([connected(nm), connected(f)]);
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await readyEmitter();
      const heard = [hintsWithin(nm, 1000), hintsWithin(f, 1000)];
      await emitter.emit([`org:${orgA}`], "hint", { kind: "message.new", cursor: "c", ids: {} });
      const [forA, forB] = await Promise.all(heard);
      expect(forA).toHaveLength(1);
      expect(forB).toEqual([]);
    });
  },
);
