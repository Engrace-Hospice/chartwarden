// apps/backend/src/modules/29-external-interfaces/routes/feed.routes.ts — §4.1.1 feed + credential admin.
//
// The operator / compliance-officer feed-onboarding surface. Feed creation stamps the proposing operator;
// activation demands a DISTINCT compliance co-approver (D18) AND the M40 BAA gate (D16, the
// `external_feed_baa_satisfied` predicate); revocation is dual-approval (D20). A minted channel credential's
// plaintext never lands in the clear or comes back on the wire.
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { assertHostAcceptable, assertProtocolAcceptable, resolveCertPin } from "./feed-input";
import {
  ABAC_FEED_BAA,
  ABAC_FEED_CO_APPROVER,
  ABAC_FEED_ORG,
  ABAC_IN_ORG,
  P,
  STEP_UP,
} from "./guards";
import {
  CreateFeedBody,
  FeedListQuery,
  MintCredentialBody,
  RevokeFeedBody,
  SuspendFeedBody,
  UpdateFeedBody,
  parse,
  parseQuery,
} from "./m29-typebox";
import type { M29Store } from "./store";
import { FEED_CONFIG_NO_PHI, FEED_CREDENTIAL_NO_PHI, FEED_HEALTH_NO_PHI } from "./read-audit-configs";

export interface FeedRouteDeps {
  readonly store: M29Store;
  /** Environment the F-181 production policy reads (defaults to `process.env`; injectable for tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function registerFeedRoutes(app: FastifyInstance, deps: FeedRouteDeps): void {
  const { store } = deps;
  const envOf = (): Readonly<Record<string, string | undefined>> => deps.env ?? process.env;

  // GET /feeds — list the org's feeds.
  app.get(
    "/api/admin/external-interfaces/feeds",
    {
      config: { auditRead: FEED_CONFIG_NO_PHI },
      preHandler: [
        P("external_interfaces.feed.read"),
        ABAC_IN_ORG("external_interfaces.feed.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(FeedListQuery, request.query);
      return store.listFeeds(actor.organizationId, {
        kind: q.kind,
        status: q.status,
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /feeds/:feedId — single feed detail (redacted credential metadata only, NEVER ciphertext).
  app.get(
    "/api/admin/external-interfaces/feeds/:feedId",
    {
      config: { auditRead: FEED_CONFIG_NO_PHI },
      preHandler: [
        P("external_interfaces.feed.read"),
        ABAC_FEED_ORG("external_interfaces.feed.read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { feedId } = request.params as { feedId: string };
      const feed = await store.getFeed(actor.organizationId, feedId);
      if (!feed) throw new NotFoundError("feed");
      return { feed };
    },
  );

  // POST /feeds — create a feed (pending_approval; step-up D18).
  app.post(
    "/api/admin/external-interfaces/feeds",
    {
      preHandler: [
        P("external_interfaces.feed.create"),
        STEP_UP("external_interfaces.feed.create"),
        ABAC_IN_ORG("external_interfaces.feed.create"),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { channelCertPem, ...parsed } = parse(CreateFeedBody, request.body);
      const channelCertPin = resolveCertPin({
        channelCertPin: parsed.channelCertPin,
        channelCertPem,
      });
      assertProtocolAcceptable(parsed, envOf());
      assertHostAcceptable(parsed.host, envOf());
      const body = channelCertPin === undefined ? parsed : { ...parsed, channelCertPin };
      const feed = await store.createFeed(actor.organizationId, actor.membershipId, body);
      return reply.code(201).send({ feed });
    },
  );

  // PATCH /feeds/:feedId — edit non-credential metadata (step-up D18).
  app.patch(
    "/api/admin/external-interfaces/feeds/:feedId",
    {
      preHandler: [
        P("external_interfaces.feed.update"),
        STEP_UP("external_interfaces.feed.update"),
        ABAC_FEED_ORG("external_interfaces.feed.update"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { feedId } = request.params as { feedId: string };
      const { channelCertPem, ...parsed } = parse(UpdateFeedBody, request.body);
      const channelCertPin = resolveCertPin({
        channelCertPin: parsed.channelCertPin,
        channelCertPem,
      });
      assertHostAcceptable(parsed.host, envOf());
      const body = channelCertPin === undefined ? parsed : { ...parsed, channelCertPin };
      const feed = await store.updateFeed(actor.organizationId, actor.membershipId, feedId, body);
      return { feed };
    },
  );

  // POST /feeds/:feedId/activate — pending_approval → active (distinct co-approver + BAA gate).
  app.post(
    "/api/admin/external-interfaces/feeds/:feedId/activate",
    {
      preHandler: [
        P("external_interfaces.feed.activate"),
        STEP_UP("external_interfaces.feed.activate"),
        ABAC_FEED_ORG("external_interfaces.feed.activate"),
        ABAC_FEED_BAA("external_interfaces.feed.activate"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { feedId } = request.params as { feedId: string };
      // F-181 — a feed created before this deployment became production must not be activatable as cleartext.
      const existing = await store.getFeed(actor.organizationId, feedId);
      if (existing) {
        assertProtocolAcceptable(existing, envOf());
        assertHostAcceptable(existing.host ?? undefined, envOf());
      }
      const feed = await store.activateFeed(actor.organizationId, actor.membershipId, feedId);
      return { feed };
    },
  );

  // POST /feeds/:feedId/suspend — active → suspended (reason required).
  app.post(
    "/api/admin/external-interfaces/feeds/:feedId/suspend",
    {
      preHandler: [
        P("external_interfaces.feed.suspend"),
        STEP_UP("external_interfaces.feed.suspend"),
        ABAC_FEED_ORG("external_interfaces.feed.suspend"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { feedId } = request.params as { feedId: string };
      const body = parse(SuspendFeedBody, request.body);
      const feed = await store.suspendFeed(
        actor.organizationId,
        actor.membershipId,
        feedId,
        body.reason,
      );
      return { feed };
    },
  );

  // POST /feeds/:feedId/revoke — terminal revoke (dual-approval, D20).
  app.post(
    "/api/admin/external-interfaces/feeds/:feedId/revoke",
    {
      preHandler: [
        P("external_interfaces.feed.revoke"),
        STEP_UP("external_interfaces.feed.revoke"),
        ABAC_FEED_ORG("external_interfaces.feed.revoke"),
        ABAC_FEED_CO_APPROVER("external_interfaces.feed.revoke"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { feedId } = request.params as { feedId: string };
      const body = parse(RevokeFeedBody, request.body);
      const feed = await store.revokeFeed(actor.organizationId, actor.membershipId, feedId, {
        reason: body.reason,
      });
      // GAP-153 — the first approval only records the request; the revoke completes on a distinct second approval.
      return { feed, revokePending: feed.status !== "revoked" };
    },
  );

  // POST /feeds/:feedId/credentials — mint / rotate a channel credential (step-up D18).
  app.post(
    "/api/admin/external-interfaces/feeds/:feedId/credentials",
    {
      preHandler: [
        P("external_interfaces.credential.rotate"),
        STEP_UP("external_interfaces.credential.rotate"),
        ABAC_FEED_ORG("external_interfaces.credential.rotate"),
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { feedId } = request.params as { feedId: string };
      const body = parse(MintCredentialBody, request.body);
      const credential = await store.mintCredential(
        actor.organizationId,
        actor.membershipId,
        feedId,
        body,
      );
      return reply.code(201).send({ credential });
    },
  );

  // GET /feeds/:feedId/credentials — list credential metadata (never ciphertext).
  app.get(
    "/api/admin/external-interfaces/feeds/:feedId/credentials",
    {
      config: { auditRead: FEED_CREDENTIAL_NO_PHI },
      preHandler: [
        P("external_interfaces.credential.read"),
        ABAC_FEED_ORG("external_interfaces.credential.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { feedId } = request.params as { feedId: string };
      return { credentials: await store.listCredentials(actor.organizationId, feedId) };
    },
  );

  // GET /feeds/:feedId/health — current rolling health snapshot.
  app.get(
    "/api/admin/external-interfaces/feeds/:feedId/health",
    {
      config: { auditRead: FEED_HEALTH_NO_PHI },
      preHandler: [
        P("external_interfaces.feed.read"),
        ABAC_FEED_ORG("external_interfaces.feed.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { feedId } = request.params as { feedId: string };
      return { health: await store.getFeedHealth(actor.organizationId, feedId) };
    },
  );
}
